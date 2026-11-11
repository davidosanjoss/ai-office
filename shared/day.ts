// "Meu dia" e o relatório do dia: tipos e as contas (puras), usados pelo servidor (que junta os
// dados) e pela interface (que mostra). O tempo é tempo de agente: dois agentes trabalhando uma
// hora contam duas horas.

import type { Room } from './types.ts';
import { type Place, type Price, type Tokens, type UsageRecord, costOf, priceFor, tokensOf, totalTokens } from './usage.ts';

/** Estados que entram na conta: trabalhando, pedindo você (permissão, pergunta) e terminou esperando você ver. */
export type DayStatus = 'working' | 'waiting' | 'done';

export interface DayInterval {
  agentId: string;
  agent: string;
  roomId: string;
  projectId?: string;
  status: DayStatus;
  from: number;
  to: number;
}

export interface DayProject {
  place: Place;
  workMs: number;
  /** Pedindo você: permissão ou pergunta. */
  waitMs: number;
  /** Terminou e ficou esperando você ver. */
  doneMs: number;
  prompts: { text: string; at: number }[];
  commits: { hash: string; subject: string; at: number }[];
  events: { text: string; at: number }[];
  tokens: Tokens;
  cost: number;
  agents: string[];
}

export interface DayReport {
  date: string;
  totals: { workMs: number; waitMs: number; doneMs: number; prompts: number; commits: number; tokens: number; cost: number };
  /** Por hora do dia (0 a 23): minutos de agente trabalhando e esperando você. */
  byHour: { work: number; wait: number }[];
  projects: DayProject[];
  /** As esperas mais longas por você (permissão ou pergunta, e "terminou, esperando você ver"). */
  longestWaits: { agent: string; place: string; ms: number; at: number; status: DayStatus }[];
}

/** Começo e fim do dia local "AAAA-MM-DD" (ms). */
export function dayBounds(date: string): { from: number; to: number } {
  const [y, m, d] = date.split('-').map(Number);
  const from = new Date(y, m - 1, d).getTime();
  const to = new Date(y, m - 1, d + 1).getTime();
  return { from, to };
}

/** Parte de [a, b) dentro de [from, to). */
const overlap = (a: number, b: number, from: number, to: number) => Math.max(0, Math.min(b, to) - Math.max(a, from));

const zero = (): Tokens => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

export function summarizeDay(o: {
  date: string;
  intervals: DayInterval[];
  events: { event: string; roomId: string; at: number }[];
  prompts: { cwd: string; text: string; at: number }[];
  commits: Record<string, { hash: string; subject: string; at: number }[]>;
  records: UsageRecord[];
  locate: (cwd: string) => Place;
  rooms: Room[];
  prices: Record<string, Price>;
  now: number;
}): DayReport {
  const { from, to } = dayBounds(o.date);
  const projects = new Map<string, DayProject>();
  const roomPlace = (roomId: string, projectId?: string): Place => {
    const room = o.rooms.find((r) => r.id === roomId);
    if (!room) return { key: `r:${roomId}`, label: 'Sala removida' };
    const p = room.projects?.find((x) => x.id === projectId) ?? (room.projects?.length === 1 ? room.projects[0] : undefined);
    const multi = (room.projects?.length ?? 0) > 1;
    return p ? { key: `p:${p.id}`, label: multi ? `${room.name} · ${p.name}` : room.name, roomId: room.id, projectId: p.id, floorId: room.floorId } : { key: `r:${room.id}`, label: room.name, roomId: room.id, floorId: room.floorId };
  };
  const get = (place: Place): DayProject => {
    let p = projects.get(place.key);
    if (!p) projects.set(place.key, (p = { place, workMs: 0, waitMs: 0, doneMs: 0, prompts: [], commits: [], events: [], tokens: zero(), cost: 0, agents: [] }));
    return p;
  };

  const byHour = Array.from({ length: 24 }, () => ({ work: 0, wait: 0 }));
  const waits: DayReport['longestWaits'] = [];
  for (const iv of o.intervals) {
    const ms = overlap(iv.from, iv.to, from, to);
    if (!ms) continue;
    const p = get(roomPlace(iv.roomId, iv.projectId));
    if (!p.agents.includes(iv.agent)) p.agents.push(iv.agent);
    if (iv.status === 'working') p.workMs += ms;
    else if (iv.status === 'waiting') p.waitMs += ms;
    else p.doneMs += ms;
    if (iv.status !== 'working') waits.push({ agent: iv.agent, place: p.place.label, ms, at: Math.max(iv.from, from), status: iv.status });
    // Minutos por hora (o intervalo pode atravessar várias horas).
    for (let h = 0; h < 24; h++) {
      const hs = from + h * 3600_000;
      const m = overlap(iv.from, iv.to, hs, hs + 3600_000) / 60_000;
      if (!m) continue;
      if (iv.status === 'working') byHour[h].work += m;
      else byHour[h].wait += m;
    }
  }
  for (const pr of o.prompts) get(o.locate(pr.cwd)).prompts.push({ text: pr.text, at: pr.at });
  for (const [key, list] of Object.entries(o.commits)) {
    const p = [...projects.values()].find((x) => x.place.key === key) ?? (() => {
      const room = o.rooms.find((r) => r.projects?.some((x) => `p:${x.id}` === key));
      const proj = room?.projects?.find((x) => `p:${x.id}` === key);
      return room && proj ? get(roomPlace(room.id, proj.id)) : undefined;
    })();
    if (p) p.commits.push(...list);
  }
  for (const ev of o.events) if (ev.at >= from && ev.at < to) get(roomPlace(ev.roomId)).events.push({ text: ev.event, at: ev.at });
  for (const r of o.records) {
    const p = get(o.locate(r.cwd));
    const t = tokensOf(r);
    p.tokens.input += t.input;
    p.tokens.output += t.output;
    p.tokens.cacheWrite += t.cacheWrite;
    p.tokens.cacheRead += t.cacheRead;
    const price = priceFor(r.model, o.prices);
    if (price) p.cost += costOf(r, price);
  }

  const list = [...projects.values()]
    .filter((p) => p.workMs || p.waitMs || p.doneMs || p.prompts.length || p.commits.length || p.events.length || totalTokens(p.tokens))
    .sort((a, b) => b.workMs + b.prompts.length * 60_000 - (a.workMs + a.prompts.length * 60_000));
  const sum = (f: (p: DayProject) => number) => list.reduce((s, p) => s + f(p), 0);
  return {
    date: o.date,
    totals: {
      workMs: sum((p) => p.workMs),
      waitMs: sum((p) => p.waitMs),
      doneMs: sum((p) => p.doneMs),
      prompts: sum((p) => p.prompts.length),
      commits: sum((p) => p.commits.length),
      tokens: sum((p) => totalTokens(p.tokens)),
      cost: sum((p) => p.cost),
    },
    byHour,
    projects: list,
    longestWaits: waits.sort((a, b) => b.ms - a.ms).slice(0, 5),
  };
}

/** O texto que vai para o Claude resumir um projeto: pedidos, commits e eventos, sem o resto. */
export function projectDigest(p: DayProject): string {
  const lines = [`Projeto: ${p.place.label}`];
  if (p.prompts.length) lines.push('Pedidos:', ...p.prompts.slice(0, 40).map((x) => `- ${x.text.replace(/\s+/g, ' ').slice(0, 300)}`));
  if (p.commits.length) lines.push('Commits:', ...p.commits.slice(0, 30).map((c) => `- ${c.subject}`));
  if (p.events.length) lines.push('Eventos:', ...p.events.map((e) => `- ${e.text}`));
  return lines.join('\n');
}

/** "2 h 15", "45 min", "—". */
export function hoursMinutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (!m) return '—';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
