import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

export const PORT = Number(process.env.AI_OFFICE_PORT ?? 7420);
// Só escuta em loopback: o servidor dá acesso a shell.
export const HOST = '127.0.0.1';
export const DATA_DIR = process.env.AI_OFFICE_DATA ?? path.join(os.homedir(), '.ai-office');
// Configuráveis para os testes apontarem para pastas temporárias e um Claude falso.
export const CLAUDE_DIR = process.env.AI_OFFICE_CLAUDE_DIR ?? path.join(os.homedir(), '.claude');

fs.mkdirSync(DATA_DIR, { recursive: true });

/** Procura um executável no PATH, respeitando PATHEXT no Windows. */
export function which(cmd: string): string | undefined {
  const exts = isWindows ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext.toLowerCase());
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      const upper = path.join(dir, cmd + ext);
      if (ext && fs.existsSync(upper) && fs.statSync(upper).isFile()) return upper;
    }
  }
  // Instalação nativa do Claude Code fica em ~/.local/bin, que nem sempre está no PATH de serviços.
  const fallback = path.join(os.homedir(), '.local', 'bin', isWindows ? `${cmd}.exe` : cmd);
  return fs.existsSync(fallback) ? fallback : undefined;
}

/** Executável do Claude Code. */
export function claudeBin(): string | undefined {
  return process.env.AI_OFFICE_CLAUDE_BIN || which('claude');
}

/** GitHub CLI, para abrir PRs. Configurável para os testes usarem um falso. */
export function ghBin(): string | undefined {
  return process.env.AI_OFFICE_GH_BIN || which('gh');
}

/** Shell do usuário para as abas de terminal comum. */
export function defaultShell(): string {
  if (process.env.AI_OFFICE_SHELL) return process.env.AI_OFFICE_SHELL;
  if (isWindows) return which('pwsh') ?? 'powershell.exe';
  // O shell de login do usuário, e não o $SHELL herdado de quem iniciou o servidor.
  let login: string | undefined;
  try {
    login = os.userInfo().shell ?? undefined;
  } catch {}
  return login || process.env.SHELL || which('bash') || '/bin/sh';
}

/**
 * Monta o comando para o node-pty. No Windows, .cmd/.bat precisam passar pelo cmd.exe;
 * scripts .js/.mjs (o Claude falso dos testes) rodam com o próprio Node.
 */
export function ptyCommand(bin: string, args: string[], windows = isWindows): { file: string; args: string[] } {
  if (/\.m?js$/i.test(bin)) return { file: process.execPath, args: [bin, ...args] };
  if (windows && /\.(cmd|bat)$/i.test(bin)) {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args] };
  }
  return { file: bin, args };
}
