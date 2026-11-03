import { describe, expect, it } from 'vitest';
import { buildGraph, cellBox, doorPoint, facing, insideDoor, lineX, lineY, routeBetween, shortestPath, step, type Geometry, type Walker } from '../web/walk.ts';

const G: Geometry = { cellW: 100, cellH: 80, corr: 20 };
const recepcao = { x: 0, y: 0 };
const copa = { x: 1, y: 0 };
const sala = { x: 0, y: 1 };

/** Um ponto está no meio de algum corredor (nunca dentro de uma sala)? */
function onCorridor(p: { x: number; y: number }, cells: { x: number; y: number }[]) {
  const inside = cells.some((c) => {
    const b = cellBox(c, G);
    return p.x > b.x + 1 && p.x < b.x + b.w - 1 && p.y > b.y + 1 && p.y < b.y + b.h - 1;
  });
  return !inside;
}

describe('rede de corredores', () => {
  it('corredores ficam entre as vagas', () => {
    expect(cellBox({ x: 1, y: 0 }, G)).toEqual({ x: 120, y: 0, w: 100, h: 80 });
    expect(cellBox({ x: 0, y: 1 }, G)).toEqual({ x: 0, y: -100, w: 100, h: 80 });
    expect(lineX(1, G)).toBe(110); // meio do corredor entre as colunas 0 e 1
    expect(lineY(0, G)).toBe(90); // meio do corredor embaixo do térreo
    expect(lineY(1, G)).toBe(-10); // entre o térreo e o primeiro andar
  });

  it('a porta fica no meio do corredor de baixo da vaga', () => {
    expect(doorPoint(sala, G)).toEqual({ x: 50, y: -10 });
    expect(insideDoor(sala, G).y).toBeLessThan(-20);
  });

  it('só existem corredores em volta de vagas construídas', () => {
    const g = buildGraph([recepcao], G);
    // 4 cantos + a porta
    expect(g.nodes.size).toBe(5);
    expect(g.nodes.has('2,0')).toBe(false);
  });

  it('o caminho da sala de cima até a copa só passa por corredores', () => {
    const built = [recepcao, copa, sala];
    const g = buildGraph(built, G);
    const path = shortestPath(g, 'porta:0,1', 'porta:1,0');
    expect(path.length).toBeGreaterThan(2);
    for (const p of path) expect(onCorridor(p, built), JSON.stringify(p)).toBe(true);
  });

  it('rota completa: de dentro de uma sala até dentro de outra, pelas portas', () => {
    const route = routeBetween(buildGraph([recepcao, copa, sala], G), sala, copa, G);
    expect(route[0]).toEqual(insideDoor(sala, G));
    expect(route[1]).toEqual(doorPoint(sala, G));
    expect(route.at(-2)).toEqual(doorPoint(copa, G));
    expect(route.at(-1)).toEqual(insideDoor(copa, G));
  });

  it('vaga solta, sem corredor que chegue nela: sem caminho', () => {
    const g = buildGraph([recepcao, { x: 5, y: 5 }], G);
    expect(shortestPath(g, 'porta:0,0', 'porta:5,5')).toEqual([]);
    expect(shortestPath(g, 'porta:0,0', 'nao-existe')).toEqual([]);
  });

  it('pega o caminho mais curto', () => {
    const built = [recepcao, copa, { x: 0, y: 1 }, { x: 1, y: 1 }];
    const g = buildGraph(built, G);
    const path = shortestPath(g, 'porta:0,0', 'porta:1,0');
    // Da porta da recepção à da copa: vai reto pelo corredor de baixo.
    expect(path.every((p) => p.y === lineY(0, G))).toBe(true);
  });
});

describe('andar', () => {
  const walker = (path: { x: number; y: number }[]): Walker => ({ x: 0, y: 0, dir: 'south', path, restUntil: 0, cell: recepcao });

  it('anda na velocidade certa e vira para onde vai', () => {
    const w = walker([{ x: 100, y: 0 }]);
    expect(step(w, 1000, 30)).toBe(false);
    expect(w.x).toBeCloseTo(30);
    expect(w.dir).toBe('east');
  });

  it('dobra a esquina sem perder o resto do passo', () => {
    const w = walker([
      { x: 10, y: 0 },
      { x: 10, y: -100 },
    ]);
    step(w, 1000, 30);
    expect(w.x).toBe(10);
    expect(w.y).toBeCloseTo(-20);
    expect(w.dir).toBe('north');
  });

  it('chega ao fim', () => {
    const w = walker([{ x: 5, y: 0 }]);
    expect(step(w, 1000, 30)).toBe(true);
    expect(w).toMatchObject({ x: 5, y: 0, path: [] });
  });

  it('direção do sprite', () => {
    expect(facing({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe('south');
    expect(facing({ x: 0, y: 0 }, { x: -10, y: 2 })).toBe('west');
  });
});

describe('sala larga', () => {
  const G = { cellW: 100, cellH: 80, corr: 20 };

  it('ocupa as vagas e o corredor entre elas, com uma porta só, no meio', () => {
    expect(cellBox({ x: 1, y: 1, w: 3 }, G)).toEqual({ x: 120, y: -100, w: 340, h: 80 });
    expect(doorPoint({ x: 1, y: 1, w: 3 }, G).x).toBe(120 + 170);
    expect(doorPoint({ x: 1, y: 1, w: 2 }, G).x).toBe(lineX(2, G));
  });

  it('ninguém atravessa a sala pelo corredor que ela engoliu', () => {
    const g = buildGraph([{ x: 1, y: 1, w: 3 }], G);
    // As linhas verticais do meio (x = 2 e x = 3) não ligam a fileira de baixo à de cima.
    for (const i of [2, 3]) expect(g.edges.get(`${i},1`)?.has(`${i},2`) ?? false).toBe(false);
    expect(g.edges.get('1,1')!.has('1,2')).toBe(true);
    expect(g.edges.get('4,1')!.has('4,2')).toBe(true);
    expect([...g.nodes.keys()].filter((k) => k.startsWith('porta:'))).toEqual(['porta:1,1']);
  });

  it('dá para ir de uma sala larga até outra sala pelos corredores', () => {
    const g = buildGraph([{ x: 1, y: 1, w: 2 }, { x: 1, y: 2 }, { x: 3, y: 1 }], G);
    expect(routeBetween(g, { x: 1, y: 1, w: 2 }, { x: 3, y: 1 }, G).length).toBeGreaterThan(2);
    expect(routeBetween(g, { x: 1, y: 2 }, { x: 1, y: 1, w: 2 }, G).length).toBeGreaterThan(2);
  });
});
