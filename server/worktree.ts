// Ações do worktree de um agente: abrir PR, trazer o trabalho para a branch da sala e
// encerrar o worktree. Cada uma confere o estado de novo antes de mexer em algo.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { Agent, Room, WorktreeStatus } from '../shared/types.ts';
import { canDeleteBranch, prSuggestion } from '../shared/worktree.ts';
import { git, ok } from './git.ts';
import { ghBin, ptyCommand } from './platform.ts';

const exec = promisify(execFile);

export class WorktreeError extends Error {}

/** Branch em que a pasta da sala está; undefined com HEAD solto. */
async function roomBranch(repo: string): Promise<string | undefined> {
  const b = await ok(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return b || undefined;
}

/**
 * Prevê o merge sem tocar em nada (`git merge-tree`, git 2.38+): lista os arquivos com conflito,
 * vazia se entra limpo, undefined se o git não sabe prever.
 */
export async function predictConflicts(repo: string, target: string, branch: string): Promise<string[] | undefined> {
  try {
    await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, branch]);
    return [];
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    if (e.code !== 1 || !e.stdout) return undefined;
    // Primeira linha: a árvore resultante; depois, um arquivo com conflito por linha.
    return [...new Set(e.stdout.split('\n').slice(1).filter(Boolean))];
  }
}

export async function worktreeStatus(agent: Agent, room: Room): Promise<WorktreeStatus> {
  const branch = agent.worktreeBranch;
  if (!branch) throw new WorktreeError('Este agente não trabalha num worktree');
  const repo = room.path;
  const target = await roomBranch(repo);
  const count = async (range: string) => Number((await ok(repo, ['rev-list', '--count', range])) ?? 0);
  const [ahead, behind, dirty, remote, local, upstream, log] = await Promise.all([
    target ? count(`${target}..${branch}`) : 0,
    target ? count(`${branch}..${target}`) : 0,
    fs.existsSync(agent.cwd) ? ok(agent.cwd, ['status', '--porcelain']).then((s) => (s ? s.split('\n').length : 0)) : 0,
    ok(repo, ['remote', 'get-url', 'origin']),
    ok(repo, ['rev-parse', '--verify', '--quiet', branch]),
    ok(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]),
    target ? ok(repo, ['log', '--reverse', '--pretty=format:%s%x1f%b%x1e', `${target}..${branch}`]) : undefined,
  ]);
  const commits = (log ?? '')
    .split('\x1e')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [subject, body = ''] = c.split('\x1f');
      return { subject, body };
    });
  return {
    branch,
    target,
    ahead,
    behind,
    dirty,
    conflicts: target && ahead ? await predictConflicts(repo, target, branch) : [],
    remote: !!remote,
    pushed: !!upstream && upstream === local,
    pr: agent.worktreePr,
    suggestion: prSuggestion(commits, branch),
  };
}

/** Merge da branch do worktree na branch em que a sala está. Com conflito previsto, não começa. */
export async function mergeWorktree(agent: Agent, room: Room): Promise<{ target: string }> {
  const st = await worktreeStatus(agent, room);
  if (!st.target) throw new WorktreeError('A pasta da sala não está numa branch (HEAD solto)');
  if (!st.ahead) throw new WorktreeError(`Nada para trazer: ${st.target} já tem todos os commits de ${st.branch}`);
  if (st.conflicts?.length) throw new WorktreeError(`Daria conflito em: ${st.conflicts.join(', ')}. Resolva no worktree (por exemplo, pedindo ao agente um merge de ${st.target}) e tente de novo.`);
  try {
    await git(room.path, ['merge', '--no-edit', st.branch]);
  } catch (err) {
    // Sem previsão (git antigo), o merge pode parar no meio: volta como estava.
    if (await ok(room.path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])) await ok(room.path, ['merge', '--abort']);
    throw new WorktreeError(`O merge não foi feito: ${gitMessage(err)}`);
  }
  return { target: st.target };
}

/** Sobe a branch para o `origin` e abre o PR com o GitHub CLI. Com PR já aberto, só sobe os commits novos. */
export async function openPr(agent: Agent, room: Room, title: string, body: string): Promise<{ url: string }> {
  const st = await worktreeStatus(agent, room);
  if (!st.remote) throw new WorktreeError('O repositório não tem o remoto "origin" para onde subir a branch');
  if (!agent.worktreePr && !title.trim()) throw new WorktreeError('Dê um título ao PR');
  try {
    await git(agent.cwd, ['push', '--set-upstream', 'origin', st.branch]);
  } catch (err) {
    throw new WorktreeError(`Não foi possível subir a branch: ${gitMessage(err)}`);
  }
  if (agent.worktreePr) return { url: agent.worktreePr };

  const gh = ghBin();
  if (!gh) throw new WorktreeError('A branch subiu, mas o GitHub CLI (gh) não está instalado. Instale-o e rode "gh auth login", ou abra o PR pelo site.');
  const base = await prBase(room.path, st.target);
  const args = ['pr', 'create', '--head', st.branch, '--title', title.trim(), '--body', body, ...(base ? ['--base', base] : [])];
  const cmd = ptyCommand(gh, args);
  try {
    const { stdout } = await exec(cmd.file, cmd.args, {
      cwd: agent.cwd,
      windowsHide: true,
      timeout: 120_000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    const url = lastUrl(stdout);
    if (!url) throw new WorktreeError(`O gh não devolveu o endereço do PR: ${stdout.trim()}`);
    return { url };
  } catch (err) {
    if (err instanceof WorktreeError) throw err;
    // "a pull request for branch ... already exists: <url>"
    const existing = /already exists/i.test(gitMessage(err)) ? lastUrl(gitMessage(err)) : undefined;
    if (existing) return { url: existing };
    throw new WorktreeError(`A branch subiu, mas o PR não foi aberto: ${gitMessage(err)}`);
  }
}

/** Base do PR: a branch da sala se ela existe no origin; senão, a branch padrão do origin. */
async function prBase(repo: string, target?: string): Promise<string | undefined> {
  if (target && (await ok(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}`]))) return target;
  return (await ok(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.replace(/^origin\//, '');
}

/**
 * Remove a pasta do worktree e, se pedido, a branch. A branch só é apagada se o trabalho
 * dela já está na branch da sala ou no origin: nada some sem ter outra cópia.
 */
export async function removeWorktree(agent: Agent, room: Room, deleteBranch: boolean, stop: () => Promise<void>) {
  const st = await worktreeStatus(agent, room);
  if (st.dirty) throw new WorktreeError(`O worktree tem ${st.dirty} arquivo(s) não commitado(s). Commite ou descarte antes de encerrar.`);
  if (deleteBranch && !canDeleteBranch(st)) throw new WorktreeError(`A branch tem commits que não estão em ${st.target ?? 'a sala'} nem no origin; ela não foi apagada`);
  // A sessão roda dentro da pasta: no Windows, a pasta não sai enquanto o processo existir.
  await stop();
  try {
    if (fs.existsSync(agent.cwd)) await git(room.path, ['worktree', 'remove', agent.cwd]);
    else await git(room.path, ['worktree', 'prune']);
    if (deleteBranch) await git(room.path, ['branch', '-D', st.branch]);
  } catch (err) {
    throw new WorktreeError(`Não foi possível encerrar o worktree: ${gitMessage(err)}`);
  }
}

function gitMessage(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).split('\n').slice(-6).join(' ');
}

function lastUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/g)?.pop();
}
