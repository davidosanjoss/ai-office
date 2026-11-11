// Sala viva (servidor): detecta nos hooks o que vira cena no mapa. Eventos do GitHub pelos
// comandos do Bash; comandos em segundo plano pelo backgroundTaskId, e o fim deles pelo
// <task-notification> que o Claude Code grava no transcript (lido aos poucos, só o que é novo).

import fs from 'node:fs';
import { PARTY_MS, elapsed, finishedShells, githubEvent, roomEffectFor } from '../shared/live.ts';
import type { Agent } from '../shared/types.ts';
import { findTranscript } from './discover.ts';
import { store } from './store.ts';
import { recordDayEvent } from './day.ts';

const SHELL_EFFECT_MS = 8_000;
/** Até onde o transcript de cada sessão já foi lido (só para os agentes com comando rodando). */
const offsets = new Map<string, number>();

/** PostToolUse do Bash: evento do GitHub para a sala e comando que ficou rodando em segundo plano. */
export function onPostToolUse(agent: Agent, payload: Record<string, any>) {
  if (payload.tool_name !== 'Bash') return;
  const input = payload.tool_input ?? {};
  const res = payload.tool_response ?? {};
  const command = String(input.command ?? '');
  const output = typeof res === 'string' ? res : `${res.stdout ?? ''}\n${res.stderr ?? ''}`;

  const bg = typeof res === 'object' ? res.backgroundTaskId : undefined;
  if (bg) {
    const shell = { id: String(bg), command: String(input.description || command).slice(0, 120), since: Date.now() };
    store.patchAgent(agent.id, { shells: [...(agent.shells ?? []).filter((s) => s.id !== shell.id), shell] });
    // Começa a ler o transcript do ponto atual: o fim do comando vem depois.
    const file = findTranscript(agent.sessionId);
    if (file && !offsets.has(agent.sessionId)) offsets.set(agent.sessionId, fileSize(file));
  }

  const ev = githubEvent(command, output);
  if (!ev) return;
  store.log(agent.id, `${ev.kind === 'ci-falhou' ? '🚨' : ev.kind === 'push' ? '🚀' : '🎉'} ${ev.text}`, 'system');
  recordDayEvent(agent.roomId, `${ev.kind === 'ci-falhou' ? '🚨' : ev.kind === 'push' ? '🚀' : '🎉'} ${ev.text}`);
  const room = store.rooms.get(agent.roomId);
  const effect = roomEffectFor(ev, Date.now());
  if (!room || !effect) return;
  // CI verde depois de um alarme: o alarme vira festa.
  store.putRoom({ ...room, effect: ev.kind === 'ci-ok' && room.effect?.kind !== 'alarme' ? { ...effect, until: Date.now() + PARTY_MS } : effect });
}

const fileSize = (f: string) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
};

/** Lê o que é novo nos transcripts dos agentes que esperam um comando e vê quais terminaram. */
export function checkShells() {
  for (const agent of store.agents.values()) {
    if (!agent.shells?.length) continue;
    const file = findTranscript(agent.sessionId);
    if (!file) continue;
    const size = fileSize(file);
    const from = Math.min(offsets.get(agent.sessionId) ?? 0, size);
    if (size === from) continue;
    const fd = fs.openSync(file, 'r');
    let chunk = '';
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      chunk = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // Só até a última linha completa: a seguinte pode estar sendo escrita.
    const end = chunk.lastIndexOf('\n') + 1;
    offsets.set(agent.sessionId, from + Buffer.byteLength(chunk.slice(0, end)));
    const done = finishedShells(chunk.slice(0, end)).filter((d) => agent.shells!.some((s) => s.id === d.id));
    if (!done.length) continue;
    const last = done.at(-1)!;
    const shell = agent.shells.find((s) => s.id === last.id)!;
    const took = elapsed(Date.now() - shell.since);
    const text = last.ok ? `${shell.command}: terminou (${took})` : `${shell.command}: falhou${last.code !== undefined ? ` (código ${last.code})` : ''}`;
    store.patchAgent(agent.id, {
      shells: agent.shells.filter((s) => !done.some((d) => d.id === s.id)),
      effect: { kind: last.ok ? 'ok' : 'falhou', text, until: Date.now() + SHELL_EFFECT_MS },
    });
    store.log(agent.id, `${last.ok ? '✅' : '🌧️'} ${text}`, 'system');
  }
}

/** O agente saiu: os comandos dele morreram junto. */
export function forgetShells(agentId: string) {
  const a = store.agents.get(agentId);
  if (a?.shells?.length) store.patchAgent(agentId, { shells: [] });
  if (a) offsets.delete(a.sessionId);
}

let timer: NodeJS.Timeout | undefined;
/** Confere os comandos em segundo plano a cada 2 s (só lê os transcripts de quem tem algum). */
export function startShellWatch() {
  timer ??= setInterval(checkShells, 2000);
  timer.unref?.();
}
