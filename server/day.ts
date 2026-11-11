// "Meu dia" e o relatório do dia. O servidor guarda a linha do tempo dos estados dos agentes
// (trabalhando, pedindo você, terminou e esperando você ver) em ~/.ai-office/dia/AAAA-MM-DD.jsonl,
// desde que está ligado (o passado antes disso não dá para refazer). O relatório junta, por
// projeto, os pedidos do dia (dos transcripts do Claude Code), os commits, os eventos do GitHub, o
// tempo e os tokens; o resumo em texto, opcional, é feito pelo próprio Claude (`claude -p`).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type DayInterval, type DayReport, type DayStatus, dayBounds, summarizeDay } from '../shared/day.ts';
import { type Place, type Price, type UsageRecord, dayKey } from '../shared/usage.ts';
import type { Agent } from '../shared/types.ts';
import { cleanEnv } from './agents.ts';
import { CLAUDE_DIR, DATA_DIR, claudeBin, ptyCommand } from './platform.ts';
import { projectOf } from './projects.ts';
import { store } from './store.ts';

const DIR = path.join(DATA_DIR, 'dia');
const TRACKED: DayStatus[] = ['working', 'waiting', 'done'];

/** Estado atual de cada agente e desde quando (o intervalo aberto, ainda não gravado). */
const open = new Map<string, { status: DayStatus; since: number; agent: string; roomId: string; projectId?: string }>();

function append(date: string, line: object) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(path.join(DIR, `${date}.jsonl`), JSON.stringify(line) + '\n');
}

/** Fecha o intervalo aberto do agente (se havia) e grava no dia em que ele começou. */
function close(agentId: string, now: number) {
  const o = open.get(agentId);
  if (!o) return;
  open.delete(agentId);
  if (now - o.since < 1000) return;
  const iv: DayInterval = { agentId, agent: o.agent, roomId: o.roomId, projectId: o.projectId, status: o.status, from: o.since, to: now };
  append(dayKey(o.since), iv);
}

/** Acompanha as mudanças de estado dos agentes (chamado pelo store a cada agente atualizado). */
export function trackAgent(a: Agent, now = Date.now()) {
  if (a.kind === 'shell') return;
  const cur = open.get(a.id);
  const status = TRACKED.includes(a.status as DayStatus) ? (a.status as DayStatus) : undefined;
  if (cur && cur.status === status) return;
  close(a.id, now);
  if (!status) return;
  const room = store.rooms.get(a.roomId);
  open.set(a.id, { status, since: now, agent: a.name, roomId: a.roomId, projectId: room ? projectOf(room, a.projectId).id : undefined });
}

/** Evento do dia que vai para o relatório (PR aberto, CI vermelho...). */
export function recordDayEvent(roomId: string, text: string, now = Date.now()) {
  append(dayKey(now), { event: text, roomId, at: now });
}

let tracking = false;
export function startDayTracking() {
  if (tracking) return;
  tracking = true;
  store.on('msg', (msg: { t: string; agent?: Agent; id?: string }) => {
    if (msg.t === 'agent' && msg.agent) trackAgent(msg.agent);
    if (msg.t === 'agentRemoved' && msg.id) close(msg.id, Date.now());
  });
}

function readDay(date: string): { intervals: DayInterval[]; events: { event: string; roomId: string; at: number }[] } {
  const intervals: DayInterval[] = [];
  const events: { event: string; roomId: string; at: number }[] = [];
  let text = '';
  try {
    text = fs.readFileSync(path.join(DIR, `${date}.jsonl`), 'utf8');
  } catch {}
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.event) events.push(d);
      else if (d.status) intervals.push(d);
    } catch {}
  }
  return { intervals, events };
}

/**
 * Pedidos que você fez no dia, dos transcripts do Claude Code (só os arquivos mexidos naquele
 * dia): mensagens suas, sem as notificações e as mensagens do sistema.
 */
export function dayPrompts(date: string, root = path.join(CLAUDE_DIR, 'projects')): { cwd: string; text: string; at: number }[] {
  const { from, to } = dayBounds(date);
  const out: { cwd: string; text: string; at: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 1) walk(full, depth + 1);
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      try {
        if (fs.statSync(full).mtimeMs < from) continue;
      } catch {
        continue;
      }
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (!line.includes('"type":"user"')) continue;
        try {
          const d = JSON.parse(line);
          const c = d.message?.content;
          const at = Date.parse(d.timestamp);
          if (typeof c !== 'string' || d.isMeta || !Number.isFinite(at) || at < from || at >= to) continue;
          const t = c.trim();
          // Fora: notificações, mensagens do sistema e o resumo que o Claude Code grava ao compactar a conversa.
          if (!t || t.startsWith('<') || d.promptSource === 'system' || d.isCompactSummary || /^This session is being continued from a previous conversation/.test(t)) continue;
          out.push({ cwd: String(d.cwd ?? ''), text: t.slice(0, 500), at });
        } catch {}
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.at - b.at);
}

/** Commits do dia num repositório (de todo mundo), do mais novo para o mais velho. */
function dayCommits(dir: string, date: string): Promise<{ hash: string; subject: string; at: number }[]> {
  const { from, to } = dayBounds(date);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir, 'log', '--all', `--since=@${Math.floor(from / 1000)}`, `--until=@${Math.floor(to / 1000)}`, '--pretty=format:%h%x1f%s%x1f%ct', '-n', '30'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              const [hash, subject, ct] = l.split('\x1f');
              return { hash, subject, at: Number(ct) * 1000 };
            }),
        );
      },
    );
  });
}

/** O relatório do dia: tempo, pedidos, commits, eventos e tokens, por projeto. */
export async function dayReport(date: string, records: UsageRecord[], locate: (cwd: string) => Place, prices: Record<string, Price>, now = Date.now()): Promise<DayReport> {
  const { intervals, events } = readDay(date);
  // O que ainda está aberto (agente trabalhando agora) também conta, até agora.
  const { from, to } = dayBounds(date);
  for (const [agentId, o] of open) {
    if (o.since < to && now > from) intervals.push({ agentId, agent: o.agent, roomId: o.roomId, projectId: o.projectId, status: o.status, from: o.since, to: Math.min(now, to) });
  }
  const prompts = dayPrompts(date);
  const dirs = new Map<string, string>();
  for (const r of store.rooms.values()) for (const p of r.projects ?? []) dirs.set(`p:${p.id}`, p.path);
  const commits: Record<string, { hash: string; subject: string; at: number }[]> = {};
  await Promise.all(
    [...dirs].map(async ([key, dir]) => {
      const c = await dayCommits(dir, date);
      if (c.length) commits[key] = c;
    }),
  );
  return summarizeDay({ date, intervals, events, prompts, commits, records: records.filter((r) => r.ts >= from && r.ts < to), locate, rooms: [...store.rooms.values()], prices, now });
}

const SUMMARY_FILE = (date: string) => path.join(DIR, `${date}-resumos.json`);

/**
 * Resumo em texto de um projeto no dia, feito pelo Claude (`claude -p`, modelo Haiku), a partir
 * dos pedidos, commits e eventos. Guardado para não gastar de novo.
 */
export async function summarizeWithClaude(date: string, key: string, digest: string): Promise<string> {
  let cache: Record<string, string> = {};
  try {
    cache = JSON.parse(fs.readFileSync(SUMMARY_FILE(date), 'utf8'));
  } catch {}
  fs.mkdirSync(DIR, { recursive: true });
  const bin = claudeBin();
  if (!bin) throw new Error('Claude Code não encontrado no PATH');
  const prompt = `Resuma em português, em no máximo 4 frases curtas e sem enfeite, o que foi feito hoje neste projeto, a partir dos pedidos, commits e eventos abaixo. Diga o que avançou, o que ficou pendente (se der para saber) e nada além disso.\n\n${digest}`;
  // O pedido vai pela entrada padrão: no Windows, texto com quebras de linha não passa inteiro pelo cmd.exe.
  const cmd = ptyCommand(bin, ['-p', '--model', 'haiku', '--output-format', 'text']);
  const text = await new Promise<string>((resolve, reject) => {
    const child = execFile(cmd.file, cmd.args, { timeout: 180_000, windowsHide: true, maxBuffer: 1024 * 1024, env: cleanEnv(), cwd: DIR }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`O Claude não conseguiu resumir: ${(stderr || err.message).trim().split('\n').at(-1)}`));
      resolve(stdout.trim());
    });
    child.stdin?.end(prompt);
  });
  cache[key] = text;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SUMMARY_FILE(date), JSON.stringify(cache, null, 2));
  return text;
}

export function cachedSummaries(date: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SUMMARY_FILE(date), 'utf8'));
  } catch {
    return {};
  }
}
