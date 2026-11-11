// Consumo de tokens: o registro único que toda fonte (Claude, Codex, Gemini, um script seu)
// produz, os preços para o "equivalente na API" e o resumo que o painel mostra. Usado pelo
// servidor (que lê as fontes e resume) e pela interface (tipos e formatação).

/** Uma resposta de um modelo: quanto ela gastou, onde (pasta) e quando. */
export interface UsageRecord {
  /** De onde veio: 'claude', 'codex', 'gemini'... (letras minúsculas, números e hífen). */
  source: string;
  /** Identificador único da resposta na fonte: a mesma resposta lida duas vezes conta uma. */
  id: string;
  /** Quando (ms desde 1970). */
  ts: number;
  /** Pasta em que o agente trabalhava: é por ela que o consumo vai para a sala e o projeto. */
  cwd: string;
  model: string;
  input: number;
  output: number;
  /** Tokens gravados no cache (5 min e 1 h custam diferente). */
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface Tokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Preço em USD por milhão de tokens. */
export interface Price {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** Escrita de cache pela regra padrão: 1,25× a entrada (5 min) e 2× (1 h). */
const priced = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, cacheRead });

/**
 * Preços da API da Anthropic (tabela de 2026-10-06). O Haiku 5.5 não tinha leitura de cache
 * publicada nela: 0,1× a entrada, como nos outros. Você edita os seus no painel (ficam em
 * ~/.ai-office/uso/precos.json) e acrescenta os de outras fontes (GPT, Gemini...).
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-fable-5-1': priced(10, 50, 0.25),
  'claude-fable-5': priced(10, 50, 1),
  'claude-opus-5-5': priced(4, 20, 0.2),
  'claude-opus-5': priced(5, 25, 0.5),
  'claude-opus-4-8': priced(5, 25, 0.5),
  'claude-opus-4-7': priced(5, 25, 0.5),
  'claude-opus-4-6': priced(5, 25, 0.5),
  'claude-sonnet-5-5': priced(2, 10, 0.2),
  'claude-sonnet-5': priced(2, 10, 0.2),
  'claude-sonnet-4-6': priced(3, 15, 0.3),
  'claude-haiku-5-5': priced(0.1, 0.5, 0.01),
  'claude-haiku-4-5': priced(1, 5, 0.1),
};

/** Preço de um modelo: o nome exato, ou sem o sufixo de data ou de contexto ("-20251001", "[1m]"). */
export function priceFor(model: string, prices: Record<string, Price>): Price | undefined {
  if (prices[model]) return prices[model];
  const base = model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  return prices[base];
}

/** Equivalente na API, em USD. */
export function costOf(r: UsageRecord, p: Price): number {
  return (r.input * p.input + r.output * p.output + r.cacheWrite5m * p.cacheWrite5m + r.cacheWrite1h * p.cacheWrite1h + r.cacheRead * p.cacheRead) / 1e6;
}

export const tokensOf = (r: UsageRecord): Tokens => ({ input: r.input, output: r.output, cacheWrite: r.cacheWrite5m + r.cacheWrite1h, cacheRead: r.cacheRead });
export const totalTokens = (t: Tokens) => t.input + t.output + t.cacheWrite + t.cacheRead;
const zero = (): Tokens => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const add = (a: Tokens, b: Tokens) => {
  a.input += b.input;
  a.output += b.output;
  a.cacheWrite += b.cacheWrite;
  a.cacheRead += b.cacheRead;
};

/** Confere um registro que veio de fora (rota ou pasta de entrada). */
export function parseRecord(raw: unknown): UsageRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const source = typeof r.source === 'string' ? r.source.trim().toLowerCase() : '';
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const ts = typeof r.ts === 'number' ? r.ts : typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
  if (!/^[a-z0-9-]{1,32}$/.test(source) || !id || id.length > 200 || !Number.isFinite(ts)) return undefined;
  return {
    source,
    id,
    ts,
    cwd: typeof r.cwd === 'string' ? r.cwd : '',
    model: typeof r.model === 'string' && r.model.trim() ? r.model.trim().slice(0, 100) : 'desconhecido',
    input: n(r.input),
    output: n(r.output),
    // Quem não separa o cache de 5 min e o de 1 h manda só cacheWrite.
    cacheWrite5m: n(r.cacheWrite5m) + n(r.cacheWrite),
    cacheWrite1h: n(r.cacheWrite1h),
    cacheRead: n(r.cacheRead),
  };
}

// ---------- janela do plano ----------

/** A janela de uso do plano do Claude: 5 horas a partir da primeira mensagem depois que a anterior fechou. */
export const WINDOW_MS = 5 * 60 * 60 * 1000;

export interface PlanWindow {
  start: number;
  end: number;
}

/** Janelas do plano a partir dos horários das respostas (as do Claude), em ordem. */
export function planWindows(times: number[]): PlanWindow[] {
  const out: PlanWindow[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (!last || t >= last.end) out.push({ start: t, end: t + WINDOW_MS });
  }
  return out;
}

// ---------- uso oficial do plano ----------

/** Uma janela do plano como o Claude Code informa: quanto já foi usado e quando reinicia. */
export interface PlanLimit {
  /** De 0 a 100. */
  usedPct: number;
  /** Quando a janela reinicia (ms). */
  resetsAt: number;
}

/** O uso oficial do plano (Pro, Max, Ultra), que a statusline das sessões do escritório entrega. */
export interface PlanUsage {
  fiveHour?: PlanLimit;
  sevenDay?: PlanLimit;
  /** Quando chegou (ms): números de mais de 30 min são mostrados como desatualizados. */
  updatedAt: number;
}

/** Os rate_limits da statusline (resets_at em segundos) no formato do escritório. undefined = nada útil. */
export function parsePlan(raw: unknown, now: number): PlanUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, any>;
  const limit = (w: any): PlanLimit | undefined => {
    const pct = Number(w?.used_percentage);
    const resets = Number(w?.resets_at);
    if (!Number.isFinite(pct) || pct < 0 || pct > 1000 || !Number.isFinite(resets) || resets <= 0) return undefined;
    return { usedPct: Math.min(100, pct), resetsAt: resets * 1000 };
  };
  const fiveHour = limit(r.five_hour);
  const sevenDay = limit(r.seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), updatedAt: now };
}

/** Uma janela que já reiniciou não vale mais (o número é de antes da virada). */
export function livePlan(plan: PlanUsage | undefined, now: number): PlanUsage | undefined {
  if (!plan) return undefined;
  const ok = (w?: PlanLimit) => (w && w.resetsAt > now ? w : undefined);
  const fiveHour = ok(plan.fiveHour);
  const sevenDay = ok(plan.sevenDay);
  if (!fiveHour && !sevenDay) return undefined;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), updatedAt: plan.updatedAt };
}

/** Números de mais de 30 minutos atrás: podem ter mudado em outra sessão fora do escritório. */
export const PLAN_STALE_MS = 30 * 60 * 1000;

// ---------- resumo para o painel ----------

/** Onde um consumo fica no escritório: sala e projeto, ou fora dele (só a pasta). */
export interface Place {
  key: string;
  label: string;
  roomId?: string;
  projectId?: string;
  floorId?: string;
}

export interface UsageRow {
  place: Place;
  tokens: Tokens;
  cost: number;
  bySource: Record<string, number>;
}

export interface UsageSummary {
  from: number;
  to: number;
  sources: string[];
  totals: Tokens & { cost: number };
  /** Tokens de modelos sem preço na tabela (o custo deles fica de fora). */
  unpricedTokens: number;
  byModel: { model: string; source: string; tokens: Tokens; cost?: number }[];
  places: UsageRow[];
  /** Total de tokens por dia (data local "AAAA-MM-DD") e fonte. */
  daily: { day: string; bySource: Record<string, number> }[];
  /** Uso oficial do plano, quando alguma sessão do escritório já o recebeu. */
  plan?: PlanUsage;
  /** Janela atual do plano do Claude (ausente se não há uma aberta). */
  window?: {
    start: number;
    end: number;
    /** A janela veio do horário oficial de reinício (e não da estimativa pelas mensagens). */
    official?: boolean;
    places: UsageRow[];
    total: number;
    /** Mediana das janelas anteriores (nos últimos 30 dias), para comparar. */
    typical?: number;
    previous: number;
  };
}

export const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function rowsFor(records: UsageRecord[], locate: (cwd: string) => Place, prices: Record<string, Price>): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const r of records) {
    const place = locate(r.cwd);
    let row = rows.get(place.key);
    if (!row) rows.set(place.key, (row = { place, tokens: zero(), cost: 0, bySource: {} }));
    const t = tokensOf(r);
    add(row.tokens, t);
    const p = priceFor(r.model, prices);
    if (p) row.cost += costOf(r, p);
    row.bySource[r.source] = (row.bySource[r.source] ?? 0) + totalTokens(t);
  }
  return [...rows.values()].sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens));
}

/** Resumo do período [from, to): por lugar, por modelo, por dia e a janela atual do plano. */
export function summarize(
  all: UsageRecord[],
  opts: { from: number; to: number; now: number; locate: (cwd: string) => Place; prices: Record<string, Price>; plan?: PlanUsage },
): UsageSummary {
  const { from, to, now, locate, prices } = opts;
  const plan = livePlan(opts.plan, now);
  const recs = all.filter((r) => r.ts >= from && r.ts < to);
  const totals = { ...zero(), cost: 0 };
  let unpricedTokens = 0;
  const models = new Map<string, { model: string; source: string; tokens: Tokens; cost?: number }>();
  const daily = new Map<string, Record<string, number>>();
  for (const r of recs) {
    const t = tokensOf(r);
    add(totals, t);
    const p = priceFor(r.model, prices);
    const c = p ? costOf(r, p) : undefined;
    if (c === undefined) unpricedTokens += totalTokens(t);
    else totals.cost += c;
    const key = `${r.source}\u0000${r.model}`;
    let m = models.get(key);
    if (!m) models.set(key, (m = { model: r.model, source: r.source, tokens: zero(), cost: p ? 0 : undefined }));
    add(m.tokens, t);
    if (c !== undefined) m.cost = (m.cost ?? 0) + c;
    const day = dayKey(r.ts);
    const d = daily.get(day) ?? {};
    d[r.source] = (d[r.source] ?? 0) + totalTokens(t);
    daily.set(day, d);
  }
  // Fontes sempre na mesma ordem (a cor segue a fonte): o Claude primeiro, as outras pelo nome.
  const sources = [...new Set(all.map((r) => r.source))].sort((a, b) => (a === 'claude' ? -1 : b === 'claude' ? 1 : a.localeCompare(b)));

  const summary: UsageSummary = {
    from,
    to,
    sources,
    totals,
    unpricedTokens,
    byModel: [...models.values()].sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens)),
    places: rowsFor(recs, locate, prices),
    daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([day, bySource]) => ({ day, bySource })),
  };

  // A janela do plano só faz sentido para o Claude (é o plano dele que tem o limite de 5 horas).
  const claude = all.filter((r) => r.source === 'claude');
  const windows = planWindows(claude.map((r) => r.ts));
  // Com o horário oficial de reinício, a janela é exata: termina nele e começa 5 horas antes.
  const official = plan?.fiveHour ? { start: plan.fiveHour.resetsAt - WINDOW_MS, end: plan.fiveHour.resetsAt } : undefined;
  if (official) {
    // As estimadas que encostam na oficial saem: a oficial manda.
    while (windows.length && windows.at(-1)!.end > official.start) windows.pop();
    windows.push(official);
  }
  if (plan) summary.plan = plan;
  const current = windows.at(-1);
  if (current && now < current.end) {
    const inWin = (w: PlanWindow) => claude.filter((r) => r.ts >= w.start && r.ts < w.end);
    const sum = (rs: UsageRecord[]) => rs.reduce((s, r) => s + totalTokens(tokensOf(r)), 0);
    const recent = windows.slice(0, -1).filter((w) => w.start >= now - 30 * 24 * 3600 * 1000);
    const totalsPrev = recent.map((w) => sum(inWin(w))).sort((a, b) => a - b);
    const mine = inWin(current);
    summary.window = {
      start: current.start,
      end: current.end,
      ...(official ? { official: true } : {}),
      places: rowsFor(mine, locate, prices),
      total: sum(mine),
      typical: totalsPrev.length ? totalsPrev[Math.floor(totalsPrev.length / 2)] : undefined,
      previous: totalsPrev.length,
    };
  }
  return summary;
}

/** "12,3 mil", "4,5 mi": tokens em texto curto. */
export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',')} bi`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} mi`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace('.', ',')} mil`;
  return String(Math.round(n));
}

export function formatUsd(n: number): string {
  return `US$ ${n < 10 ? n.toFixed(2).replace('.', ',') : Math.round(n).toLocaleString('pt-BR')}`;
}
