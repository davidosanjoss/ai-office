import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pty, { type IPty } from '@lydell/node-pty';
import type { Agent } from '../shared/types.ts';
import { findTranscript } from './discover.ts';
import { addWorktree } from './git.ts';
import { DATA_DIR, HOST, PORT, claudeBin, defaultShell, isWindows, ptyCommand } from './platform.ts';
import { store } from './store.ts';

const HOOK_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'office-hook.mjs');
export const SETTINGS_FILE = path.join(DATA_DIR, 'claude-hooks.json');
const SCROLLBACK_LIMIT = 400_000;
/** Saiu com erro em menos tempo que isso: falhou ao iniciar, e a mensagem vai para a atividade. */
const QUICK_EXIT_MS = 10_000;

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd',
];

const NAMES = [
  'Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabi', 'Heitor', 'Iara', 'João',
  'Kátia', 'Leo', 'Marina', 'Nina', 'Otávio', 'Paula', 'Rafa', 'Sofia', 'Tiago', 'Vitória',
];

const running = new Map<string, IPty>();
// Fica guardado mesmo depois que o processo termina, para você ver o que ele mostrou ao sair.
const scrollbacks = new Map<string, string>();

/** Arquivo de settings passado com --settings: só as sessões do escritório recebem esses hooks. */
function writeHookSettings() {
  const command = `"${process.execPath}" "${HOOK_SCRIPT}"`;
  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ matcher: '', hooks: [{ type: 'command', command: `${command} ${event}`, timeout: 5 }] }];
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ hooks }, null, 2));
}
writeHookSettings();

function pickName(roomId: string): string {
  const used = new Set([...store.agents.values()].filter((a) => a.roomId === roomId).map((a) => a.name));
  const free = NAMES.filter((n) => !used.has(n));
  const pool = free.length ? free : NAMES;
  const name = pool[Math.floor(Math.random() * pool.length)];
  return free.length ? name : `${name} ${used.size + 1}`;
}

/** Nome seguro para pasta e branch: "Vitória Souza" → "vitoria-souza". */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'agente'
  );
}

export function getScrollback(id: string): string {
  return scrollbacks.get(id) ?? '';
}

export function isRunning(id: string): boolean {
  return running.has(id);
}

function shellName(roomId: string, incidentId?: string): string {
  // Os terminais da sala de guerra contam à parte dos da sala do projeto onde abrem.
  const used = new Set(
    [...store.agents.values()]
      .filter((a) => a.kind === 'shell' && (incidentId ? a.incidentId === incidentId : a.roomId === roomId && !a.incidentId))
      .map((a) => a.name),
  );
  let n = 1;
  while (used.has(`Terminal ${n}`)) n++;
  return `Terminal ${n}`;
}

/**
 * Abre uma aba de terminal comum (o seu shell) na pasta da sala, sem Claude. Com `incidentId`,
 * o terminal é da sala de guerra: aparece nas abas dela e fecha quando o incidente é encerrado.
 */
export function createShell(roomId: string, opts: { incidentId?: string } = {}): Agent {
  const room = store.rooms.get(roomId);
  if (!room) throw new Error('Sala não encontrada');
  const agent: Agent = {
    id: randomUUID().slice(0, 8),
    kind: 'shell',
    roomId,
    name: shellName(roomId, opts.incidentId),
    cwd: room.path,
    sessionId: '',
    status: 'idle',
    activity: path.basename(defaultShell()),
    subagents: 0,
    createdAt: Date.now(),
    ...(opts.incidentId ? { incidentId: opts.incidentId, forIncident: true } : {}),
  };
  store.putAgent(agent);
  spawn(agent, false);
  return agent;
}

export async function createAgent(roomId: string, opts: { name?: string; worktree?: boolean; incidentId?: string }): Promise<Agent> {
  const room = store.rooms.get(roomId);
  if (!room) throw new Error('Sala não encontrada');
  const name = opts.name?.trim() || pickName(roomId);
  const id = randomUUID().slice(0, 8);

  let cwd = room.path;
  let worktreeBranch: string | undefined;
  if (opts.worktree) {
    const slug = slugify(name);
    worktreeBranch = `office/${slug}-${id}`;
    cwd = path.join(DATA_DIR, 'worktrees', path.basename(room.path), `${slug}-${id}`);
    await addWorktree(room.path, cwd, worktreeBranch);
  }

  const agent: Agent = {
    id,
    kind: 'claude',
    roomId,
    name,
    cwd,
    worktreeBranch,
    sessionId: randomUUID(),
    status: 'starting',
    activity: opts.incidentId ? 'Indo para a sala de guerra…' : 'Chegando no escritório…',
    subagents: 0,
    createdAt: Date.now(),
    // Contratado para um incidente: vai direto para a sala de guerra e sai quando ela fecha.
    ...(opts.incidentId ? { incidentId: opts.incidentId, forIncident: true } : {}),
  };
  store.putAgent(agent);
  spawn(agent, false);
  store.log(id, opts.incidentId ? `${name} foi chamado para a sala de guerra` : `${name} entrou na sala`, 'system');
  return agent;
}

/**
 * Retoma um agente cujo processo terminou, continuando a mesma conversa.
 * Se a conversa nunca chegou a ser salva, começa uma nova com o mesmo ID.
 */
export function resumeAgent(id: string) {
  const agent = store.agents.get(id);
  if (!agent || running.has(id)) return;
  appendScrollback(id, '\r\n\x1b[2m──── reaberto ────\x1b[0m\r\n');
  if (agent.kind === 'shell') {
    store.patchAgent(id, { status: 'idle', exitCode: undefined });
    spawn(agent, false);
    return;
  }
  const resume = !!findTranscript(agent.sessionId);
  store.patchAgent(id, {
    status: 'starting',
    activity: resume ? 'Voltando ao trabalho…' : 'Começando uma conversa nova…',
    subagents: 0,
    exitCode: undefined,
  });
  spawn(store.agents.get(id)!, resume);
  store.log(
    id,
    resume ? `${agent.name} voltou para a mesa` : `${agent.name} voltou, mas a conversa anterior não tinha sido salva: começando uma nova`,
    'system',
  );
}

/** Argumentos do `claude`: sessão nova usa o ID que escolhemos; retomada continua a mesma conversa. */
export function claudeArgs(sessionId: string, resume: boolean, settingsFile = SETTINGS_FILE): string[] {
  return ['--settings', settingsFile, resume ? '--resume' : '--session-id', sessionId];
}

function appendScrollback(id: string, data: string) {
  let buf = (scrollbacks.get(id) ?? '') + data;
  if (buf.length > SCROLLBACK_LIMIT) buf = buf.slice(-SCROLLBACK_LIMIT);
  scrollbacks.set(id, buf);
}

/** Última linha com texto da saída, sem códigos de cor: costuma ser a mensagem de erro. */
export function lastLine(output: string): string {
  const plain = output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]|\x1b[=>78]/g, '');
  const lines = plain.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? '';
}

function spawn(agent: Agent, resume: boolean) {
  const isShell = agent.kind === 'shell';
  const bin = isShell ? defaultShell() : claudeBin();
  if (!bin) {
    store.patchAgent(agent.id, { status: 'exited', activity: 'Claude Code não encontrado no PATH' });
    return;
  }
  const args = isShell ? [] : claudeArgs(agent.sessionId, resume);
  const cmd = ptyCommand(bin, args);
  const cwd = fs.existsSync(agent.cwd) ? agent.cwd : store.rooms.get(agent.roomId)!.path;
  // Só as sessões do Claude reportam eventos ao escritório.
  const officeEnv = isShell ? {} : { AI_OFFICE_URL: `http://${HOST}:${PORT}`, AI_OFFICE_AGENT_ID: agent.id };

  const proc = pty.spawn(cmd.file, cmd.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd,
    env: {
      ...cleanEnv(),
      ...officeEnv,
      COLORTERM: 'truecolor',
    } as Record<string, string>,
    useConpty: isWindows ? true : undefined,
  });

  running.set(agent.id, proc);
  const startedAt = Date.now();
  let output = '';

  proc.onData((data) => {
    ready.add(proc);
    if (output.length < 20_000) output += data;
    appendScrollback(agent.id, data);
    store.output(agent.id, data);
  });

  proc.onExit(({ exitCode }) => {
    if (running.get(agent.id) === proc) running.delete(agent.id);
    if (!store.agents.has(agent.id)) return;
    // Como num emulador de terminal: `exit` fecha a aba.
    if (isShell) {
      scrollbacks.delete(agent.id);
      return store.removeAgent(agent.id);
    }
    const failed = exitCode !== 0 && Date.now() - startedAt < QUICK_EXIT_MS;
    const reason = failed ? lastLine(output) : '';
    store.patchAgent(agent.id, {
      status: 'exited',
      activity: reason ? `Não conseguiu abrir: ${reason}` : 'Saiu do escritório',
      subagents: 0,
      exitCode,
    });
    store.log(agent.id, reason ? `${agent.name} não conseguiu abrir: ${reason}` : `${agent.name} encerrou a sessão (código ${exitCode})`, 'system');
  });
}

// Marcadores de uma sessão do Claude em andamento. Se o servidor foi iniciado de dentro de
// uma, os agentes se achariam "filhos" dela (e, por exemplo, deixariam de salvar o histórico).
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
];

export function cleanEnv() {
  const env = { ...process.env };
  for (const key of INHERITED_SESSION_VARS) delete env[key];
  return env;
}

export function writeInput(id: string, data: string) {
  running.get(id)?.write(data);
}

export function resize(id: string, cols: number, rows: number) {
  const proc = running.get(id);
  if (!proc || cols < 2 || rows < 2) return;
  try {
    proc.resize(Math.floor(cols), Math.floor(rows));
  } catch {}
}

/**
 * Se há algum programa rodando no terminal (além do próprio shell), para avisar antes de fechar.
 * No Windows o node-pty não informa o processo em primeiro plano; aí sempre perguntamos.
 */
export function isBusy(id: string): boolean {
  const proc = running.get(id);
  if (!proc) return false;
  if (isWindows) return true;
  const shell = path.basename(defaultShell());
  return proc.process !== shell && !proc.process.endsWith(`/${shell}`);
}

/** Terminais que já mostraram alguma saída: no Windows, só esses o ConPTY encerra com segurança. */
const ready = new WeakSet<object>();

type Killable = { kill(): void; onData(cb: (d: string) => void): { dispose(): void } };

/**
 * Encerra o terminal. No Windows, um terminal recém-aberto ainda está conectando o ConPTY, e
 * encerrá-lo nesse meio pode derrubar o servidor: espera a primeira saída (até 3 s) antes.
 */
export function killWhenReady(proc: Killable, isReady: boolean, windows = isWindows, waitMs = 3000) {
  if (!windows || isReady) return proc.kill();
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    sub.dispose();
    try {
      proc.kill();
    } catch {}
  };
  const timer = setTimeout(go, waitMs);
  const sub = proc.onData(() => setTimeout(go, 50));
}

export function killAgent(id: string) {
  const proc = running.get(id);
  if (proc) killWhenReady(proc, ready.has(proc));
}

/** Encerra a sessão e espera o processo sair (até 5 s), para a pasta dele poder ser apagada. */
export function stopAgent(id: string): Promise<void> {
  const proc = running.get(id);
  if (!proc) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    proc.onExit(() => {
      clearTimeout(timer);
      resolve();
    });
    killWhenReady(proc, ready.has(proc));
  });
}

export function removeAgent(id: string) {
  killAgent(id);
  running.delete(id);
  scrollbacks.delete(id);
  store.removeAgent(id);
}

export function killAll() {
  for (const proc of running.values()) {
    try {
      proc.kill();
    } catch {}
  }
  running.clear();
}
