// Modelos por projeto: como a escolha vira argumentos e variáveis do `claude`, e o que se pode
// escolher. Usado pelo servidor (ao abrir a sessão e ao validar) e pela interface (sugestões).
//
// Raciocínio + execução usa o modo `opusplan` do Claude Code: no modo de planejamento ele usa o
// modelo do alias "opus", e na execução o do alias "sonnet". As variáveis ANTHROPIC_DEFAULT_OPUS_MODEL
// e ANTHROPIC_DEFAULT_SONNET_MODEL trocam o que cada alias quer dizer, então valem qualquer modelo.

import type { ProjectModels } from './types.ts';

export type AgentKind = 'claude' | 'codex' | 'antigravity';

export interface ModelGroup {
  label: string;
  models: string[];
  disabled?: boolean;
}

/** Sugestões nos campos de modelo do projeto. */
export const MODEL_GROUPS: ModelGroup[] = [
  {
    label: 'Anthropic',
    // Só os nomes exatos dos modelos atuais. Um apelido do Claude Code ("opus", "sonnet[1m]") ainda
    // entra pelo "Outro modelo…".
    models: ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  },
  { label: 'OpenAI', models: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'] },
  {
    label: 'Google · Antigravity',
    models: [
      'gemini-4-neon',
      'gemini-4-carbon',
      'gemini-4-argon',
      'gemini-4-hydrogen',
      'gemini-pro-orchestrator-neon',
      'gemini-pro-orchestrator',
      'gemini-pro-orchestrator-argon',
      'gemini-3.8-flash',
    ],
  },
];

export function isAntigravityModel(model: string): boolean {
  return /^gemini-/i.test(model) || /^gpt-oss-/i.test(model) || /^claude-.+-(?:low|medium|high|xhigh|max)$/i.test(model);
}

export function isCodexModel(model: string): boolean {
  return /^(?:gpt-(?!oss-)|codex-|o\d(?:-|$))/i.test(model);
}

/** Aplica ao agente os modelos compatíveis que foram escolhidos no projeto. */
export function modelsForAgent(models: ProjectModels | undefined, kind: AgentKind): ProjectModels | undefined {
  if (!models) return undefined;
  const compatible = (model: string | undefined): model is string => {
    if (!model) return false;
    if (kind === 'antigravity') return isAntigravityModel(model);
    if (kind === 'codex') return isCodexModel(model);
    return !isAntigravityModel(model) && !isCodexModel(model);
  };
  if (models.mode === 'unico') return compatible(models.model) ? models : undefined;
  if (kind === 'claude' && compatible(models.reasoning) && compatible(models.execution)) return models;
  const model = [models.execution, models.reasoning].find(compatible);
  return model ? { mode: 'unico', model } : undefined;
}

/** Nome de modelo aceito: letras, números, ponto, hífen, sublinhado e colchetes (ex.: "sonnet[1m]"). Nada que o shell interprete. */
export function validModelName(m: unknown): m is string {
  return typeof m === 'string' && /^[A-Za-z0-9._\-[\]]{1,80}$/.test(m);
}

/** Confere e limpa o que veio da rede. undefined = voltar ao padrão da conta; null = inválido. */
export function parseModels(raw: unknown): ProjectModels | undefined | null {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  if (r.mode === 'unico') {
    const model = clean(r.model);
    if (!model) return undefined;
    return validModelName(model) ? { mode: 'unico', model } : null;
  }
  if (r.mode === 'duplo') {
    const reasoning = clean(r.reasoning);
    const execution = clean(r.execution);
    if (!reasoning || !execution) return null;
    return validModelName(reasoning) && validModelName(execution) ? { mode: 'duplo', reasoning, execution } : null;
  }
  return null;
}

/** Argumentos e variáveis do `claude` para os modelos do projeto. */
export function modelLaunch(m: ProjectModels | undefined): { args: string[]; env: Record<string, string> } {
  if (m?.mode === 'unico' && m.model && validModelName(m.model)) return { args: ['--model', m.model], env: {} };
  if (m?.mode === 'duplo' && validModelName(m.reasoning) && validModelName(m.execution)) {
    return {
      args: ['--model', 'opusplan'],
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: m.reasoning, ANTHROPIC_DEFAULT_SONNET_MODEL: m.execution },
    };
  }
  return { args: [], env: {} };
}

/** Texto curto para o painel e as abas: "opus", "opus → sonnet" ou "padrão da conta". */
export function modelsLabel(m: ProjectModels | undefined): string {
  if (m?.mode === 'unico' && m.model) return m.model;
  if (m?.mode === 'duplo' && m.reasoning && m.execution) return `${m.reasoning} → ${m.execution}`;
  return 'padrão da conta';
}
