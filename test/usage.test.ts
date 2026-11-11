import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PRICES, WINDOW_MS, costOf, livePlan, parsePlan, formatTokens, formatUsd, parseRecord, planWindows, priceFor, summarize, type UsageRecord } from '../shared/usage.ts';
import { claudeRecord, receiveRecords, resetUsage, usageRecords } from '../server/usage.ts';
import { transcriptLine } from './helpers.ts';

const rec = (patch: Partial<UsageRecord>): UsageRecord => ({
  source: 'claude', id: Math.random().toString(36), ts: 0, cwd: '/a', model: 'claude-opus-5-5',
  input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, ...patch,
});

describe('transcript do Claude → registro', () => {
  it('lê modelo, pasta, hora e o uso, separando o cache de 1 h', () => {
    const r = claudeRecord(transcriptLine({ id: 'msg_1', ts: '2026-11-03T14:08:35.755Z', cwd: '/p', input: 2, output: 236, write1h: 27178, read: 26047 }));
    expect(r).toEqual({ source: 'claude', id: 'msg_1', ts: Date.parse('2026-11-03T14:08:35.755Z'), cwd: '/p', model: 'claude-opus-5-5', input: 2, output: 236, cacheWrite5m: 0, cacheWrite1h: 27178, cacheRead: 26047, session: 's1' });
  });

  it('ignora o que não é resposta com uso, e as respostas sintéticas', () => {
    expect(claudeRecord(JSON.stringify({ type: 'user', message: { content: 'oi' } }))).toBeUndefined();
    expect(claudeRecord('{quebrado "usage"')).toBeUndefined();
    const sint = JSON.parse(transcriptLine({ id: 'x', ts: '2026-11-03T00:00:00Z', cwd: '/p' }));
    sint.message.model = '<synthetic>';
    expect(claudeRecord(JSON.stringify(sint))).toBeUndefined();
  });
});

describe('leitura incremental', () => {
  beforeEach(() => resetUsage());

  it('a mesma resposta em várias linhas conta uma vez; lê só o que foi acrescentado, inclusive a linha que estava pela metade', async () => {
    const dir = path.join(process.env.AI_OFFICE_CLAUDE_DIR!, 'projects', `-inc-${Date.now()}`);
    fs.mkdirSync(path.join(dir, 'sessao', 'subagents'), { recursive: true });
    const file = path.join(dir, 'a.jsonl');
    const l1 = transcriptLine({ id: 'inc_1', ts: '2026-11-03T10:00:00Z', cwd: '/inc', output: 10 });
    // O Claude Code repete a linha da resposta para cada bloco de conteúdo.
    fs.writeFileSync(file, `${l1}\n${l1}\n{"type":"user"}\n`);
    fs.writeFileSync(path.join(dir, 'sessao', 'subagents', 'agent-1.jsonl'), `${transcriptLine({ id: 'inc_sub', ts: '2026-11-03T10:01:00Z', cwd: '/inc', output: 5 })}\n`);
    const mine = async () => (await usageRecords(true)).filter((r) => r.cwd === '/inc');
    expect((await mine()).map((r) => r.id).sort()).toEqual(['inc_1', 'inc_sub']);

    // Acrescenta uma resposta com acento, e a próxima pela metade (ainda sendo escrita).
    const l2 = transcriptLine({ id: 'inc_2', ts: '2026-11-03T10:02:00Z', cwd: '/inc', output: 7 }).replace('"s1"', '"sessão ç"');
    const l3 = transcriptLine({ id: 'inc_3', ts: '2026-11-03T10:03:00Z', cwd: '/inc' });
    fs.appendFileSync(file, `${l2}\n${l3.slice(0, 40)}`);
    expect((await mine()).map((r) => r.id).sort()).toEqual(['inc_1', 'inc_2', 'inc_sub']);
    fs.appendFileSync(file, `${l3.slice(40)}\n`);
    expect((await mine()).map((r) => r.id).sort()).toEqual(['inc_1', 'inc_2', 'inc_3', 'inc_sub']);

    // O índice vai para o disco: depois de reiniciar, não relê nem duplica.
    resetUsage();
    expect((await mine()).length).toBe(4);
  });

  it('outras fontes chegam pela rota (gravadas na pasta de entrada) no mesmo formato', async () => {
    const r = receiveRecords([
      { source: 'Gemini', id: 'g1', ts: '2026-11-03T12:00:00Z', cwd: '/g', model: 'gemini-3-pro', input: 100, output: 50, cacheWrite: 10 },
      { source: 'codex', ts: 1 },
    ]);
    expect(r).toEqual({ accepted: 1, rejected: 1 });
    const g = (await usageRecords(true)).find((x) => x.id === 'g1');
    expect(g).toMatchObject({ source: 'gemini', model: 'gemini-3-pro', input: 100, output: 50, cacheWrite5m: 10 });
  });
});

describe('preços e custo', () => {
  it('acha o preço sem o sufixo de data ou de contexto; modelo desconhecido fica sem preço', () => {
    expect(priceFor('claude-opus-5-5[1m]', DEFAULT_PRICES)).toBe(DEFAULT_PRICES['claude-opus-5-5']);
    expect(priceFor('claude-haiku-4-5-20251001', DEFAULT_PRICES)).toBe(DEFAULT_PRICES['claude-haiku-4-5']);
    expect(priceFor('gpt-x', DEFAULT_PRICES)).toBeUndefined();
  });

  it('equivalente na API: cada tipo de token no seu preço', () => {
    // Opus 5.5: $4 entrada, $20 saída, $8 cache de 1 h, $5 cache de 5 min, $0,20 leitura (por milhão).
    const r = rec({ input: 1e6, output: 1e6, cacheWrite1h: 1e6, cacheWrite5m: 1e6, cacheRead: 1e6 });
    expect(costOf(r, DEFAULT_PRICES['claude-opus-5-5'])).toBeCloseTo(4 + 20 + 8 + 5 + 0.2);
  });

  it('registro de fora inválido é recusado', () => {
    expect(parseRecord({ source: 'tem espaço', id: 'x', ts: 1 })).toBeUndefined();
    expect(parseRecord({ source: 'codex', id: 'x', ts: 'ontem' })).toBeUndefined();
    expect(parseRecord({ source: 'codex', id: 'x', ts: 5, input: -3, output: 'muito' })).toMatchObject({ input: 0, output: 0, model: 'desconhecido' });
  });

  it('formata tokens e dinheiro em português', () => {
    expect([formatTokens(950), formatTokens(12_345), formatTokens(4_500_000), formatTokens(2.1e9)]).toEqual(['950', '12,3 mil', '4,5 mi', '2,1 bi']);
    expect([formatUsd(3.456), formatUsd(1234.4)]).toEqual(['US$ 3,46', 'US$ 1.234']);
  });
});

describe('janela do plano', () => {
  const h = 3600_000;
  it('abre na primeira mensagem depois que a anterior fechou e dura 5 horas', () => {
    expect(planWindows([0, h, 4.9 * h, 5 * h, 7 * h, 20 * h])).toEqual([
      { start: 0, end: WINDOW_MS },
      { start: 5 * h, end: 5 * h + WINDOW_MS },
      { start: 20 * h, end: 20 * h + WINDOW_MS },
    ]);
  });

  it('o resumo traz o consumo de cada projeto na janela aberta e a mediana das anteriores', () => {
    const now = 100 * h;
    const locate = (cwd: string) => ({ key: cwd, label: cwd });
    const records = [
      rec({ ts: now - 50 * h, cwd: '/a', output: 100 }),
      rec({ ts: now - 30 * h, cwd: '/a', output: 300 }),
      rec({ ts: now - 10 * h, cwd: '/a', output: 200 }),
      rec({ ts: now - 2 * h, cwd: '/a', output: 40 }),
      rec({ ts: now - 1 * h, cwd: '/b', output: 60 }),
      rec({ ts: now - 1 * h, cwd: '/b', output: 1000, source: 'gemini', model: 'gemini-x' }),
    ];
    const s = summarize(records, { from: now - 7 * 24 * h, to: now + 1, now, locate, prices: DEFAULT_PRICES });
    // A janela é só do Claude: o Gemini não entra nela.
    expect(s.window).toMatchObject({ start: now - 2 * h, total: 100, typical: 200, previous: 3 });
    expect(s.window!.places.map((p) => [p.place.key, p.tokens.output])).toEqual([['/b', 60], ['/a', 40]]);
    expect(s.sources).toEqual(['claude', 'gemini']);
    expect(s.unpricedTokens).toBe(1000);
    expect(s.places.find((p) => p.place.key === '/b')!.bySource).toEqual({ claude: 60, gemini: 1000 });
    // Sem nada nas últimas 5 horas, não há janela aberta.
    expect(summarize(records, { from: 0, to: now, now: now + 10 * h, locate, prices: DEFAULT_PRICES }).window).toBeUndefined();
  });
});

describe('uso oficial do plano', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const sec = (iso: string) => Date.parse(iso) / 1000;

  it('lê os rate_limits da statusline (resets_at em segundos) e ignora o que não serve', () => {
    expect(parsePlan({ five_hour: { used_percentage: 23.5, resets_at: sec('2026-11-11T15:00:00Z') }, seven_day: { used_percentage: 41.2, resets_at: sec('2026-11-14T10:00:00Z') } }, now)).toEqual({
      fiveHour: { usedPct: 23.5, resetsAt: Date.parse('2026-11-11T15:00:00Z') },
      sevenDay: { usedPct: 41.2, resetsAt: Date.parse('2026-11-14T10:00:00Z') },
      updatedAt: now,
    });
    expect(parsePlan({ seven_day: { used_percentage: 5, resets_at: sec('2026-11-14T10:00:00Z') } }, now)?.fiveHour).toBeUndefined();
    expect(parsePlan({ five_hour: { used_percentage: 'x' } }, now)).toBeUndefined();
    expect(parsePlan(undefined, now)).toBeUndefined();
  });

  it('janela que já reiniciou sai (o número era de antes da virada)', () => {
    const plan = parsePlan({ five_hour: { used_percentage: 90, resets_at: sec('2026-11-11T11:00:00Z') }, seven_day: { used_percentage: 41, resets_at: sec('2026-11-14T10:00:00Z') } }, now - 3600_000)!;
    expect(livePlan(plan, now)).toEqual({ sevenDay: plan.sevenDay, updatedAt: plan.updatedAt });
  });

  it('com o horário oficial, a janela do resumo é exata e substitui a estimada', () => {
    const resets = Date.parse('2026-11-11T14:00:00Z');
    const plan = parsePlan({ five_hour: { used_percentage: 30, resets_at: resets / 1000 } }, now)!;
    const locate = (cwd: string) => ({ key: cwd, label: cwd });
    // Mensagens às 8h40 (estimaria uma janela das 8h40 às 13h40) e às 11h.
    const records = [rec({ ts: Date.parse('2026-11-11T08:40:00Z'), output: 10 }), rec({ ts: Date.parse('2026-11-11T11:00:00Z'), output: 20 })];
    const s = summarize(records, { from: 0, to: now + 1, now, locate, prices: DEFAULT_PRICES, plan });
    expect(s.window).toMatchObject({ start: resets - WINDOW_MS, end: resets, official: true, total: 20 });
    expect(s.plan?.fiveHour?.usedPct).toBe(30);
  });
});
