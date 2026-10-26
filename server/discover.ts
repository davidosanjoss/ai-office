import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR } from './platform.ts';

/**
 * Lista as pastas onde você já usou o Claude Code, lendo o campo `cwd`
 * dos transcripts em ~/.claude/projects. Serve de sugestão ao criar salas.
 */
export function discoverProjects(root = path.join(CLAUDE_DIR, 'projects')): { path: string; lastUsed: number }[] {
  if (!fs.existsSync(root)) return [];

  const found = new Map<string, number>();
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const full = path.join(root, dir.name);
    const files = fs
      .readdirSync(full)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(full, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) continue;

    const cwd = readCwd(path.join(full, files[0].f));
    if (cwd && fs.existsSync(cwd)) found.set(cwd, Math.max(found.get(cwd) ?? 0, files[0].mtime));
  }
  return [...found].map(([p, lastUsed]) => ({ path: p, lastUsed })).sort((a, b) => b.lastUsed - a.lastUsed);
}

function readCwd(file: string): string | undefined {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) return JSON.parse(`"${m[1]}"`);
    }
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

/**
 * Acha o transcript de uma sessão. O Claude só grava o arquivo depois da primeira mensagem,
 * então uma sessão aberta e fechada sem conversa não pode ser retomada com --resume.
 */
export function findTranscript(sessionId: string, root = path.join(CLAUDE_DIR, 'projects')): string | undefined {
  if (!sessionId || !fs.existsSync(root)) return undefined;
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}
