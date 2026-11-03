// Histórico do git para o explorador: branches, commits, o que cada commit mudou, comparação
// entre duas refs e os arquivos de qualquer commit. Só leitura. Os caminhos são relativos à raiz
// do repositório, como o git os mostra (a sala pode ser uma subpasta dele).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitDetail, CommitLog, CommitSummary, DirEntry, DirListing, FileContent, GitRef, RefCompare } from '../shared/types.ts';
import { FileError, MAX_FILE, cleanPath, fileContent, sortEntries } from './files.ts';
import { EMPTY_TREE, changedBetween, git, ok } from './git.ts';

const exec = promisify(execFile);

/** Commits por página no histórico. */
export const PAGE = 50;

/** Hash completo do commit de `ref`. Recusa o que pareceria uma opção do git. */
export async function commitOf(cwd: string, ref: unknown): Promise<string> {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\s\0]/.test(ref)) throw new FileError('Ref inválida');
  const hash = await ok(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  if (!hash) throw new FileError(`Não achei "${ref}" no repositório`, 404);
  return hash;
}

async function requireRepo(cwd: string) {
  if ((await ok(cwd, ['rev-parse', '--is-inside-work-tree'])) !== 'true') throw new FileError('Esta pasta não é um repositório git');
}

export async function listRefs(cwd: string): Promise<GitRef[]> {
  await requireRepo(cwd);
  const current = await ok(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const out = await git(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(committerdate:relative)%1f%(subject)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  const refs: GitRef[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [full, name, hash, when, subject] = line.split('\x1f');
    // origin/HEAD só aponta para outra branch remota.
    if (full.endsWith('/HEAD')) continue;
    const kind = full.startsWith('refs/heads/') ? 'branch' : full.startsWith('refs/tags/') ? 'tag' : 'remote';
    refs.push({ name, kind, hash, when, subject, ...(kind === 'branch' && name === current ? { current: true } : {}) });
  }
  return refs;
}

const LOG_FORMAT = '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cr%x1f%cI%x1f%P%x1e';

function parseLog(out: string): CommitSummary[] {
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, short, subject, author, when, date, parents] = r.split('\x1f');
      return { hash, short, subject, author, when, date, parents: parents ? parents.split(' ') : [] };
    });
}

/** Commits de `ref`, do mais novo para o mais antigo; com `file`, só os que mexeram nele. */
export async function commitLog(cwd: string, ref: unknown, opts: { skip?: number; file?: unknown } = {}): Promise<CommitLog> {
  const hash = await commitOf(cwd, ref);
  const skip = Math.max(0, Math.floor(Number(opts.skip) || 0));
  const file = opts.file ? cleanPath(opts.file) : '';
  const out = await git(cwd, ['log', LOG_FORMAT, `--skip=${skip}`, `-n${PAGE + 1}`, hash, '--', ...(file ? [file] : [])]);
  const commits = parseLog(out);
  return { commits: commits.slice(0, PAGE), more: commits.length > PAGE };
}

/** Um commit e os arquivos que ele mudou em relação ao primeiro pai. */
export async function commitDetail(cwd: string, ref: unknown): Promise<CommitDetail> {
  const hash = await commitOf(cwd, ref);
  const [summary] = parseLog(await git(cwd, ['log', LOG_FORMAT, '-n1', hash]));
  const message = (await git(cwd, ['log', '--format=%B', '-n1', hash])).trimEnd();
  const base = summary.parents[0] ?? EMPTY_TREE;
  return { ...summary, message, base, files: await changedBetween(cwd, base, hash) };
}

/** O que `to` tem de diferente de `from` (diff direto entre as duas pontas). */
export async function compareRefs(cwd: string, from: unknown, to: unknown): Promise<RefCompare> {
  const [fromHash, toHash] = await Promise.all([commitOf(cwd, from), commitOf(cwd, to)]);
  const counts = (await git(cwd, ['rev-list', '--left-right', '--count', `${fromHash}...${toHash}`])).trim().split(/\s+/);
  const [files, log] = await Promise.all([
    changedBetween(cwd, fromHash, toHash),
    git(cwd, ['log', LOG_FORMAT, `-n${PAGE}`, `${fromHash}..${toHash}`]),
  ]);
  return {
    from: String(from),
    to: String(to),
    fromHash,
    toHash,
    behind: Number(counts[0] ?? 0),
    ahead: Number(counts[1] ?? 0),
    commits: parseLog(log),
    files,
  };
}

/** Itens de uma pasta como estavam no commit de `ref`. */
export async function treeAt(cwd: string, ref: unknown, dir: unknown): Promise<DirListing> {
  const hash = await commitOf(cwd, ref);
  const clean = cleanPath(dir ?? '');
  const out = await git(cwd, ['ls-tree', '-z', '--full-tree', hash, ...(clean ? ['--', `${clean}/`] : [])]);
  const entries: DirEntry[] = out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, full] = line.split('\t');
      const type = meta.split(' ')[1];
      return { name: full.slice(full.lastIndexOf('/') + 1), kind: type === 'tree' ? 'dir' : 'file' };
    });
  return { path: clean, entries: sortEntries(entries), truncated: false };
}

/**
 * Conteúdo de um arquivo no commit de `ref`; `missing` se ele não existe ali. Com `fromCwd`, o
 * caminho é relativo à pasta (como no explorador), e não à raiz do repositório. Com `asOnDisk`,
 * vem como o checkout o gravaria (ex.: \r\n com o core.autocrlf do Windows), para comparar com o
 * arquivo da pasta.
 */
export async function fileAt(cwd: string, ref: unknown, file: unknown, opts: { fromCwd?: boolean; asOnDisk?: boolean } = {}): Promise<FileContent> {
  const hash = await commitOf(cwd, ref);
  const clean = cleanPath(file);
  if (!clean) throw new FileError('Informe o arquivo');
  const spec = `${hash}:${opts.fromCwd ? './' : ''}${clean}`;
  const size = Number(await ok(cwd, ['cat-file', '-s', spec]));
  if (!size && (await ok(cwd, ['cat-file', '-t', spec])) !== 'blob') return fileContent(clean, undefined, 0);
  if (size > MAX_FILE) return fileContent(clean, undefined, size);
  // O \r de cada linha pode quase dobrar o tamanho com --filters.
  const { stdout } = await exec('git', ['-C', cwd, 'cat-file', opts.asOnDisk ? '--filters' : 'blob', spec], {
    encoding: 'buffer',
    maxBuffer: MAX_FILE * 2 + 1024,
    windowsHide: true,
  });
  return fileContent(clean, stdout, size);
}

/**
 * O arquivo da pasta como está no último commit, para comparar e desfazer alterações.
 * `missing` se ele é novo (ou se o repositório ainda não tem commits).
 */
export async function fileAtHead(cwd: string, file: unknown): Promise<FileContent> {
  await requireRepo(cwd);
  if (!(await ok(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']))) return fileContent(cleanPath(file), undefined, 0);
  return fileAt(cwd, 'HEAD', file, { fromCwd: true, asOnDisk: true });
}
