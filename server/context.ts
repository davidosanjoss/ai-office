// Política de contexto grande no servidor (a regra está em shared/context.ts): lê o tamanho da
// conversa no transcript, decide o hook Stop (gravar a memória enquanto o cache vale) e monta o
// dossiê que a sessão nova recebe no hook SessionStart.

import fs from 'node:fs';
import path from 'node:path';
import {
  type ContextPolicy,
  type ContextState,
  DEFAULT_CONTEXT_POLICY,
  contextFromLines,
  dossierText,
  isLarge,
  returnChoice,
  returnCosts,
  saveReason,
  shouldSaveOnStop,
  transcriptDigest,
} from '../shared/context.ts';
import { priceFor } from '../shared/usage.ts';
import type { Agent } from '../shared/types.ts';
import { findTranscript } from './discover.ts';
import { gitInfo } from './git.ts';
import { claudeWiring } from './memory.ts';
import { DATA_DIR } from './platform.ts';
import { store } from './store.ts';
import { prices } from './usage.ts';

/** Onde os agentes gravam o que importa ao passar do limite (entra com --add-dir nas sessões). */
export const CONTEXT_DIR = path.join(DATA_DIR, 'contexto');
export const savedFile = (agentId: string) => path.join(CONTEXT_DIR, `${agentId}.md`);
export const dossierFile = (agentId: string) => path.join(CONTEXT_DIR, `${agentId}-dossie.md`);

/** As últimas linhas completas de um arquivo (lê só o fim: transcripts passam de dezenas de MB). */
export function tailLines(file: string, bytes = 4 * 1024 * 1024): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function policyOf(agent: Agent): ContextPolicy {
  const room = store.rooms.get(agent.roomId);
  return store.floors.get(room?.floorId ?? '')?.defaults?.context ?? DEFAULT_CONTEXT_POLICY;
}

export function transcriptOf(agent: Agent, hint?: unknown): string | undefined {
  if (typeof hint === 'string' && hint && fs.existsSync(hint)) return hint;
  return findTranscript(agent.sessionId);
}

export function contextOf(agent: Agent, hint?: unknown): ContextState | undefined {
  const file = transcriptOf(agent, hint);
  return file ? contextFromLines(tailLines(file, 2 * 1024 * 1024)) : undefined;
}

/**
 * Hook Stop: a saída que bloqueia a parada e pede para gravar a memória, ou undefined. Abaixo do
 * limite, a marca de "já pediu" volta a zero (depois de um /compact, a próxima travessia pede de novo).
 */
export function stopDecision(agent: Agent, payload: Record<string, any>, now = Date.now()): object | undefined {
  if (agent.kind === 'shell') return undefined;
  const state = contextOf(agent, payload.transcript_path);
  if (!isLarge(state)) {
    if (agent.contextSaved) store.patchAgent(agent.id, { contextSaved: false });
    return undefined;
  }
  const save = shouldSaveOnStop({ state, policy: policyOf(agent), saved: !!agent.contextSaved, stopHookActive: payload.stop_hook_active === true, now });
  if (!save) return undefined;
  store.patchAgent(agent.id, { contextSaved: true, status: 'working', activity: 'Gravando o que importa antes de parar…' });
  store.log(agent.id, `🧠 Contexto em ${Math.round(state!.tokens / 1000)} mil tokens: ${agent.name} grava o que importa enquanto o cache vale`, 'system');
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  return { decision: 'block', reason: saveReason({ memory: claudeWiring().mcp, file: savedFile(agent.id), tokens: state!.tokens }) };
}

/** O que a interface mostra na volta de um agente. */
export function contextInfo(agent: Agent, now = Date.now()) {
  const state = agent.kind === 'shell' ? undefined : contextOf(agent);
  const policy = policyOf(agent);
  if (!state) return { policy, choice: 'retomar' as const };
  const costs = returnCosts(state, priceFor(state.model, prices()));
  return { policy, choice: returnChoice(state, policy, now), tokens: state.tokens, lastAt: state.lastAt, ttlMs: state.ttlMs, model: state.model, ...(costs ? { costs } : {}) };
}

/** Monta o dossiê da sessão nova (sem modelo) e o grava em ~/.ai-office/contexto para você ver. */
export async function buildDossier(agent: Agent): Promise<string> {
  const transcript = transcriptOf(agent) ?? '(a conversa anterior não chegou a ser salva)';
  const lines = fs.existsSync(transcript) ? tailLines(transcript) : [];
  const digest = transcriptDigest(lines);
  const git = await gitInfo(agent.cwd).catch(() => undefined);
  let saved: string | undefined;
  try {
    saved = fs.readFileSync(savedFile(agent.id), 'utf8');
  } catch {}
  const text = dossierText({
    agentName: agent.name,
    transcript,
    ...(saved ? { saved, savedFile: savedFile(agent.id) } : {}),
    prompts: digest.prompts,
    ...(digest.lastAnswer ? { lastAnswer: digest.lastAnswer } : {}),
    todos: agent.todos ?? [],
    ...(git?.branch ? { branch: git.branch } : {}),
    files: (git?.files ?? []).map((f) => f.path),
    memory: claudeWiring().mcp,
    tokens: contextFromLines(lines)?.tokens,
  });
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  fs.writeFileSync(dossierFile(agent.id), text);
  return text;
}

// A sessão nova recebe o dossiê no primeiro SessionStart dela.
const pending = new Map<string, { sessionId: string; text: string }>();

export function setPendingDossier(agentId: string, sessionId: string, text: string) {
  pending.set(agentId, { sessionId, text });
}

/** Hook SessionStart: o additionalContext com o dossiê, uma vez, só para a sessão nova. */
export function sessionStartOutput(agentId: string, sessionId: unknown): object | undefined {
  const p = pending.get(agentId);
  if (!p || (typeof sessionId === 'string' && sessionId && sessionId !== p.sessionId)) return undefined;
  pending.delete(agentId);
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: p.text } };
}
