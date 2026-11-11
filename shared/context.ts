// Política de contexto grande. Uma conversa de centenas de milhares de tokens é barata enquanto o
// cache dela vale (a releitura sai a 0,1× a entrada) e cara depois que ele expira (ela é regravada
// inteira, a 2× a entrada: 841 mil tokens no Opus 5.5 custam ~US$ 6,70 por mensagem). Então:
//   1. ao terminar um pedido com o contexto grande e o cache quente, o agente grava o que importa
//      (decisões, o que foi feito, o que falta) enquanto isso ainda é barato (hook Stop);
//   2. na volta, com o cache frio, o padrão é uma sessão nova que começa com um dossiê montado
//      pelo escritório (sem gastar modelo) e o caminho do transcript antigo (hook SessionStart);
//      retomar a conversa inteira continua possível, com o custo de cada opção na tela.
// Usado pelo servidor (que decide) e pela interface (que mostra a escolha).

import type { Price } from './usage.ts';

/** avisar: mostra a escolha na volta · automatico: volta já em sessão nova · desligado: como o Claude Code. */
export type ContextPolicy = 'avisar' | 'automatico' | 'desligado';
export const CONTEXT_POLICIES: ContextPolicy[] = ['avisar', 'automatico', 'desligado'];
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = 'avisar';

/** A partir daqui o contexto é "grande". */
export const CONTEXT_LIMIT = 500_000;
/** Validade do cache do Claude Code (assinaturas gravam o de 1 h; quem grava só o de 5 min usa 5 min). */
export const CACHE_TTL_MS = 60 * 60 * 1000;
export const CACHE_TTL_5M_MS = 5 * 60 * 1000;
/** Tamanho aproximado de uma sessão nova: prompt de sistema, ferramentas, instruções e o dossiê. */
export const FRESH_TOKENS = 30_000;

export function validPolicy(p: unknown): p is ContextPolicy {
  return typeof p === 'string' && (CONTEXT_POLICIES as string[]).includes(p);
}

/** Tamanho da conversa na última resposta, tirado do `usage` dela no transcript. */
export interface ContextState {
  tokens: number;
  /** Quando foi a última resposta (ms). */
  lastAt: number;
  /** Quanto o cache dela vale. */
  ttlMs: number;
  model: string;
}

/**
 * Lê as linhas finais de um transcript e acha a última resposta principal (não a de um ajudante)
 * com uso. O contexto é tudo que entrou nela mais o que ela escreveu (que entra na próxima).
 */
export function contextFromLines(lines: string[]): ContextState | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"usage"')) continue;
    let d: any;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    const m = d?.message;
    const u = m?.usage;
    if (d?.type !== 'assistant' || !u || d.isSidechain || m.model === '<synthetic>') continue;
    const ts = Date.parse(d.timestamp);
    if (!Number.isFinite(ts)) continue;
    const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
    const tokens = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens);
    const only5m = u.cache_creation && n(u.cache_creation.ephemeral_5m_input_tokens) > 0 && !n(u.cache_creation.ephemeral_1h_input_tokens);
    return { tokens, lastAt: ts, ttlMs: only5m ? CACHE_TTL_5M_MS : CACHE_TTL_MS, model: String(m.model ?? '') };
  }
  return undefined;
}

export const isLarge = (s: ContextState | undefined) => !!s && s.tokens >= CONTEXT_LIMIT;
export const cacheWarm = (s: ContextState, now: number) => now - s.lastAt < s.ttlMs;

/**
 * Ao terminar um pedido (Stop): pedir para gravar a memória? Só com o contexto grande e o cache
 * quente (gravar com o cache frio já paga a releitura), uma vez por travessia do limite, e nunca
 * quando o próprio Stop já é a continuação de um pedido nosso (stop_hook_active).
 */
export function shouldSaveOnStop(o: { state: ContextState | undefined; policy: ContextPolicy; saved: boolean; stopHookActive: boolean; now: number }): boolean {
  if (o.policy === 'desligado' || o.saved || o.stopHookActive || !o.state) return false;
  return isLarge(o.state) && cacheWarm(o.state, o.now);
}

/** O `reason` do Stop bloqueado: o que o agente faz antes de parar de vez. */
export function saveReason(o: { memory: boolean; file: string; tokens: number }): string {
  const k = Math.round(o.tokens / 1000);
  return [
    `[AI Office] Esta conversa passou de ${k} mil tokens. Enquanto o cache dela ainda vale, registre o que uma sessão nova precisaria saber para continuar sem reler tudo:`,
    '- as decisões tomadas e o porquê;',
    '- o que foi feito (arquivos, branches, PRs, comandos importantes);',
    '- o que falta, na ordem, e qualquer pegadinha descoberta.',
    `Grave isso em markdown, curto e direto, no arquivo ${o.file} (substitua o que houver).`,
    o.memory ? 'Grave também no ai-memory (memory_write_page) o que valer para os outros agentes do projeto.' : '',
    'Depois responda só "Memória gravada." e pare. Não continue a tarefa.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** O que fazer na volta de um agente: retomar a conversa, perguntar, ou já abrir uma sessão nova. */
export type ReturnChoice = 'retomar' | 'perguntar' | 'nova';

export function returnChoice(state: ContextState | undefined, policy: ContextPolicy, now: number): ReturnChoice {
  if (policy === 'desligado' || !state || !isLarge(state) || cacheWarm(state, now)) return 'retomar';
  return policy === 'automatico' ? 'nova' : 'perguntar';
}

/**
 * Custo estimado (USD, equivalente na API) da próxima mensagem em cada caminho: retomar com o cache
 * frio regrava a conversa inteira; a sessão nova grava só o começo. Sem preço do modelo: undefined.
 */
export function returnCosts(state: ContextState, price: Price | undefined): { retomar: number; nova: number } | undefined {
  if (!price) return undefined;
  const write = state.ttlMs === CACHE_TTL_5M_MS ? price.cacheWrite5m : price.cacheWrite1h;
  return { retomar: (state.tokens * write) / 1e6, nova: (FRESH_TOKENS * write) / 1e6 };
}

// ---------- dossiê da sessão nova ----------

/** O que dá para tirar do transcript sem modelo: os últimos pedidos e a última resposta. */
export function transcriptDigest(lines: string[], maxPrompts = 8): { prompts: string[]; lastAnswer?: string } {
  const prompts: string[] = [];
  let lastAnswer: string | undefined;
  for (const l of lines) {
    let d: any;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    if (d?.isSidechain || d?.isMeta) continue;
    const c = d?.message?.content;
    if (d?.type === 'user') {
      const text = typeof c === 'string' ? c : Array.isArray(c) && c.every((b: any) => b?.type === 'text') ? c.map((b: any) => b.text).join('\n') : '';
      // Comandos e avisos do próprio Claude Code (<command-name>, <local-command-...>, <system-reminder>) não são pedidos.
      if (text.trim() && !/^\s*</.test(text) && !text.startsWith('[AI Office]')) prompts.push(text.trim());
    } else if (d?.type === 'assistant' && Array.isArray(c)) {
      const text = c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim();
      if (text) lastAnswer = text;
    }
  }
  return { prompts: prompts.slice(-maxPrompts), ...(lastAnswer ? { lastAnswer } : {}) };
}

export interface Dossier {
  agentName: string;
  transcript: string;
  /** O que o agente gravou ao passar do limite (o arquivo do Stop bloqueado), se gravou. */
  saved?: string;
  savedFile?: string;
  prompts: string[];
  lastAnswer?: string;
  todos: { content: string; status: string }[];
  branch?: string;
  files: string[];
  memory: boolean;
  tokens?: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** O texto que a sessão nova recebe no SessionStart (additionalContext). */
export function dossierText(d: Dossier): string {
  const out: string[] = [
    `# Continuação: resumo do escritório para ${d.agentName}`,
    '',
    `Esta é uma sessão nova que continua uma conversa grande${d.tokens ? ` (${Math.round(d.tokens / 1000)} mil tokens)` : ''}, aberta assim para não reler tudo com o cache expirado. O resumo abaixo foi montado pelo AI Office sem usar modelo.`,
    `O transcript completo da conversa anterior está em ${d.transcript} (JSONL). Para um detalhe pontual, busque nele com grep em vez de lê-lo inteiro.`,
  ];
  if (d.memory) out.push('O ai-memory do projeto também tem o que foi gravado (memory_query).');
  if (d.saved?.trim()) out.push('', `## O que o agente gravou antes de parar${d.savedFile ? ` (${d.savedFile})` : ''}`, '', clip(d.saved.trim(), 12_000));
  const open = d.todos.filter((t) => t.status !== 'completed');
  if (open.length) out.push('', '## Tarefas abertas', '', ...open.map((t) => `- [${t.status === 'in_progress' ? 'em andamento' : 'pendente'}] ${t.content}`));
  if (d.prompts.length) out.push('', '## Últimos pedidos do usuário (do mais antigo ao mais novo)', '', ...d.prompts.map((p) => `- ${clip(p.replace(/\s+/g, ' '), 600)}`));
  if (d.lastAnswer) out.push('', '## Última resposta', '', clip(d.lastAnswer, 4000));
  if (d.branch || d.files.length) {
    out.push('', '## Git', '');
    if (d.branch) out.push(`Branch: ${d.branch}`);
    if (d.files.length) out.push(`Arquivos alterados e não commitados: ${d.files.slice(0, 40).join(', ')}${d.files.length > 40 ? ` (+${d.files.length - 40})` : ''}`);
  }
  return out.join('\n');
}

/** A primeira mensagem da sessão nova, digitada pelo escritório. */
export const FRESH_PROMPT = 'Resuma em poucas linhas o que você sabe do trabalho em andamento (pelo resumo do escritório) e o que falta, e pergunte como seguir.';
