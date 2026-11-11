// Pedidos esperando resposta no escritório (permissões e perguntas dos agentes). O hook
// PermissionRequest registra o pedido e fica esperando a decisão (espera longa, em voltas de até
// 25 s); a interface mostra o cartão e responde. Sem nenhuma página do escritório aberta, o hook
// nem espera: o pedido segue pelo terminal, como sem o escritório.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { type PendingRequest, type RequestAnswer, hookOutput, requestFrom, requestSummary } from '../shared/permissions.ts';
import { store } from './store.ts';

const pending = new Map<string, PendingRequest>();
const answers = new Map<string, object>();
/** Avisa a interface quando a lista muda. */
export const requestEvents = new EventEmitter();
requestEvents.setMaxListeners(0);

let viewers = 0;
/** Páginas do escritório abertas (WebSockets): sem nenhuma, o pedido vai direto para o terminal. */
export function setViewers(n: number) {
  viewers = n;
}

export function pendingRequests(): PendingRequest[] {
  return [...pending.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function changed() {
  requestEvents.emit('change', pendingRequests());
}

/** O hook chegou: guarda o pedido e marca o agente como esperando você. undefined = siga pelo terminal. */
export function openRequest(agentId: string | undefined, payload: Record<string, unknown>): PendingRequest | undefined {
  const agent = agentId ? store.agents.get(agentId) : undefined;
  if (!agent || viewers === 0) return undefined;
  const req = requestFrom(randomUUID().slice(0, 8), agent.id, payload, Date.now());
  pending.set(req.id, req);
  store.patchAgent(agent.id, { status: 'waiting', activity: requestSummary(req), attentionAt: Date.now() });
  store.log(agent.id, `✋ ${requestSummary(req)}`, 'waiting');
  changed();
  return req;
}

/** Sua resposta no escritório. false = o pedido já não existe (respondido no terminal). */
export function answerRequest(id: string, answer: RequestAnswer): boolean {
  const req = pending.get(id);
  if (!req) return false;
  pending.delete(id);
  answers.set(id, hookOutput(req, answer));
  const name = store.agents.get(req.agentId)?.name ?? 'agente';
  store.log(req.agentId, answer.behavior === 'allow' ? `✔ Você permitiu pelo escritório: ${requestSummary(req)}` : `✖ Você negou pelo escritório: ${requestSummary(req)}`, 'system');
  if (store.agents.get(req.agentId)?.status === 'waiting') store.patchAgent(req.agentId, { status: 'working', activity: answer.behavior === 'allow' ? 'Continuando…' : `${name} recebeu o não`, attentionAt: undefined });
  changed();
  requestEvents.emit(`answer:${id}`);
  return true;
}

/**
 * O hook esperando a decisão: devolve a saída para o Claude Code, 'gone' se o pedido sumiu
 * (respondido no terminal, sessão encerrada) ou 'wait' depois de `ms` sem resposta.
 */
export function waitAnswer(id: string, ms: number): Promise<object | 'gone' | 'wait'> {
  const take = () => {
    const out = answers.get(id);
    if (out) answers.delete(id);
    return out;
  };
  const now = take();
  if (now) return Promise.resolve(now);
  if (!pending.has(id)) return Promise.resolve('gone');
  return new Promise((resolve) => {
    const done = (v: object | 'gone' | 'wait') => {
      clearTimeout(timer);
      requestEvents.off(`answer:${id}`, onAnswer);
      requestEvents.off(`gone:${id}`, onGone);
      resolve(v);
    };
    const onAnswer = () => done(take() ?? 'gone');
    const onGone = () => done('gone');
    const timer = setTimeout(() => done('wait'), ms);
    requestEvents.once(`answer:${id}`, onAnswer);
    requestEvents.once(`gone:${id}`, onGone);
  });
}

/** O hook desistiu (tempo esgotado) ou o agente seguiu adiante: o cartão some. */
export function dropRequest(id: string) {
  if (!pending.delete(id)) return;
  requestEvents.emit(`gone:${id}`);
  changed();
}

/**
 * O agente fez outra coisa (a ferramenta rodou, mandou mensagem, terminou, saiu): o pedido foi
 * respondido no terminal, e o cartão some.
 */
export function agentMovedOn(agentId: string) {
  for (const r of [...pending.values()]) if (r.agentId === agentId) dropRequest(r.id);
}

/** Só para os testes. */
export function resetRequests() {
  for (const id of [...pending.keys()]) dropRequest(id);
  answers.clear();
}
