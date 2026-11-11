// Abas "Meu dia" e "Relatório" do painel 📊. Meu dia: quanto tempo os agentes trabalharam e quanto
// esperaram você, por hora e por projeto, e as esperas mais longas. Relatório: o que foi feito em
// cada projeto no dia (pedidos, commits, eventos do GitHub, tempo e tokens), com um resumo em texto
// feito pelo Claude quando você pede.

import { type DayReport, hoursMinutes } from '../shared/day.ts';
import { dayKey, formatTokens, formatUsd, totalTokens } from '../shared/usage.ts';
import * as logic from './logic.ts';

type Api = (method: string, url: string, body?: unknown) => Promise<unknown>;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const time = (ts: number) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Cores das barras por hora: trabalhando e esperando você (as duas primeiras da paleta do consumo). */
const WORK = logic.SOURCE_COLORS[0];
const WAIT = logic.SOURCE_COLORS[3];

export class DayPanel {
  private report?: DayReport & { summaries: Record<string, string> };
  private seq = 0;

  constructor(private api: Api) {
    const input = $<HTMLInputElement>('#day-date');
    input.value = dayKey(Date.now());
    input.max = input.value;
    input.addEventListener('change', () => void this.refresh());
    $('#usage-relatorio').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-summarize]');
      if (btn) void this.summarize(btn);
    });
  }

  date() {
    return $<HTMLInputElement>('#day-date').value || dayKey(Date.now());
  }

  async refresh() {
    const seq = ++this.seq;
    $('#usage-status').textContent = 'Juntando o dia…';
    try {
      const r = (await this.api('GET', `/api/dia?data=${this.date()}`)) as DayPanel['report'];
      if (seq !== this.seq) return;
      this.report = r;
      $('#usage-status').textContent = '';
      this.renderDay();
      this.renderReport();
    } catch (err) {
      if (seq === this.seq) $('#usage-status').textContent = (err as Error).message;
    }
  }

  private renderDay() {
    const r = this.report!;
    const t = r.totals;
    const waitAll = t.waitMs + t.doneMs;
    const share = t.workMs + waitAll ? Math.round((waitAll / (t.workMs + waitAll)) * 100) : 0;
    const longest = r.longestWaits[0];
    const max = logic.niceMax(Math.max(1, ...r.byHour.map((h) => h.work + h.wait)));
    const bars = r.byHour
      .map((h, i) => {
        const wH = (h.work / max) * 100;
        const aH = (h.wait / max) * 100;
        return `<div class="hour" title="${i}h: ${Math.round(h.work)} min trabalhando, ${Math.round(h.wait)} min esperando você">
          <span class="stack"><i style="height:${aH}%;background:${WAIT}"></i><i style="height:${wH}%;background:${WORK}"></i></span><small>${i % 3 === 0 ? i : ''}</small></div>`;
      })
      .join('');
    const rows = r.projects
      .filter((p) => p.workMs || p.waitMs || p.doneMs)
      .sort((a, b) => b.waitMs + b.doneMs - (a.waitMs + a.doneMs))
      .map((p) => `<tr><td>${esc(p.place.label)}</td><td class="num">${hoursMinutes(p.workMs)}</td><td class="num">${hoursMinutes(p.waitMs)}</td><td class="num">${hoursMinutes(p.doneMs)}</td><td>${esc(p.agents.join(', '))}</td></tr>`)
      .join('');
    $('#usage-dia').innerHTML = `
      <div class="tiles">
        <div class="tile"><span class="tile-label">Agentes trabalhando</span><b>${hoursMinutes(t.workMs)}</b><small>tempo de agente: dois agentes numa hora contam duas</small></div>
        <div class="tile high"><span class="tile-label">Esperando você</span><b>${hoursMinutes(waitAll)}</b><small>${hoursMinutes(t.waitMs)} pedindo permissão ou resposta · ${hoursMinutes(t.doneMs)} terminados sem você ver · ${share}% do tempo</small></div>
        <div class="tile"><span class="tile-label">Espera mais longa</span><b>${longest ? hoursMinutes(longest.ms) : '—'}</b><small>${longest ? `${esc(longest.agent)} em ${esc(longest.place)}, às ${time(longest.at)}` : 'ninguém esperou você'}</small></div>
      </div>
      <section class="card"><h3>Por hora</h3>
        <div class="legend"><span><i style="background:${WORK}"></i>trabalhando</span><span><i style="background:${WAIT}"></i>esperando você</span></div>
        <div class="hours">${bars}</div></section>
      <section class="card"><h3>Por projeto <small class="muted">quem mais esperou você primeiro</small></h3>
        <table class="usage-table"><thead><tr><th>Onde</th><th class="num">Trabalhando</th><th class="num">Pedindo você</th><th class="num">Terminou, sem ver</th><th>Agentes</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">Nada registrado neste dia. O escritório só conta o que acontece enquanto está ligado.</td></tr>'}</tbody></table></section>`;
  }

  private renderReport() {
    const r = this.report!;
    const cards = r.projects
      .map((p) => {
        const summary = r.summaries[p.place.key];
        const prompts = p.prompts.slice(-8).map((x) => `<li><small>${time(x.at)}</small> ${esc(x.text.slice(0, 180))}</li>`).join('');
        const commits = p.commits.slice(0, 8).map((c) => `<li><code>${esc(c.hash)}</code> ${esc(c.subject)}</li>`).join('');
        const events = p.events.map((e) => `<li><small>${time(e.at)}</small> ${esc(e.text)}</li>`).join('');
        const canSummarize = p.prompts.length || p.commits.length || p.events.length;
        return `<section class="card report">
          <h3>${esc(p.place.label)}</h3>
          <p class="report-meta">${hoursMinutes(p.workMs)} de trabalho · ${p.prompts.length} pedido(s) · ${p.commits.length} commit(s) · ${formatTokens(totalTokens(p.tokens))} tokens (${formatUsd(p.cost)})</p>
          ${summary ? `<p class="report-summary">${esc(summary)}</p>` : canSummarize ? `<button class="btn small ghost" data-summarize="${esc(p.place.key)}" title="O Claude (Haiku) resume os pedidos e commits do dia; usa o seu plano">Resumir com o Claude</button>` : ''}
          ${events ? `<h4>GitHub</h4><ul>${events}</ul>` : ''}
          ${prompts ? `<h4>Pedidos${p.prompts.length > 8 ? ` (os 8 últimos de ${p.prompts.length})` : ''}</h4><ul>${prompts}</ul>` : ''}
          ${commits ? `<h4>Commits${p.commits.length > 8 ? ` (8 de ${p.commits.length})` : ''}</h4><ul>${commits}</ul>` : ''}
        </section>`;
      })
      .join('');
    $('#usage-relatorio').innerHTML = cards || '<p class="muted">Nada neste dia.</p>';
  }

  private async summarize(btn: HTMLButtonElement) {
    const key = btn.dataset.summarize!;
    btn.disabled = true;
    btn.textContent = 'O Claude está resumindo…';
    try {
      const { text } = (await this.api('POST', '/api/dia/resumo', { data: this.date(), key })) as { text: string };
      this.report!.summaries[key] = text;
      this.renderReport();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Resumir com o Claude';
      $('#usage-status').textContent = (err as Error).message;
    }
  }
}
