// Corredores e caminhos: por onde os funcionários andam quando estão fora da mesa.
//
// Cada sala construída do prédio (sala, recepção, copa) tem um corredor em volta. As linhas do
// meio desses corredores formam uma grade: os cruzamentos são os nós, e cada lado do anel de uma
// sala é uma aresta. Uma sala larga (várias vagas na fileira) tem um anel só, sem o corredor de
// dentro. Cada sala tem uma porta no meio da parede de baixo, ligada ao corredor de baixo.
// Ninguém atravessa sala: só se anda pelos corredores e pelas portas.

import type { Cell } from '../shared/building.ts';

/** Uma sala na planta: a vaga onde começa e quantas vagas ocupa na fileira (ausente = 1). */
export type Spot = Cell & { w?: number };

export interface Point {
  x: number;
  y: number;
}

export interface Geometry {
  cellW: number;
  cellH: number;
  /** Largura do corredor entre duas salas. */
  corr: number;
}

export function pitch(g: Geometry) {
  return { w: g.cellW + g.corr, h: g.cellH + g.corr };
}

/**
 * Retângulo de uma sala no mundo (o andar y cresce para cima; no mapa, para cima é y menor).
 * Uma sala de várias vagas engole os corredores entre elas.
 */
export function cellBox(c: Spot, g: Geometry) {
  const p = pitch(g);
  const n = c.w ?? 1;
  // 0 - … em vez de -…: o térreo fica em y = 0, e não -0.
  return { x: c.x * p.w, y: 0 - c.y * p.h, w: n * g.cellW + (n - 1) * g.corr, h: g.cellH };
}

/** Linha vertical do meio do corredor à esquerda da coluna i. */
export function lineX(i: number, g: Geometry) {
  return i * pitch(g).w - g.corr / 2;
}

/** Linha horizontal do meio do corredor embaixo do andar j. */
export function lineY(j: number, g: Geometry) {
  return -j * pitch(g).h + g.cellH + g.corr / 2;
}

/** Ponto da porta de uma vaga, no meio do corredor de baixo. */
export function doorPoint(c: Spot, g: Geometry): Point {
  const b = cellBox(c, g);
  return { x: b.x + b.w / 2, y: lineY(c.y, g) };
}

/** Logo depois de entrar pela porta, dentro da vaga. */
export function insideDoor(c: Spot, g: Geometry): Point {
  const b = cellBox(c, g);
  return { x: b.x + b.w / 2, y: b.y + b.h - 16 };
}

export interface Graph {
  nodes: Map<string, Point>;
  edges: Map<string, Set<string>>;
}

const node = (i: number, j: number) => `${i},${j}`;
const doorNode = (c: Cell) => `porta:${c.x},${c.y}`;

/** Grade de corredores em volta das salas construídas, com uma porta por sala. */
export function buildGraph(built: Spot[], g: Geometry): Graph {
  const nodes = new Map<string, Point>();
  const edges = new Map<string, Set<string>>();
  const add = (id: string, p: Point) => {
    nodes.set(id, p);
    if (!edges.has(id)) edges.set(id, new Set());
  };
  const link = (a: string, b: string) => {
    edges.get(a)!.add(b);
    edges.get(b)!.add(a);
  };
  const corner = (i: number, j: number) => {
    const id = node(i, j);
    add(id, { x: lineX(i, g), y: lineY(j, g) });
    return id;
  };

  for (const c of built) {
    const n = c.w ?? 1;
    // Cantos do anel: embaixo a linha do próprio andar, em cima a do andar de cima. Numa sala
    // larga, os cantos do meio ficam nas linhas de cima e de baixo (cruzamentos com quem encosta).
    const bottom = Array.from({ length: n + 1 }, (_, i) => corner(c.x + i, c.y));
    const top = Array.from({ length: n + 1 }, (_, i) => corner(c.x + i, c.y + 1));
    for (let i = 0; i < n; i++) link(top[i], top[i + 1]);
    link(top[0], bottom[0]);
    link(top[n], bottom[n]);
    // O lado de baixo passa pela porta, no meio da sala.
    const d = doorNode(c);
    const door = doorPoint(c, g);
    add(d, door);
    for (let i = 0; i < n; i++) {
      const left = lineX(c.x + i, g);
      const right = lineX(c.x + i + 1, g);
      if (door.x > left && door.x < right) {
        link(bottom[i], d);
        link(d, bottom[i + 1]);
      } else {
        link(bottom[i], bottom[i + 1]);
        if (door.x === right) link(bottom[i + 1], d);
      }
    }
  }
  return { nodes, edges };
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Menor caminho (Dijkstra) entre dois nós, como lista de pontos. Vazio se não houver caminho. */
export function shortestPath(graph: Graph, from: string, to: string): Point[] {
  if (!graph.nodes.has(from) || !graph.nodes.has(to)) return [];
  const best = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const open = new Set([from]);
  while (open.size) {
    let cur = '';
    let curD = Infinity;
    for (const id of open) {
      const d = best.get(id)!;
      if (d < curD) {
        cur = id;
        curD = d;
      }
    }
    open.delete(cur);
    if (cur === to) break;
    for (const next of graph.edges.get(cur) ?? []) {
      const d = curD + dist(graph.nodes.get(cur)!, graph.nodes.get(next)!);
      if (d < (best.get(next) ?? Infinity)) {
        best.set(next, d);
        prev.set(next, cur);
        open.add(next);
      }
    }
  }
  if (!best.has(to)) return [];
  const ids = [to];
  while (ids[0] !== from) ids.unshift(prev.get(ids[0])!);
  return ids.map((id) => graph.nodes.get(id)!);
}

/** Caminho de dentro de uma vaga até dentro de outra, saindo e entrando pelas portas. */
export function routeBetween(graph: Graph, from: Spot, to: Spot, g: Geometry): Point[] {
  const middle = shortestPath(graph, doorNode(from), doorNode(to));
  if (!middle.length) return [];
  return [insideDoor(from, g), ...middle, insideDoor(to, g)];
}

/** Direção do sprite para andar de a até b. */
export function facing(a: Point, b: Point): 'south' | 'north' | 'east' | 'west' {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west';
  return dy > 0 ? 'south' : 'north';
}

export interface Walker {
  /** Posição dos pés, no mundo. */
  x: number;
  y: number;
  dir: 'south' | 'north' | 'east' | 'west';
  /** Pontos que ainda faltam percorrer. */
  path: Point[];
  /** Parado até este instante (ms), olhando para a frente. */
  restUntil: number;
  /** Sala onde está (ou para onde vai). */
  cell: Spot;
}

/**
 * Anda `speed` px/s por `dt` ms ao longo do caminho. Devolve true quando chega ao fim.
 * Passa de um ponto para o próximo sem perder o que sobrou do passo.
 */
export function step(w: Walker, dt: number, speed: number): boolean {
  let budget = (speed * dt) / 1000;
  while (budget > 0 && w.path.length) {
    const target = w.path[0];
    const d = Math.hypot(target.x - w.x, target.y - w.y);
    if (d > 0.01) w.dir = facing(w, target);
    if (d <= budget) {
      w.x = target.x;
      w.y = target.y;
      w.path.shift();
      budget -= d;
    } else {
      w.x += ((target.x - w.x) / d) * budget;
      w.y += ((target.y - w.y) / d) * budget;
      budget = 0;
    }
  }
  return w.path.length === 0;
}
