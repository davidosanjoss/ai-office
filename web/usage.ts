// Painel de consumo (📊 na barra de cima): tokens e o equivalente na API por sala e projeto, por
// dia e fonte, por modelo (com os preços editáveis) e na janela atual do plano do Claude.
// Cobre o mapa e os terminais enquanto está aberto; Esc ou × fecha.

import { type Price, type UsageRow, type UsageSummary, formatTokens, formatUsd, totalTokens } from '../shared/usage.ts';
import * as logic from './logic.ts';

type Api = (method: string, url: string, body?: unknown) => Promise<unknown>;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const time = (ts: number) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export class UsagePanel {
  private period: logic.UsagePeriod = '7d';
  private summary?: UsageSummary;
  private prices?: { prices: Record<string, Price>; custom: string[]; seen: string[] };
  /** Número do último pedido: a resposta de um pedido mais antigo (outro período) é descartada. */
  private seq = 0;

  constructor(
    private api: Api,
    private onSelectPlace: (roomId: string) => void,
  ) {
    $('#btn-usage').addEventListener('click', () => (this.isShown() ? this.hide() : this.show()));
    $('#usage-close').addEventListener('click', () => this.hide());
    for (const b of document.querySelectorAll<HTMLButtonElement>('#usage-periods button')) {
      b.addEventListener('click', () => {
        this.period = b.dataset.period as logic.UsagePeriod;
        void this.refresh();
      });
    }
    $('#usage-places').addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-room]');
      if (row?.dataset.room) {
        this.hide();
        this.onSelectPlace(row.dataset.room);
      }
    });
    $('#usage-models').addEventListener('submit', (e) => void this.savePrice(e));
  }

  isShown() {
    return !$('#usage-view').hidden;
  }

  show() {
    $('#usage-view').hidden = false;
    $('#btn-usage').classList.add('active');
    void this.refresh();
  }

  hide() {
    $('#usage-view').hidden = true;
    $('#btn-usage').classList.remove('active');
  }

  async refresh() {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#usage-periods button')) b.classList.toggle('active', b.dataset.period === this.period);
    const seq = ++this.seq;
    const { from, to } = logic.periodRange(this.period, Date.now());
    $('#usage-status').textContent = 'Lendo o consumo…';
    try {
      const [summary, prices] = await Promise.all([
        this.api('GET', `/api/uso?from=${from}&to=${to}&ler=1`) as Promise<UsageSummary>,
        this.api('GET', '/api/uso/precos') as Promise<UsagePanel['prices']>,
      ]);
      if (seq !== this.seq) return;
      this.summary = summary;
      this.prices = prices;
      $('#usage-status').textContent = '';
      this.render();
    } catch (err) {
      if (seq === this.seq) $('#usage-status').textContent = (err as Error).message;
    }
  }

  private render() {
    const s = this.summary!;
    const total = totalTokens(s.totals);
    $('#usage-tiles').innerHTML = `
      <div class="tile"><span class="tile-label">Tokens no período</span><b>${formatTokens(total)}</b>
        <small>${formatTokens(s.totals.input + s.totals.cacheWrite + s.totals.cacheRead)} de entrada (${pct(s.totals.cacheRead, total)} lidos do cache) · ${formatTokens(s.totals.output)} de saída</small></div>
      <div class="tile"><span class="tile-label">Equivalente na API</span><b>${formatUsd(s.totals.cost)}</b>
        <small>${s.unpricedTokens ? `${formatTokens(s.unpricedTokens)} tokens de modelos sem preço ficam de fora` : 'pelos preços da tabela abaixo'}</small></div>
      ${this.windowTile(s)}`;
    this.renderChart(s);
    $('#usage-places tbody').innerHTML = this.rows(logic.topPlaces(s.places, 12), total) || '<tr><td colspan="6" class="muted">Nenhum consumo no período.</td></tr>';
    $('#usage-window tbody').innerHTML = s.window
      ? this.rows(logic.topPlaces(s.window.places, 12), s.window.total)
      : '<tr><td colspan="6" class="muted">Nenhuma janela do plano aberta agora.</td></tr>';
    this.renderModels(s);
  }

  private windowTile(s: UsageSummary): string {
    const w = s.window;
    const plan = logic.planView(s.plan, Date.now());
    const meter = (pct: number) => `<span class="meter" role="img" aria-label="${pct}%"><i style="width:${Math.min(100, pct)}%"></i></span>`;
    const stale = plan?.stale ? ' Números de mais de 30 min: podem ter mudado em sessões fora do escritório.' : '';
    let out = '';
    if (plan?.fiveHour) {
      const p = plan.fiveHour;
      out += `<div class="tile${p.high ? ' high' : ''}"><span class="tile-label">Plano · janela de 5 h</span><b>${p.high ? '⚠ ' : ''}${p.pct}%</b>${meter(p.pct)}
        <small>Reinicia às ${p.resets}${w ? ` · ${formatTokens(w.total)} tokens nesta janela` : ''}. Número oficial do Claude Code.${stale}</small></div>`;
    } else if (w) {
      const vs = w.typical ? `${Math.round((w.total / w.typical) * 100)}% do que você costuma gastar numa janela` : 'ainda sem janelas anteriores para comparar';
      out += `<div class="tile"><span class="tile-label">Janela do plano (5 h) · ${time(w.start)}–${time(w.end)}</span><b>${formatTokens(w.total)}</b>
        <small>${vs}. Estimativa: o número oficial chega quando uma sessão do escritório responder (só nos planos Pro, Max e Ultra).</small></div>`;
    } else {
      out += `<div class="tile"><span class="tile-label">Janela do plano (5 h)</span><b>—</b><small>Nenhuma aberta: a próxima mensagem abre uma nova.</small></div>`;
    }
    if (plan?.sevenDay) {
      const p = plan.sevenDay;
      out += `<div class="tile${p.high ? ' high' : ''}"><span class="tile-label">Plano · semana</span><b>${p.high ? '⚠ ' : ''}${p.pct}%</b>${meter(p.pct)}<small>Reinicia ${p.resets}.${stale}</small></div>`;
    }
    return out;
  }

  private rows(rows: UsageRow[], total: number): string {
    return rows
      .map((r) => {
        const t = totalTokens(r.tokens);
        const share = total ? (t / total) * 100 : 0;
        const room = r.place.roomId ? ` data-room="${esc(r.place.roomId)}" title="Abrir a sala"` : '';
        return `<tr${room}>
          <td class="place"><span>${esc(r.place.label)}</span><span class="share"><i style="width:${share.toFixed(1)}%"></i></span></td>
          <td class="num">${formatTokens(r.tokens.input + r.tokens.cacheWrite)}</td>
          <td class="num">${formatTokens(r.tokens.cacheRead)}</td>
          <td class="num">${formatTokens(r.tokens.output)}</td>
          <td class="num"><b>${formatTokens(t)}</b></td>
          <td class="num">${formatUsd(r.cost)}</td>
        </tr>`;
      })
      .join('');
  }

  /** Barras por dia, empilhadas por fonte (a cor segue a fonte, sempre na mesma ordem). */
  private renderChart(s: UsageSummary) {
    const days = logic.periodDays(this.period, Date.now());
    const byDay = new Map(s.daily.map((d) => [d.day, d.bySource]));
    const totals = days.map((d) => Object.values(byDay.get(d) ?? {}).reduce((a, b) => a + b, 0));
    const max = logic.niceMax(Math.max(0, ...totals));
    // A largura do desenho é a da tela: o texto do eixo fica no tamanho certo em qualquer largura.
    const W = Math.max(320, Math.round($('#usage-chart').clientWidth || 720));
    const H = 200;
    const left = 52;
    const bottom = 20;
    const plotH = H - bottom - 8;
    const slot = (W - left) / days.length;
    const bw = Math.max(4, Math.min(28, slot - 6));
    const y = (v: number) => 8 + plotH - (max ? (v / max) * plotH : 0);
    let svg = '';
    for (const g of [0, 0.5, 1]) {
      const v = max * g;
      svg += `<line class="grid" x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${formatTokens(v)}</text>`;
    }
    const step = Math.ceil(days.length / 10);
    days.forEach((day, i) => {
      const x = left + i * slot + (slot - bw) / 2;
      let base = 0;
      const parts = s.sources.map((src) => ({ src, v: byDay.get(day)?.[src] ?? 0 })).filter((p) => p.v > 0);
      parts.forEach((p, k) => {
        const top = y(base + p.v);
        const h = Math.max(1, y(base) - top - (k < parts.length - 1 ? 2 : 0));
        const last = k === parts.length - 1;
        svg += `<path class="bar" fill="${logic.sourceColor(s.sources, p.src)}" d="${barPath(x, top, bw, h, last ? 3 : 0)}"/>`;
        base += p.v;
      });
      const tip = [`${dayLabel(day)}: ${formatTokens(totals[i])} tokens`, ...parts.map((p) => `${p.src}: ${formatTokens(p.v)}`)].join('\n');
      svg += `<rect class="hit" x="${left + i * slot}" y="0" width="${slot}" height="${H - bottom}" data-tip="${esc(tip)}"/>`;
      if (i % step === 0) svg += `<text class="axis" x="${x + bw / 2}" y="${H - 4}" text-anchor="middle">${dayLabel(day)}</text>`;
    });
    $('#usage-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tokens por dia e fonte">${svg}</svg>`;
    $('#usage-legend').innerHTML = s.sources.map((src) => `<span><i style="background:${logic.sourceColor(s.sources, src)}"></i>${esc(src)}</span>`).join('');
    const tipBox = $('#usage-tip');
    for (const hit of document.querySelectorAll<SVGRectElement>('#usage-chart .hit')) {
      hit.addEventListener('pointerenter', () => {
        tipBox.textContent = hit.dataset.tip ?? '';
        tipBox.hidden = false;
      });
      hit.addEventListener('pointermove', (e) => {
        // O painel pode estar com zoom (telas 4K): a posição na tela volta para a escala dele.
        const box = $('#usage-chart').getBoundingClientRect();
        const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
        tipBox.style.left = `${(e.clientX - box.left) / z + 12}px`;
        tipBox.style.top = `${(e.clientY - box.top) / z + 12}px`;
      });
      hit.addEventListener('pointerleave', () => (tipBox.hidden = true));
    }
  }

  /** Modelos do período com o preço de cada um, editável (USD por milhão de tokens). */
  private renderModels(s: UsageSummary) {
    const p = this.prices!;
    const models = [...new Set([...s.byModel.map((m) => m.model), ...p.seen])];
    const used = new Map(s.byModel.map((m) => [m.model, m]));
    const cell = (model: string, k: keyof Price) => `<td><input name="${k}" type="number" min="0" step="any" value="${p.prices[model]?.[k] ?? ''}" placeholder="—" /></td>`;
    $('#usage-models tbody').innerHTML = models
      .map((model) => {
        const m = used.get(model);
        return `<tr data-model="${esc(model)}">
          <td><b>${esc(model)}</b><small class="muted"> ${esc(m?.source ?? '')}${p.custom.includes(model) ? ' · preço seu' : ''}</small></td>
          <td class="num">${m ? formatTokens(totalTokens(m.tokens)) : '—'}</td>
          <td class="num">${m?.cost !== undefined ? formatUsd(m.cost) : m ? 'sem preço' : '—'}</td>
          ${cell(model, 'input')}${cell(model, 'output')}${cell(model, 'cacheWrite5m')}${cell(model, 'cacheWrite1h')}${cell(model, 'cacheRead')}
          <td><button class="btn small" type="submit" value="${esc(model)}">Salvar</button></td>
        </tr>`;
      })
      .join('');
  }

  private async savePrice(e: SubmitEvent) {
    e.preventDefault();
    const model = (e.submitter as HTMLButtonElement | null)?.value;
    const row = model ? document.querySelector<HTMLElement>(`#usage-models tr[data-model="${CSS.escape(model)}"]`) : null;
    if (!model || !row) return;
    const value = (k: string) => Number(row.querySelector<HTMLInputElement>(`input[name=${k}]`)!.value || 0);
    const price = { input: value('input'), output: value('output'), cacheWrite5m: value('cacheWrite5m'), cacheWrite1h: value('cacheWrite1h'), cacheRead: value('cacheRead') };
    try {
      await this.api('PUT', '/api/uso/precos', { model, price });
      await this.refresh();
    } catch (err) {
      $('#usage-status').textContent = (err as Error).message;
    }
  }
}

const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : '0%');
const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** Barra com o topo arredondado (só a de cima da pilha) e a base reta no eixo. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  if (!rr) return `M${x},${y}h${w}v${h}h${-w}z`;
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}z`;
}
