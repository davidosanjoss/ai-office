#!/usr/bin/env node
// Statusline das sessões abertas pelo escritório. O Claude Code passa aqui, a cada atualização, o
// uso oficial do plano (rate_limits: janela de 5 horas e semana, com a hora de reiniciar): ele vai
// para o escritório, que mostra no painel de consumo. A linha mostrada é a sua statusline, se você
// tem uma (AI_OFFICE_STATUSLINE, com o mesmo JSON); senão, um resumo curto do plano.
// Nunca atrapalha a sessão: qualquer erro só deixa a linha vazia.

import { spawnSync } from 'node:child_process';

const url = process.env.AI_OFFICE_URL;
const agentId = process.env.AI_OFFICE_AGENT_ID;
const mine = process.env.AI_OFFICE_STATUSLINE;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  let data = {};
  try {
    data = JSON.parse(input || '{}');
  } catch {}
  const limits = data.rate_limits;
  if (url && limits && typeof limits === 'object') {
    try {
      await fetch(`${url}/api/plano`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, rate_limits: limits }),
        signal: AbortSignal.timeout(800),
      });
    } catch {}
  }
  if (mine) {
    const r = spawnSync(mine, { shell: true, input, encoding: 'utf8', timeout: 5000 });
    process.stdout.write(r.stdout ?? '');
    return;
  }
  const pct = (w) => (w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : '');
  const parts = [pct(limits?.five_hour) && `5h ${pct(limits.five_hour)}`, pct(limits?.seven_day) && `semana ${pct(limits.seven_day)}`].filter(Boolean);
  process.stdout.write(parts.length ? `plano: ${parts.join(' · ')}` : '');
});
