// Regras de decisão da interface, sem DOM, para poderem ser testadas.

import type { Agent } from '../shared/types.ts';

/** Depois da última tecla, quanto esperar antes de trocar de terminal sozinho. */
export const TYPING_GRACE_MS = 3500;
/** Um agente parado sem você digitar nele por esse tempo libera o foco automático. */
export const IDLE_RELEASE_MS = 20_000;

export function roomAgents(agents: Agent[], roomId?: string): Agent[] {
  return agents.filter((a) => a.roomId === roomId).sort((a, b) => a.createdAt - b.createdAt);
}

/** Funcionários do escritório: terminais comuns só aparecem como abas. */
export function officeAgents(agents: Agent[]): Agent[] {
  return agents.filter((a) => a.kind !== 'shell');
}

export function needsAttention(a: Agent): boolean {
  return (a.status === 'done' || a.status === 'waiting') && !!a.attentionAt;
}

/** Agentes que terminaram ou pediram aprovação, do mais antigo para o mais novo. */
export function attentionQueue(agents: Agent[]): Agent[] {
  return agents.filter(needsAttention).sort((a, b) => a.attentionAt! - b.attentionAt!);
}

export interface FocusInput {
  agents: Agent[];
  selectedId?: string;
  enabled: boolean;
  now: number;
  lastKeyAt: number;
  selectedAt: number;
}

/**
 * Para quem o foco automático deve ir agora, ou undefined para ficar onde está.
 * Só troca quando o agente atual não precisa de você: está trabalhando, encerrado,
 * abrindo, ou parado há um tempo sem você digitar. Nunca troca enquanto você digita
 * nem enquanto você lê um agente que acabou de terminar.
 */
export function nextAutoFocus(f: FocusInput): string | undefined {
  if (!f.enabled || f.now - f.lastKeyAt < TYPING_GRACE_MS) return undefined;
  const current = f.agents.find((a) => a.id === f.selectedId);
  if (current) {
    const quietFor = f.now - Math.max(f.lastKeyAt, f.selectedAt);
    const free = current.status === 'working' || current.status === 'exited' || current.status === 'starting';
    if (!free && !(current.status === 'idle' && quietFor > IDLE_RELEASE_MS)) return undefined;
  }
  return attentionQueue(f.agents).find((a) => a.id !== f.selectedId)?.id;
}

/** Status entrou agora em "terminou" ou "pediu aprovação" (para avisar uma vez só). */
export function becameAttention(prev: Agent | undefined, next: Agent): boolean {
  const needs = next.status === 'done' || next.status === 'waiting';
  return needs && prev?.status !== next.status;
}

export function exitedMessage(a: Agent): string {
  if (a.kind === 'shell') return `${a.name} foi encerrado quando o servidor reiniciou.`;
  if (a.activity.startsWith('Não conseguiu abrir')) return `${a.name} ${a.activity.charAt(0).toLowerCase()}${a.activity.slice(1)}`;
  const code = a.exitCode !== undefined ? ` (código ${a.exitCode})` : '';
  return `${a.name} saiu do escritório${code}. A conversa continua salva.`;
}

export function resumeLabel(a: Agent): string {
  return a.kind === 'shell' ? 'Reabrir terminal' : 'Retomar conversa';
}
