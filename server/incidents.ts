// Sala de guerra: agentes de vários projetos do mesmo andar investigando um problema com você.
//
// Cada agente continua no próprio terminal e no próprio repositório. O escritório digita no
// terminal dele o convite e as suas mensagens (sempre uma linha só), guarda a resposta de cada um
// (lida do transcript no hook Stop) no chat da sala e escreve tudo num registro em markdown.
// Nada passa de um agente para outro sozinho: o repasse é sempre um clique seu.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Participant, invitation, parseMentions, recordMarkdown, sharedMessage, userMessage } from '../shared/incident.ts';
import type { Incident, IncidentMessage } from '../shared/types.ts';
import { createAgent, createShell, isRunning, removeAgent, resumeAgent, slugify, writeInput } from './agents.ts';
import { CLAUDE_DIR, DATA_DIR } from './platform.ts';
import { store } from './store.ts';

export const INCIDENTS_DIR = path.join(DATA_DIR, 'incidentes');
const MAX_MESSAGES = 400;
/** Depois do SessionStart, o Claude ainda está desenhando a tela: espera antes de digitar. */
const READY_DELAY_MS = 1500;
/** Entre digitar o texto e apertar Enter, para o Claude não tomar o Enter como parte de uma colagem. */
const ENTER_DELAY_MS = 200;

export class IncidentError extends Error {}

/** Mensagens esperando o agente ficar livre (ele estava trabalhando ou pedindo permissão). */
const queues = new Map<string, string[]>();

// ---------- abrir, chamar, encerrar ----------

export interface OpenIncident {
  floorId: string;
  slot: number;
  title: string;
  description?: string;
  /** Projetos (salas) de onde vem um agente novo. */
  roomIds?: string[];
  /** Agentes que já estão trabalhando e levam o contexto que têm. */
  agentIds?: string[];
}

export async function openIncident(req: OpenIncident): Promise<Incident> {
  const floor = store.floors.get(req.floorId);
  if (!floor) throw new IncidentError('Andar não encontrado');
  const title = String(req.title ?? '').trim();
  if (!title) throw new IncidentError('Dê um título ao incidente');
  const slot = Number(req.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot >= store.warRoomsOf(floor.id)) throw new IncidentError('Sala de guerra não encontrada');
  if (incidentAt(floor.id, slot)) throw new IncidentError('Já há um incidente nessa sala de guerra');
  const roomIds = ids(req.roomIds);
  const agentIds = ids(req.agentIds);
  if (!roomIds.length && !agentIds.length) throw new IncidentError('Chame pelo menos um projeto ou agente');
  checkCandidates(floor.id, roomIds, agentIds);

  const id = randomUUID().slice(0, 8);
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(INCIDENTS_DIR, `${day}-${slugify(title)}-${id}.md`);
  const incident: Incident = {
    id,
    floorId: floor.id,
    slot,
    title,
    description: String(req.description ?? '').trim(),
    createdAt: Date.now(),
    participants: [],
    messages: [],
    file,
  };
  store.putIncident(incident);
  await join(incident.id, roomIds, agentIds);
  // Um terminal comum já aberto, para rodar comandos sem sair da sala de guerra.
  openWarShell(incident.id);
  return store.incidents.get(id)!;
}

/**
 * Terminal comum da sala de guerra, na pasta do primeiro projeto que entrou. Não é participante:
 * não recebe as mensagens do chat.
 */
export function openWarShell(incidentId: string) {
  const incident = mustGet(incidentId);
  const roomId = incident.participants.map((id) => store.agents.get(id)?.roomId).find((r) => r && store.rooms.has(r));
  if (!roomId) throw new IncidentError('Nenhum projeto na sala de guerra para abrir o terminal');
  return createShell(roomId, { incidentId });
}

/** Chama mais gente para um incidente aberto. */
export async function addParticipants(incidentId: string, roomIds: unknown, agentIds: unknown) {
  const incident = mustGet(incidentId);
  if (!ids(roomIds).length && !ids(agentIds).length) throw new IncidentError('Escolha quem chamar');
  checkCandidates(incident.floorId, ids(roomIds), ids(agentIds));
  await join(incidentId, ids(roomIds), ids(agentIds));
  return store.incidents.get(incidentId)!;
}

/** Lista de ids vinda da rede: só strings, sem repetir. */
function ids(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : [];
}

function checkCandidates(floorId: string, roomIds: string[], agentIds: string[]) {
  for (const roomId of roomIds) {
    if (store.rooms.get(roomId)?.floorId !== floorId) throw new IncidentError('Só projetos deste andar podem entrar na sala de guerra');
  }
  for (const agentId of agentIds) {
    const a = store.agents.get(agentId);
    if (!a || a.kind === 'shell') throw new IncidentError('Agente não encontrado');
    if (store.rooms.get(a.roomId)?.floorId !== floorId) throw new IncidentError('Só agentes deste andar podem entrar na sala de guerra');
    if (a.incidentId) throw new IncidentError(`${a.name} já está numa sala de guerra`);
  }
}

async function join(incidentId: string, roomIds: string[], agentIds: string[]) {
  const joined: string[] = [];
  for (const roomId of roomIds) {
    const agent = await createAgent(roomId, { incidentId });
    joined.push(agent.id);
  }
  for (const agentId of agentIds) {
    const agent = store.agents.get(agentId)!;
    store.patchAgent(agentId, { incidentId });
    store.log(agentId, `${agent.name} foi para a sala de guerra`, 'system');
    // Quem estava fora do escritório volta, já com o convite na fila.
    if (agent.status === 'exited') resumeAgent(agentId);
    joined.push(agentId);
  }
  const incident = mustGet(incidentId);
  incident.participants.push(...joined.filter((id) => !incident.participants.includes(id)));
  const names = joined.map((id) => store.agents.get(id)!.name).join(', ');
  addMessage(incident, { kind: 'sistema', to: [], text: `Entraram na sala: ${names}` });
  for (const agentId of joined) deliver(agentId, invitation(incident, participant(agentId)));
}

/** Encerra: o registro vira post-mortem, quem veio só para o incidente vai embora e os outros voltam para a mesa. */
export function closeIncident(incidentId: string, resolution = '') {
  const incident = mustGet(incidentId);
  addMessage(incident, { kind: 'sistema', to: [], text: 'Incidente encerrado' }, false);
  writeRecord(incident, { at: Date.now(), resolution: resolution.trim() });
  for (const agentId of incident.participants) {
    queues.delete(agentId);
    const agent = store.agents.get(agentId);
    if (!agent) continue;
    if (agent.forIncident) removeAgent(agentId);
    else {
      store.patchAgent(agentId, { incidentId: undefined });
      store.log(agentId, `${agent.name} voltou da sala de guerra`, 'system');
    }
  }
  // Os terminais da sala de guerra fecham junto.
  for (const a of [...store.agents.values()]) if (a.kind === 'shell' && a.incidentId === incidentId) removeAgent(a.id);
  store.removeIncident(incidentId);
  return { file: incident.file };
}

/** Um participante saiu do escritório (demitido ou a sala dele fechou): sai da sala de guerra também. */
export function leaveIncidents(agentId: string) {
  queues.delete(agentId);
  for (const incident of store.incidents.values()) {
    if (!incident.participants.includes(agentId)) continue;
    const name = store.agents.get(agentId)?.name ?? 'Um agente';
    incident.participants = incident.participants.filter((id) => id !== agentId);
    addMessage(incident, { kind: 'sistema', to: [], text: `${name} saiu da sala` });
  }
}

// ---------- conversa ----------

/** Sua mensagem: para todos, ou só para quem você chamou com @nome ou @projeto. */
export function sendMessage(incidentId: string, text: string) {
  const incident = mustGet(incidentId);
  const body = String(text ?? '').trim();
  if (!body) throw new IncidentError('Escreva a mensagem');
  const people = incident.participants.map(participant);
  const { to, unknown } = parseMentions(body, people);
  if (unknown.length) throw new IncidentError(`Ninguém na sala se chama @${unknown[0]}`);
  const targets = to.length ? to : incident.participants;
  if (!targets.length) throw new IncidentError('Não há ninguém na sala');
  const message = addMessage(incident, { kind: 'voce', to, text: body });
  for (const agentId of targets) deliver(agentId, userMessage(body, !to.length));
  return message;
}

/** Repassa a resposta de um agente para os outros participantes. */
export function shareMessage(incidentId: string, messageId: number) {
  const incident = mustGet(incidentId);
  const original = incident.messages.find((m) => m.id === messageId);
  if (!original || original.kind !== 'agente' || !original.agentId) throw new IncidentError('Só dá para repassar a resposta de um agente');
  const others = incident.participants.filter((id) => id !== original.agentId);
  if (!others.length) throw new IncidentError('Não há outros agentes na sala');
  const from = participant(original.agentId);
  const message = addMessage(incident, { kind: 'repasse', agentId: original.agentId, to: others, text: original.text });
  for (const agentId of others) deliver(agentId, sharedMessage(from, original.text));
  return message;
}

// ---------- hooks ----------

/** O Claude abriu: depois de um instante, digita o que estiver na fila. */
export function onSessionStart(agentId: string) {
  if (queues.get(agentId)?.length) setTimeout(() => flush(agentId), READY_DELAY_MS);
}

/** O agente terminou de responder: a resposta vai para o chat e a próxima mensagem da fila é digitada. */
export function onStop(agentId: string, payload: Record<string, unknown>) {
  const agent = store.agents.get(agentId);
  const incident = agent?.incidentId ? store.incidents.get(agent.incidentId) : undefined;
  if (incident) {
    const text = replyFrom(payload);
    if (text) addMessage(incident, { kind: 'agente', agentId, to: [], text });
  }
  flush(agentId);
}

/** A última resposta: o campo do hook, se a versão do Claude manda, ou o fim do transcript. */
function replyFrom(payload: Record<string, unknown>): string {
  if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) return payload.last_assistant_message.trim();
  const file = typeof payload.transcript_path === 'string' ? path.resolve(payload.transcript_path) : '';
  // Só lê transcripts do próprio Claude, nunca um caminho qualquer vindo da rede.
  if (!file || !file.startsWith(path.resolve(CLAUDE_DIR) + path.sep) || !file.endsWith('.jsonl') || !fs.existsSync(file)) return '';
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, 2_000_000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return lastAssistantText(buf.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Texto final do agente no transcript (JSONL do Claude Code): os blocos de texto depois da última
 * ferramenta usada. As mensagens intermediárias ("vou ler o arquivo…") ficam de fora.
 */
export function lastAssistantText(jsonl: string): string {
  const parts: string[] = [];
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (entry?.type === 'user') break;
    if (entry?.type !== 'assistant') continue;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (blocks.some((b: any) => b?.type === 'tool_use')) break;
    const text = blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
    if (text.trim()) parts.unshift(text.trim());
  }
  return parts.join('\n\n');
}

// ---------- entrega ----------

/** Digita no terminal do agente agora, se ele está livre; senão, quando ele terminar o que está fazendo. */
function deliver(agentId: string, text: string) {
  const queue = queues.get(agentId) ?? [];
  queue.push(text);
  queues.set(agentId, queue);
  flush(agentId);
}

function flush(agentId: string) {
  const agent = store.agents.get(agentId);
  const queue = queues.get(agentId);
  if (!agent || !queue?.length || !isRunning(agentId)) return;
  if (agent.status !== 'idle' && agent.status !== 'done') return;
  const text = queue.shift()!;
  // Ocupado a partir de agora: a próxima mensagem espera o Stop desta.
  store.patchAgent(agentId, { status: 'working', activity: 'Lendo a sala de guerra…', attentionAt: undefined });
  writeInput(agentId, text);
  setTimeout(() => writeInput(agentId, '\r'), ENTER_DELAY_MS);
}

// ---------- registro ----------

function participant(agentId: string): Participant {
  const agent = store.agents.get(agentId);
  return { id: agentId, name: agent?.name ?? 'agente', project: store.rooms.get(agent?.roomId ?? '')?.name ?? '?' };
}

function addMessage(incident: Incident, m: Omit<IncidentMessage, 'id' | 'ts'>, publish = true): IncidentMessage {
  const message: IncidentMessage = { id: (incident.messages.at(-1)?.id ?? 0) + 1, ts: Date.now(), ...m };
  incident.messages.push(message);
  if (incident.messages.length > MAX_MESSAGES) incident.messages.splice(0, incident.messages.length - MAX_MESSAGES);
  if (publish) {
    writeRecord(incident);
    store.putIncident({ ...incident });
  }
  return message;
}

function writeRecord(incident: Incident, closed?: { at: number; resolution: string }) {
  // Quem falou e já saiu continua com nome no registro.
  const ids = new Set([...incident.participants, ...incident.messages.flatMap((m) => (m.agentId ? [m.agentId] : []))]);
  const people = [...ids].filter((id) => store.agents.has(id)).map(participant);
  fs.mkdirSync(path.dirname(incident.file), { recursive: true });
  fs.writeFileSync(incident.file, recordMarkdown(incident, people, closed));
}

function mustGet(id: string): Incident {
  const incident = store.incidents.get(id);
  if (!incident) throw new IncidentError('Incidente não encontrado');
  return incident;
}

export function incidentAt(floorId: string, slot: number): Incident | undefined {
  return [...store.incidents.values()].find((i) => i.floorId === floorId && i.slot === slot);
}
