import { describe, expect, it } from 'vitest';
import {
  CACHE_TTL_5M_MS,
  CACHE_TTL_MS,
  CONTEXT_LIMIT,
  contextFromLines,
  dossierText,
  returnChoice,
  returnCosts,
  saveReason,
  shouldSaveOnStop,
  transcriptDigest,
} from '../shared/context.ts';
import { DEFAULT_PRICES } from '../shared/usage.ts';

const T0 = Date.parse('2026-11-11T12:00:00Z');
const assistant = (tokens: number, at = T0, extra: Record<string, unknown> = {}, cache: Record<string, number> = { ephemeral_1h_input_tokens: 100 }) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    ...extra,
    message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: tokens - 125, output_tokens: 20, cache_creation: cache }, content: [{ type: 'text', text: 'ok' }] },
  });
const user = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', ...extra, message: { role: 'user', content } });

describe('contexto grande: tamanho e cache', () => {
  it('o tamanho é o da última resposta principal (entrada, cache e saída); ajudantes não contam', () => {
    const s = contextFromLines([assistant(300_000), assistant(600_000, T0 + 1000), assistant(10_000, T0 + 2000, { isSidechain: true }), user('oi')]);
    expect(s).toEqual({ tokens: 600_000, lastAt: T0 + 1000, ttlMs: CACHE_TTL_MS, model: 'claude-opus-5-5' });
    expect(contextFromLines([user('oi'), 'lixo'])).toBeUndefined();
  });

  it('quem grava só o cache de 5 min tem o cache valendo 5 min', () => {
    expect(contextFromLines([assistant(1000, T0, {}, { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 })])?.ttlMs).toBe(CACHE_TTL_5M_MS);
  });

  it('Stop: grava só com o contexto grande e o cache quente, uma vez, e nunca na continuação do próprio pedido', () => {
    const big = { tokens: CONTEXT_LIMIT, lastAt: T0, ttlMs: CACHE_TTL_MS, model: 'x' };
    const base = { state: big, policy: 'avisar' as const, saved: false, stopHookActive: false, now: T0 + 60_000 };
    expect(shouldSaveOnStop(base)).toBe(true);
    expect(shouldSaveOnStop({ ...base, policy: 'automatico' })).toBe(true);
    expect(shouldSaveOnStop({ ...base, policy: 'desligado' })).toBe(false);
    expect(shouldSaveOnStop({ ...base, saved: true })).toBe(false);
    expect(shouldSaveOnStop({ ...base, stopHookActive: true })).toBe(false);
    expect(shouldSaveOnStop({ ...base, state: { ...big, tokens: CONTEXT_LIMIT - 1 } })).toBe(false);
    expect(shouldSaveOnStop({ ...base, now: T0 + CACHE_TTL_MS })).toBe(false);
    expect(shouldSaveOnStop({ ...base, state: undefined })).toBe(false);
  });

  it('o pedido de gravação aponta o arquivo e, com o ai-memory, pede para gravar lá também', () => {
    const r = saveReason({ memory: true, file: '/x/a1.md', tokens: 612_400 });
    expect(r).toContain('612 mil tokens');
    expect(r).toContain('no arquivo /x/a1.md');
    expect(r).toContain('memory_write_page');
    expect(saveReason({ memory: false, file: '/x/a1.md', tokens: 1 })).not.toContain('ai-memory');
  });

  it('na volta: retomar com o cache quente ou a conversa pequena; com o frio, perguntar (avisar) ou sessão nova (automático)', () => {
    const big = { tokens: 841_000, lastAt: T0, ttlMs: CACHE_TTL_MS, model: 'x' };
    const cold = T0 + 2 * CACHE_TTL_MS;
    expect(returnChoice(big, 'avisar', T0 + 1000)).toBe('retomar');
    expect(returnChoice(big, 'avisar', cold)).toBe('perguntar');
    expect(returnChoice(big, 'automatico', cold)).toBe('nova');
    expect(returnChoice(big, 'desligado', cold)).toBe('retomar');
    expect(returnChoice({ ...big, tokens: 100_000 }, 'automatico', cold)).toBe('retomar');
    expect(returnChoice(undefined, 'automatico', cold)).toBe('retomar');
  });

  it('custo: retomar regrava a conversa inteira no cache; 841 mil no Opus 5.5 ≈ US$ 6,73', () => {
    const c = returnCosts({ tokens: 841_000, lastAt: T0, ttlMs: CACHE_TTL_MS, model: 'claude-opus-5-5' }, DEFAULT_PRICES['claude-opus-5-5'])!;
    expect(c.retomar).toBeCloseTo(6.728, 3);
    expect(c.nova).toBeCloseTo(0.24, 3);
    const five = returnCosts({ tokens: 1_000_000, lastAt: T0, ttlMs: CACHE_TTL_5M_MS, model: 'x' }, DEFAULT_PRICES['claude-opus-5-5'])!;
    expect(five.retomar).toBeCloseTo(5, 3);
    expect(returnCosts({ tokens: 1, lastAt: T0, ttlMs: CACHE_TTL_MS, model: 'x' }, undefined)).toBeUndefined();
  });
});

describe('contexto grande: dossiê da sessão nova', () => {
  it('pedidos de verdade (sem resultados de ferramenta, comandos, ajudantes ou o nosso pedido de gravação) e a última resposta', () => {
    const lines = [
      user('primeiro pedido'),
      user([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]),
      user('<command-name>/clear</command-name>'),
      user('do ajudante', { isSidechain: true }),
      user('[AI Office] Esta conversa passou de 600 mil tokens'),
      user([{ type: 'text', text: 'segundo pedido' }]),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'última resposta' }] } }),
      'quebrado {',
    ];
    expect(transcriptDigest(lines)).toEqual({ prompts: ['primeiro pedido', 'segundo pedido'], lastAnswer: 'última resposta' });
    expect(transcriptDigest(Array.from({ length: 12 }, (_, i) => user(`p${i}`)), 3).prompts).toEqual(['p9', 'p10', 'p11']);
  });

  it('o texto traz o transcript antigo, o que foi gravado, tarefas abertas, pedidos, a resposta e o git', () => {
    const t = dossierText({
      agentName: 'Ana',
      transcript: '/c/projects/x/s1.jsonl',
      saved: 'Decidimos SQLite.',
      savedFile: '/d/contexto/a1.md',
      prompts: ['faz a migração'],
      lastAnswer: 'Pronto, falta o teste.',
      todos: [{ content: 'migração', status: 'completed' }, { content: 'teste', status: 'in_progress' }, { content: 'PR', status: 'pending' }],
      branch: 'feat/x',
      files: ['a.ts', 'b.ts'],
      memory: true,
      tokens: 841_000,
    });
    expect(t).toContain('# Continuação: resumo do escritório para Ana');
    expect(t).toContain('(841 mil tokens)');
    expect(t).toContain('/c/projects/x/s1.jsonl');
    expect(t).toContain('grep');
    expect(t).toContain('memory_query');
    expect(t).toContain('Decidimos SQLite.');
    expect(t).toContain('- [em andamento] teste');
    expect(t).toContain('- [pendente] PR');
    expect(t).not.toContain('] migração');
    expect(t).toContain('- faz a migração');
    expect(t).toContain('Pronto, falta o teste.');
    expect(t).toContain('Branch: feat/x');
    expect(t).toContain('a.ts, b.ts');
    const min = dossierText({ agentName: 'Bia', transcript: '/t.jsonl', prompts: [], todos: [], files: [], memory: false });
    expect(min).not.toContain('##');
    expect(min).not.toContain('ai-memory');
  });
});
