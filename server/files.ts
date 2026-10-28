// Explorador de arquivos: lê, salva, cria, renomeia e apaga dentro da pasta de uma sala ou agente.
// Todo caminho chega relativo à raiz e é conferido aqui: nada sai da pasta do projeto, nem por
// "..", nem por link simbólico, e a pasta .git fica de fora.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DirEntry, DirListing, FileContent } from '../shared/types.ts';
import { isBinary } from './git.ts';

/** Maior arquivo que abre no editor. */
export const MAX_FILE = 2 * 1024 * 1024;
/** Itens mostrados por pasta (um node_modules pode ter milhares). */
const MAX_ENTRIES = 2000;

export class FileError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Caminho relativo normalizado com "/" (vazio = raiz). Recusa "..", absolutos e a pasta .git. */
export function cleanPath(rel: unknown): string {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new FileError('Caminho inválido');
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel)) throw new FileError('O caminho precisa ser relativo ao projeto');
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (parts.includes('..')) throw new FileError('O caminho não pode sair da pasta do projeto');
  if (parts.some((p) => p.toLowerCase() === '.git')) throw new FileError('A pasta .git fica de fora do explorador');
  return parts.join('/');
}

/**
 * Caminho no disco para `rel`, dentro de `root`. O pedaço que já existe é resolvido com os links
 * simbólicos e precisa continuar dentro da raiz.
 */
export function resolveInside(root: string, rel: unknown): string {
  const clean = cleanPath(rel);
  const full = path.join(root, ...clean.split('/'));
  const realRoot = fs.realpathSync(root);
  let probe = full;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  const inside = path.relative(realRoot, fs.realpathSync(probe));
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new FileError('O caminho sai da pasta do projeto');
  return full;
}

const version = (buf: Buffer) => createHash('sha1').update(buf).digest('hex');

/** Pastas primeiro, depois arquivos, em ordem alfabética sem diferenciar maiúsculas. */
export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1));
}

export function listDir(root: string, rel: unknown): DirListing {
  const dir = resolveInside(root, rel);
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new FileError('Pasta não encontrada', 404);
  }
  const entries: DirEntry[] = [];
  for (const item of items) {
    if (item.name === '.git') continue;
    let isDir = item.isDirectory();
    if (item.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(dir, item.name)).isDirectory();
      } catch {
        // Link quebrado: aparece como arquivo, e abrir dá o erro.
      }
    }
    entries.push({ name: item.name, kind: isDir ? 'dir' : 'file' });
  }
  sortEntries(entries);
  return { path: cleanPath(rel), entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

/** Conteúdo para o editor. Binários e arquivos grandes demais vêm sem conteúdo. */
export function fileContent(file: string, buf: Buffer | undefined, size: number): FileContent {
  if (size > MAX_FILE) return { path: file, content: '', version: '', binary: false, tooLarge: true };
  if (!buf) return { path: file, content: '', version: '', binary: false, tooLarge: false, missing: true };
  if (isBinary(buf)) return { path: file, content: '', version: version(buf), binary: true, tooLarge: false };
  return { path: file, content: buf.toString('utf8'), version: version(buf), binary: false, tooLarge: false };
}

export function readFile(root: string, rel: unknown): FileContent {
  const full = resolveInside(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    throw new FileError('Arquivo não encontrado', 404);
  }
  if (!stat.isFile()) throw new FileError('Não é um arquivo');
  return fileContent(cleanPath(rel), stat.size > MAX_FILE ? undefined : fs.readFileSync(full), stat.size);
}

/**
 * Salva o arquivo. Com `version`, só salva se o arquivo no disco ainda é o que foi lido (senão
 * 409: alguém, talvez um agente, mudou enquanto você editava). Com `create`, o arquivo não pode
 * existir. Sem nenhum dos dois, sobrescreve.
 */
export function writeFile(root: string, rel: unknown, content: unknown, opts: { version?: string; create?: boolean } = {}): { version: string } {
  if (typeof content !== 'string') throw new FileError('Conteúdo inválido');
  const clean = cleanPath(rel);
  if (!clean) throw new FileError('Informe o nome do arquivo');
  const full = resolveInside(root, clean);
  const exists = fs.existsSync(full);
  if (opts.create && exists) throw new FileError('Já existe um arquivo ou pasta com esse nome', 409);
  if (exists && !fs.statSync(full).isFile()) throw new FileError('Não é um arquivo');
  if (opts.version !== undefined) {
    if (!exists) throw new FileError('O arquivo foi apagado enquanto você editava', 409);
    if (version(fs.readFileSync(full)) !== opts.version) throw new FileError('O arquivo mudou no disco enquanto você editava', 409);
  }
  if (!exists && !fs.existsSync(path.dirname(full))) throw new FileError('A pasta não existe', 404);
  const buf = Buffer.from(content, 'utf8');
  fs.writeFileSync(full, buf);
  return { version: version(buf) };
}

export function makeDir(root: string, rel: unknown): { ok: true } {
  const clean = cleanPath(rel);
  if (!clean) throw new FileError('Informe o nome da pasta');
  const full = resolveInside(root, clean);
  if (fs.existsSync(full)) throw new FileError('Já existe um arquivo ou pasta com esse nome', 409);
  fs.mkdirSync(full, { recursive: true });
  return { ok: true };
}

export function renamePath(root: string, from: unknown, to: unknown): { ok: true } {
  const src = cleanPath(from);
  const dest = cleanPath(to);
  if (!src || !dest) throw new FileError('Informe os dois nomes');
  const a = resolveInside(root, src);
  const b = resolveInside(root, dest);
  if (!fs.existsSync(a)) throw new FileError('Arquivo não encontrado', 404);
  // Só a caixa muda ("readme" → "README"): no Windows e no macOS é o mesmo arquivo.
  const sameFile = src.toLowerCase() === dest.toLowerCase();
  if (fs.existsSync(b) && !sameFile) throw new FileError('Já existe um arquivo ou pasta com esse nome', 409);
  if (`${dest}/`.startsWith(`${src}/`)) throw new FileError('Uma pasta não pode ir para dentro dela mesma');
  if (!fs.existsSync(path.dirname(b))) throw new FileError('A pasta de destino não existe', 404);
  fs.renameSync(a, b);
  return { ok: true };
}

export function removePath(root: string, rel: unknown): { ok: true } {
  const clean = cleanPath(rel);
  if (!clean) throw new FileError('A raiz do projeto não pode ser apagada');
  const full = resolveInside(root, clean);
  if (!fs.existsSync(full) && !isLink(full)) throw new FileError('Arquivo não encontrado', 404);
  // Um link é apagado como link: o que ele aponta fica onde está.
  fs.rmSync(full, { recursive: !isLink(full), force: true });
  return { ok: true };
}

function isLink(p: string) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
