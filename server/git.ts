import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DiffScope, FileChange, FileDiff, GitInfo } from '../shared/types.ts';

const exec = promisify(execFile);

/** Árvore vazia do git: base para comparar um repositório que ainda não tem commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF = 2 * 1024 * 1024;

export async function git(cwd: string, args: string[]): Promise<string> {
  // quotePath=false: caminhos com acento vêm como texto, não como "\303\241".
  const { stdout } = await exec('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], {
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    // Nunca abre prompt de senha: sem credencial, o push falha com mensagem em vez de travar.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

export async function ok(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await git(cwd, args)).trim();
  } catch {
    return undefined;
  }
}

export async function gitInfo(cwd: string): Promise<GitInfo> {
  if ((await ok(cwd, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return { isRepo: false };

  const hasHead = !!(await ok(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']));
  const [status, log, worktrees, working] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '--branch', '-uall', '--no-renames']),
    git(cwd, ['log', '-8', '--pretty=format:%h%x1f%s%x1f%cr']).catch(() => ''),
    git(cwd, ['worktree', 'list', '--porcelain']).catch(() => ''),
    hasHead ? numstat(cwd, ['HEAD']) : numstat(cwd, [EMPTY_TREE]),
  ]);

  const lines = status.split('\n').filter(Boolean);
  const head = lines.shift() ?? '';
  // "## main...origin/main [ahead 1, behind 2]" ou "## No commits yet on main"
  const branch = head.replace(/^## (No commits yet on )?/, '').split('...')[0].split(' ')[0];
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);

  const files: FileChange[] = [];
  for (const l of lines) {
    const code = l.slice(0, 2);
    const file = unquote(l.slice(3));
    const status = code === '??' ? '??' : code.includes('U') ? 'U' : (code[1] !== ' ' ? code[1] : code[0]);
    const counts = code === '??' ? countUntracked(path.join(cwd, file)) : working.get(file);
    files.push({ path: file, status, ...counts });
  }

  const info: GitInfo = {
    isRepo: true,
    branch,
    ahead,
    behind,
    files,
    commits: log
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, subject, when] = l.split('\x1f');
        return { hash, subject, when };
      }),
    worktrees: parseWorktrees(worktrees),
  };

  const range = hasHead ? await branchRange(cwd, branch) : undefined;
  if (range) {
    info.base = range.base;
    info.branchCommits = Number((await ok(cwd, ['rev-list', '--count', `${range.from}..HEAD`])) ?? 0);
    info.branchFiles = await changedBetween(cwd, range.from, 'HEAD');
  }
  return info;
}

/**
 * De onde a branch atual saiu: a branch padrão do repositório (origin/HEAD, ou main/master).
 * Undefined se já estamos nela ou se não há uma base.
 */
async function branchRange(cwd: string, branch: string): Promise<{ base: string; from: string } | undefined> {
  const candidates: string[] = [];
  const originHead = await ok(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead) candidates.push(originHead.replace(/^origin\//, ''), originHead);
  candidates.push('main', 'master', 'develop');

  for (const base of candidates) {
    if (base === branch) return undefined;
    if (!(await ok(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]))) continue;
    const from = await ok(cwd, ['merge-base', 'HEAD', base]);
    if (!from) continue;
    return { base, from };
  }
  return undefined;
}

/** Linhas adicionadas/removidas por arquivo (`git diff --numstat`). Binários ficam sem contagem. */
async function numstat(cwd: string, args: string[]): Promise<Map<string, { additions?: number; deletions?: number }>> {
  const out = await git(cwd, ['diff', '--numstat', '--no-renames', ...args]).catch(() => '');
  const map = new Map<string, { additions?: number; deletions?: number }>();
  for (const line of out.split('\n').filter(Boolean)) {
    const [add, del, ...rest] = line.split('\t');
    map.set(rest.join('\t'), add === '-' ? {} : { additions: Number(add), deletions: Number(del) });
  }
  return map;
}

async function changedBetween(cwd: string, from: string, to: string): Promise<FileChange[]> {
  const [names, counts] = await Promise.all([
    git(cwd, ['diff', '--name-status', '--no-renames', from, to]),
    numstat(cwd, [from, to]),
  ]);
  return names
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      const file = rest.join('\t');
      return { path: file, status: status[0], ...counts.get(file) };
    });
}

/** O `git status` põe entre aspas, estilo C, caminhos com espaço ou caracteres especiais. */
export function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(esc[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function isBinary(buf: Buffer) {
  return buf.subarray(0, 8000).includes(0);
}

function countUntracked(file: string): { additions?: number; deletions?: number } {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_DIFF) return {};
    const buf = fs.readFileSync(file);
    if (isBinary(buf)) return {};
    const text = buf.toString('utf8');
    const lines = text.length ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
    return { additions: lines, deletions: 0 };
  } catch {
    return {};
  }
}

/**
 * Diff de um arquivo. Só aceita arquivos que aparecem na lista de alterados do escopo pedido:
 * assim a rota não vira um jeito de ler qualquer arquivo do disco.
 */
export async function fileDiff(cwd: string, file: string, scope: DiffScope): Promise<FileDiff> {
  const info = await gitInfo(cwd);
  const list = scope === 'branch' ? info.branchFiles : info.files;
  const entry = list?.find((f) => f.path === file);
  if (!entry) throw new Error('Arquivo não está entre os alterados');

  let diff: string;
  if (scope === 'working' && entry.status === '??') {
    diff = untrackedDiff(cwd, file);
  } else {
    const hasHead = !!(await ok(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']));
    const range =
      scope === 'branch' ? [(await branchRange(cwd, info.branch ?? ''))!.from, 'HEAD'] : [hasHead ? 'HEAD' : EMPTY_TREE];
    diff = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', ...range, '--', file]);
  }

  const binary = /^Binary files .* differ$/m.test(diff) || diff === BINARY;
  const truncated = diff.length > MAX_DIFF;
  return { path: file, scope, diff: binary ? '' : truncated ? diff.slice(0, MAX_DIFF) : diff, binary, truncated };
}

const BINARY = '\0binary';

/** Arquivo novo, ainda fora do git: todas as linhas como adicionadas. */
function untrackedDiff(cwd: string, file: string): string {
  const full = path.join(cwd, file);
  const stat = fs.statSync(full);
  if (stat.size > MAX_DIFF * 2) return `@@ -0,0 +1 @@\n+(arquivo grande demais para mostrar: ${stat.size} bytes)\n`;
  const buf = fs.readFileSync(full);
  if (isBinary(buf)) return BINARY;
  const text = buf.toString('utf8');
  if (!text.length) return '';
  const lines = text.split('\n');
  const noEol = !text.endsWith('\n');
  if (!noEol) lines.pop();
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n${noEol ? '\\ No newline at end of file\n' : ''}`;
}

function parseWorktrees(out: string) {
  return out
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const p = /^worktree (.+)$/m.exec(block)?.[1] ?? '';
      const b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? '(detached)';
      return { path: p, branch: b };
    });
}

export async function addWorktree(repo: string, dir: string, branch: string) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    await git(repo, ['worktree', 'add', '-b', branch, dir]);
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr?.trim() || String(err);
    throw new Error(`Não foi possível criar o worktree: ${msg}`);
  }
}
