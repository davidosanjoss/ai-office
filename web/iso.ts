// Projeção do mapa. A planta do prédio (shared/building.ts, web/walk.ts) continua 2D: vagas,
// corredores e caminhos em pixels do mundo. Só o desenho é projetado na tela, e os cliques fazem
// o caminho de volta.
//
// Na projeção isométrica (2:1), andar para a direita na planta (+x) desce para a direita na tela,
// e andar para baixo na planta (+y, rumo à rua) desce para a esquerda. Quem está mais perto de
// quem olha tem x + y maior: é por essa soma que se desenha de trás para a frente.

export type Projection = 'topo' | 'iso';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A projeção como matriz do canvas (a, b, c, d de setTransform): x' = a·x + c·y, y' = b·x + d·y.
 * Desenhar com ela aplicada deita o desenho no chão (pisos, tapetes, a rua).
 */
export function floorMatrix(mode: Projection): [number, number, number, number] {
  return mode === 'iso' ? [1, 0.5, -1, 0.5] : [1, 0, 0, 1];
}

/** Ponto da planta → ponto da tela (no mundo, antes da câmera). `z` sobe na tela, em pixels. */
export function toScreen(p: Point, mode: Projection, z = 0): Point {
  if (mode === 'iso') return { x: p.x - p.y, y: (p.x + p.y) / 2 - z };
  return { x: p.x, y: p.y - z };
}

/** Ponto da tela (no mundo) → ponto do chão da planta. Inversa de toScreen com z = 0. */
export function toPlan(s: Point, mode: Projection): Point {
  if (mode === 'iso') return { x: s.y + s.x / 2, y: s.y - s.x / 2 };
  return { x: s.x, y: s.y };
}

const corners = (r: Rect): Point[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
];

function boxOf(points: Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Caixa na tela de um retângulo da planta (com `height` de paredes em pé por cima do chão). */
export function projectRect(r: Rect, mode: Projection, height = 0): Rect {
  const pts = corners(r).flatMap((c) => [toScreen(c, mode), toScreen(c, mode, height)]);
  return boxOf(pts);
}

/** Retângulo da tela → caixa da planta que ele enxerga (para não desenhar o que está fora). */
export function planBox(view: Rect, mode: Projection): Rect {
  return boxOf(corners(view).map((c) => toPlan(c, mode)));
}

/** Ordem de desenho: maior = mais perto de quem olha = desenhado por cima. */
export function depth(p: Point, mode: Projection): number {
  return mode === 'iso' ? p.x + p.y : p.y;
}

/** Área clicável: no chão (planta: salas, vagas) ou em pé (tela: um funcionário, uma mesa). */
export interface Area extends Rect {
  /** Ausente = no chão. */
  space?: 'plan' | 'screen';
}

/** A área clicada: a última desenhada que contém o ponto (quem está na frente ganha). */
export function pick<T extends Area>(areas: T[], screen: Point, mode: Projection): T | undefined {
  const plan = toPlan(screen, mode);
  for (let i = areas.length - 1; i >= 0; i--) {
    const a = areas[i];
    const p = a.space === 'screen' ? screen : plan;
    if (p.x >= a.x && p.x < a.x + a.w && p.y >= a.y && p.y < a.y + a.h) return a;
  }
  return undefined;
}

export type PlanDir = 'south' | 'north' | 'east' | 'west';
export type ScreenDir = PlanDir | 'south-east' | 'south-west' | 'north-east' | 'north-west';

/** Para onde a pessoa olha na tela quando anda numa direção da planta. */
export function screenDir(dir: PlanDir, mode: Projection): ScreenDir {
  if (mode === 'topo') return dir;
  return ({ east: 'south-east', south: 'south-west', west: 'north-west', north: 'north-east' } as const)[dir];
}
