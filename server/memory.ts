// ai-memory ao lado do escritório: descobre se está no ar e ligado ao Claude Code, e instala
// ou remove com os comandos oficiais (container na versão fixa, wrapper conferido pelo
// checksum, install-mcp e install-hooks). Os dados ficam na pasta padrão do ai-memory,
// fora deste repositório, para o MCP, os hooks e o comando `ai-memory` acharem o token sozinhos.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryJob, MemoryStatus } from '../shared/types.ts';
import { MEMORY_CONTAINER, MEMORY_IMAGE, MEMORY_PORT, MEMORY_RELEASE, MEMORY_VERSION } from '../shared/memory.ts';
import { CLAUDE_DIR, isWindows, ptyCommand, which } from './platform.ts';

/** Avisa a interface a cada passo da instalação. */
export const memoryEvents = new EventEmitter();

// Tudo configurável para os testes usarem pastas temporárias, um Docker e um wrapper falsos.
const url = () => process.env.AI_OFFICE_MEMORY_URL ?? `http://127.0.0.1:${MEMORY_PORT}`;
const release = () => process.env.AI_OFFICE_MEMORY_RELEASE ?? MEMORY_RELEASE;
const claudeJson = () => process.env.AI_OFFICE_CLAUDE_JSON ?? path.join(os.homedir(), '.claude.json');
// Variável definida (mesmo vazia) vence o PATH: um teste "sem Docker" nunca acha o Docker de verdade.
const fromEnv = (name: string, fallback: () => string | undefined) => (name in process.env ? process.env[name] || undefined : fallback());
const dockerBin = () => fromEnv('AI_OFFICE_DOCKER_BIN', () => which('docker'));

/** Pasta padrão do ai-memory em cada sistema (a mesma que o `dirs::data_local_dir()` dele). */
export function defaultDataDir(platform = process.platform, env = process.env, home = os.homedir()): string {
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local'), 'ai-memory');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'ai-memory');
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'ai-memory');
}

export const dataDir = () => process.env.AI_OFFICE_MEMORY_DATA ?? defaultDataDir();

/** O comando `ai-memory`: o que já estiver instalado, ou o wrapper que o escritório instala em ~/.local/bin. */
function wrapperPath(): string {
  return fromEnv('AI_OFFICE_MEMORY_BIN', () => which('ai-memory')) ?? path.join(os.homedir(), '.local', 'bin', 'ai-memory');
}

let job: MemoryJob | undefined;

export async function memoryStatus(): Promise<MemoryStatus> {
  return {
    running: await healthy(),
    ...claudeWiring(),
    url: url(),
    dataDir: dataDir(),
    version: MEMORY_VERSION,
    autoInstall: !isWindows,
    docker: !!dockerBin(),
    job,
  };
}

async function healthy(): Promise<boolean> {
  try {
    // /healthz é a única rota sem token.
    const res = await fetch(`${url()}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Lê (sem mexer) se os hooks e o MCP do ai-memory estão nas configurações do Claude Code. */
export function claudeWiring(): { hooks: boolean; mcp: boolean } {
  const read = (file: string) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return undefined;
    }
  };
  const settings = read(path.join(CLAUDE_DIR, 'settings.json'));
  const hooks = JSON.stringify(settings?.hooks ?? {}).includes('ai-memory');
  const mcp = !!read(claudeJson())?.mcpServers?.['ai-memory'];
  return { hooks, mcp };
}

export class MemoryError extends Error {}

/** Começa a instalação em segundo plano; o progresso chega pelo `memoryEvents`. */
export function startInstall(): MemoryJob {
  return startJob('instalar', install);
}

export function startUninstall(): MemoryJob {
  return startJob('desinstalar', uninstall);
}

function startJob(kind: MemoryJob['kind'], run: (step: (s: string) => void) => Promise<void>): MemoryJob {
  if (job && !job.done) throw new MemoryError('Já tem uma instalação do ai-memory em andamento');
  if (isWindows) throw new MemoryError('No Windows, use o passo a passo do diálogo');
  const current: MemoryJob = { kind, step: 'Começando…', done: false, log: [] };
  job = current;
  const publish = async () => memoryEvents.emit('status', await memoryStatus());
  const step = (s: string) => {
    current.step = s;
    void publish();
  };
  run(step)
    .then(() => {
      current.step = kind === 'instalar' ? 'Pronto: a memória está ligada' : 'Pronto: o ai-memory foi removido';
    })
    .catch((err) => {
      current.error = err instanceof MemoryError ? err.message : String((err as Error).message ?? err);
    })
    .finally(() => {
      current.done = true;
      void publish();
    });
  return current;
}

/** Roda um comando guardando as últimas linhas da saída no job, para mostrar quando falha. */
async function run(bin: string, args: string[], env: NodeJS.ProcessEnv = {}, timeout = 10 * 60_000): Promise<string> {
  const cmd = ptyCommand(bin, args);
  return new Promise((resolve, reject) => {
    execFile(
      cmd.file,
      cmd.args,
      { env: { ...process.env, ...env }, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const lines = `${stdout}\n${stderr}`
          .split('\n')
          .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
          .filter(Boolean);
        job?.log.push(`$ ${path.basename(bin)} ${args.join(' ')}`, ...lines.slice(-8));
        if (job) job.log = job.log.slice(-40);
        if (err) reject(new MemoryError(`Falhou: ${path.basename(bin)} ${args.slice(0, 2).join(' ')}: ${lines.at(-1) ?? err.message}`));
        else resolve(stdout);
      },
    );
  });
}

/** Variáveis para o wrapper: imagem fixa, sem perguntas e sem checar atualização a cada chamada. */
function wrapperEnv(): NodeJS.ProcessEnv {
  return {
    AI_MEMORY_IMAGE: MEMORY_IMAGE,
    AI_MEMORY_DATA_DIR: dataDir(),
    AI_MEMORY_NO_TTY: '1',
    AI_MEMORY_NO_VERSION_CHECK: '1',
  };
}

async function install(step: (s: string) => void) {
  const docker = dockerBin();
  if (!docker) throw new MemoryError('O Docker não está instalado. Instale-o (https://docs.docker.com/get-docker/) e tente de novo.');
  step('Conferindo o Docker');
  await run(docker, ['version', '--format', '{{.Server.Version}}'], {}, 30_000).catch(() => {
    throw new MemoryError('O Docker não respondeu. Ele está rodando?');
  });

  step(`Baixando a imagem do ai-memory ${MEMORY_VERSION} (~200 MB na primeira vez)`);
  await run(docker, ['pull', MEMORY_IMAGE]);

  // O container roda com o seu usuário: os arquivos da pasta ficam seus, não do root.
  const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid!()}`] : [];
  const data = dataDir();
  step(`Preparando a pasta dos dados (${data})`);
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  // `init` cria o token: sem ele, qualquer página aberta no navegador leria a memória.
  if (!fs.existsSync(path.join(data, 'auth-tokens', 'default'))) {
    await run(docker, ['run', '--rm', ...user, '-v', `${data}:/data`, MEMORY_IMAGE, 'init']);
  }

  step('Subindo o servidor');
  const exists = await run(docker, ['container', 'inspect', '--format', '{{.State.Running}}', MEMORY_CONTAINER], {}, 30_000).catch(() => undefined);
  if (exists === undefined) {
    await run(docker, [
      'run', '-d', '--name', MEMORY_CONTAINER, '--restart', 'unless-stopped', ...user,
      '-p', `127.0.0.1:${MEMORY_PORT}:${MEMORY_PORT}`, '-v', `${data}:/data`, MEMORY_IMAGE,
    ]);
  } else if (exists.trim() !== 'true') {
    await run(docker, ['start', MEMORY_CONTAINER]);
  }
  if (!(await waitHealthy(30_000))) throw new MemoryError(`O servidor não respondeu em ${url()}. Veja "docker logs ${MEMORY_CONTAINER}".`);

  const wrapper = wrapperPath();
  if (!fs.existsSync(wrapper)) {
    step('Instalando o comando ai-memory');
    await installWrapper(wrapper);
  }

  step('Ligando ao Claude Code (hooks e MCP)');
  await run(wrapper, ['install-mcp', '--client', 'claude-code', '--apply'], wrapperEnv());
  await run(wrapper, ['install-hooks', '--agent', 'claude-code', '--apply'], wrapperEnv());
}

async function waitHealthy(ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await healthy()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Baixa o wrapper da versão fixa e só grava se o SHA-256 bater com o publicado na release. */
async function installWrapper(dest: string) {
  const get = async (name: string): Promise<Buffer> => {
    const src = `${release()}/${name}`;
    if (!/^https?:/.test(src)) return fs.readFileSync(src);
    const res = await fetch(src, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new MemoryError(`Não foi possível baixar ${name} (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  };
  const [body, sum] = await Promise.all([get('ai-memory-wrapper'), get('ai-memory-wrapper.sha256')]);
  const expected = sum.toString('utf8').trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(body).digest('hex');
  if (!expected || expected !== actual) throw new MemoryError('O checksum do wrapper do ai-memory não confere; nada foi instalado');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body, { mode: 0o755 });
  job?.log.push(`wrapper instalado em ${dest}`);
}

/** Tira hooks e MCP do Claude Code e remove o container. Os dados ficam na pasta. */
async function uninstall(step: (s: string) => void) {
  const wrapper = wrapperPath();
  if (fs.existsSync(wrapper)) {
    step('Desligando do Claude Code (hooks e MCP)');
    await run(wrapper, ['uninstall', '--apply'], wrapperEnv());
  }
  const docker = dockerBin();
  if (docker) {
    step('Removendo o container');
    await run(docker, ['rm', '-f', MEMORY_CONTAINER], {}, 60_000).catch(() => undefined);
  }
}

/** Abre a pasta dos dados no gerenciador de arquivos. Só essa pasta: o caminho não vem do navegador. */
export function openDataDir() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) throw new MemoryError('A pasta ainda não existe: ela é criada na instalação');
  const opener = isWindows ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [dir], { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref();
}

/** Só para os testes: esquece o último job. */
export function resetMemoryJob() {
  job = undefined;
}
