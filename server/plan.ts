// Uso oficial do plano (Pro, Max, Ultra): a statusline das sessões do escritório entrega os
// rate_limits do Claude Code (hooks/office-statusline.mjs → POST /api/plano). Guardado no disco
// para sobreviver ao reinício do servidor; vale até cada janela reiniciar.

import fs from 'node:fs';
import path from 'node:path';
import { type PlanUsage, parsePlan } from '../shared/usage.ts';
import { DATA_DIR } from './platform.ts';

const FILE = path.join(DATA_DIR, 'uso', 'plano.json');
let current: PlanUsage | undefined;
let loaded = false;

export function planUsage(): PlanUsage | undefined {
  if (!loaded) {
    loaded = true;
    try {
      current = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {}
  }
  return current;
}

/** Chegou da statusline: guarda (uma janela que não veio desta vez mantém o último número dela). */
export function recordPlan(raw: unknown, now = Date.now()): PlanUsage | undefined {
  const plan = parsePlan(raw, now);
  if (!plan) return undefined;
  const before = planUsage();
  current = { fiveHour: plan.fiveHour ?? before?.fiveHour, sevenDay: plan.sevenDay ?? before?.sevenDay, updatedAt: now };
  if (!current.fiveHour) delete current.fiveHour;
  if (!current.sevenDay) delete current.sevenDay;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(current));
  return current;
}

/** Só para os testes. */
export function resetPlan() {
  current = undefined;
  loaded = false;
  fs.rmSync(FILE, { force: true });
}
