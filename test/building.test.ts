import { describe, expect, it } from 'vitest';
import { MAX_ROOM_W, MAX_WAR_ROOMS, autoPlace, canPlace, closeGap, fixedRooms, freeCells, isValidCell, isWarColumn, nextWarCell, occupiedCells, roomSpans, roomWidth } from '../shared/building.ts';
import type { Agent, Room } from '../shared/types.ts';
import { CELL_H, CELL_W, CORR, MAX_VISIBLE_AGENTS, ZOOMS, cellRect, fitCamera, layoutBuilding, stepZoom, visibleAgents } from '../web/office.ts';

const room = (id: string, pos?: { x: number; y: number }): Room => ({ id, name: id, path: `/${id}`, createdAt: 0, pos });
const keys = (cells: { x: number; y: number }[]) => cells.map((c) => `${c.x},${c.y}`).sort();

describe('planta do prédio', () => {
  it('o térreo é a entrada: recepção e elevadores, e não recebe salas', () => {
    expect(fixedRooms('terreo').map((f) => f.id)).toEqual(['recepcao', 'elevadores']);
    expect(freeCells([], 'terreo')).toEqual([]);
    expect(canPlace([], { x: -1, y: 0 }, 'terreo')).toBe(false);
  });

  it('cada andar de empresa tem o hall dos elevadores, a própria copa e a sala de guerra em cima do elevador', () => {
    expect(fixedRooms('andar').map((f) => f.id)).toEqual(['elevadores', 'copa', 'guerra']);
    expect(occupiedCells([])).toEqual(new Set(['0,0', '1,0', '0,1']));
  });

  it('as salas de guerra empilham para cima, na coluna do elevador', () => {
    const war = fixedRooms('andar', 3).filter((f) => f.id === 'guerra');
    expect(war.map((f) => [f.x, f.y, f.slot])).toEqual([[0, 1, 0], [0, 2, 1], [0, 3, 2]]);
    // O "+" da próxima fica em cima da última, até o limite.
    expect(nextWarCell(3)).toEqual({ x: 0, y: 4 });
    expect(nextWarCell(MAX_WAR_ROOMS)).toBeUndefined();
  });

  it('a coluna em cima do elevador é só das salas de guerra', () => {
    expect(isWarColumn({ x: 0, y: 1 })).toBe(true);
    expect(isWarColumn({ x: 0, y: 7 })).toBe(true);
    expect(isWarColumn({ x: 0, y: 0 })).toBe(false); // o próprio elevador
    expect(isWarColumn({ x: 1, y: 1 })).toBe(false);
    expect(isWarColumn({ x: 0, y: 1 }, 'terreo')).toBe(false);
    // Nenhum "+" de sala de projeto aparece na coluna, com qualquer número de salas de guerra.
    for (const n of [1, 2, MAX_WAR_ROOMS]) {
      expect(freeCells([room('a', { x: 1, y: 1 }), room('b', { x: -1, y: 2 })], 'andar', n).some((c) => isWarColumn(c))).toBe(false);
    }
  });

  it('sem salas, os "+" ficam dos lados da sala de guerra: a primeira fileira é só do elevador e da copa', () => {
    expect(keys(freeCells([]))).toEqual(keys([
      { x: -1, y: 1 },
      { x: 1, y: 1 },
    ]));
    expect(canPlace([], { x: 2, y: 0 })).toBe(false);
    expect(canPlace([], { x: -1, y: 0 })).toBe(false);
  });

  it('uma sala nova libera vagas em volta dela', () => {
    const free = keys(freeCells([room('a', { x: 1, y: 1 })]));
    expect(free).toContain('1,2'); // em cima
    expect(free).toContain('2,1'); // do lado
    expect(free).not.toContain('1,1'); // ocupada
    expect(free).not.toContain('0,1'); // sala de guerra
  });

  it('só dá para pôr sala numa vaga livre encostada no prédio', () => {
    const rooms = [room('a', { x: 1, y: 1 })];
    expect(canPlace(rooms, { x: 1, y: 2 })).toBe(true);
    expect(canPlace(rooms, { x: 1, y: 1 })).toBe(false); // ocupada
    expect(canPlace(rooms, { x: 0, y: 0 })).toBe(false); // elevadores
    expect(canPlace(rooms, { x: 0, y: 2 })).toBe(false); // coluna das salas de guerra
    expect(canPlace(rooms, { x: 5, y: 5 })).toBe(false); // solta, longe do prédio
    expect(canPlace(rooms, { x: 0, y: -1 })).toBe(false); // na rua
  });

  it('vaga automática: a mais baixa e mais perto do centro', () => {
    const first = autoPlace([]);
    expect(first.y).toBe(1);
    expect([-1, 1]).toContain(first.x);
    const rooms = [room('a', first)];
    const second = autoPlace(rooms);
    expect(canPlace(rooms, second)).toBe(true);
  });

  it('valida a vaga recebida da rede', () => {
    expect(isValidCell({ x: 1, y: 2 })).toBe(true);
    expect(isValidCell({ x: 1.5, y: 2 })).toBe(false);
    expect(isValidCell({ x: 1, y: -1 })).toBe(false);
    expect(isValidCell('1,2')).toBe(false);
    expect(isValidCell(null)).toBe(false);
  });
});

describe('salas que crescem com a squad', () => {
  const plan = (id: string, x: number, y: number, w: number, createdAt = 0) => ({ id, pos: { x, y }, w, createdAt });
  const spansOf = (rooms: ReturnType<typeof plan>[]) => {
    const m = roomSpans(rooms);
    return Object.fromEntries(rooms.map((r) => [r.id, m.get(r)]));
  };

  it('até 3 agentes, 1 vaga; 4 a 7, 2; 8 a 11, 3; 12 ou mais, 4', () => {
    expect([0, 3, 4, 7, 8, 11, 12, 40].map(roomWidth)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(roomWidth(100)).toBe(MAX_ROOM_W);
  });

  it('cresce para longe da coluna das salas de guerra: para a direita de um lado, para a esquerda do outro', () => {
    expect(spansOf([plan('d', 1, 1, 3), plan('e', -1, 1, 2)])).toEqual({ d: { x: 1, y: 1, w: 3 }, e: { x: -2, y: 1, w: 2 } });
  });

  it('empurra a vizinha da mesma fileira, e ela volta para a vaga dela quando a sala encolhe', () => {
    expect(spansOf([plan('a', 1, 1, 2), plan('b', 2, 1, 1), plan('c', 4, 1, 1)])).toEqual({
      a: { x: 1, y: 1, w: 2 },
      b: { x: 3, y: 1, w: 1 },
      c: { x: 4, y: 1, w: 1 },
    });
    // Mais gente em a: b e c vão juntos para fora.
    expect(spansOf([plan('a', 1, 1, 4), plan('b', 2, 1, 1), plan('c', 4, 1, 1)])).toMatchObject({ b: { x: 5 }, c: { x: 6 } });
    // a encolheu: cada uma volta para a própria vaga.
    expect(spansOf([plan('a', 1, 1, 1), plan('b', 2, 1, 1), plan('c', 4, 1, 1)])).toMatchObject({ b: { x: 2 }, c: { x: 4 } });
    // Do lado esquerdo, empurra para a esquerda.
    expect(spansOf([plan('a', -1, 2, 3), plan('b', -2, 2, 1)])).toMatchObject({ a: { x: -3, w: 3 }, b: { x: -4 } });
  });

  it('outras fileiras não mudam', () => {
    expect(spansOf([plan('a', 1, 1, 4), plan('b', 2, 2, 1)])).toMatchObject({ b: { x: 2, y: 2 } });
  });

  it('as vagas de uma sala larga ficam ocupadas, e os "+" aparecem em volta dela toda', () => {
    const rooms = [plan('a', 1, 1, 3)];
    const taken = occupiedCells(rooms);
    for (const k of ['1,1', '2,1', '3,1']) expect(taken.has(k)).toBe(true);
    const free = keys(freeCells(rooms));
    expect(free).toEqual(expect.arrayContaining(['4,1', '1,2', '2,2', '3,2']));
    expect(canPlace(rooms, { x: 2, y: 1 })).toBe(false);
  });
});

describe('sala que sai do andar', () => {
  const plan = (id: string, x: number, y: number, w = 1) => ({ id, pos: { x, y }, w, createdAt: 0 });
  const moved = (rooms: ReturnType<typeof plan>[], removedId: string) =>
    Object.fromEntries([...closeGap(rooms, rooms.find((r) => r.id === removedId)!)].map(([r, c]) => [r.id, c]));

  it('as salas de fora, na mesma fileira, andam para o lugar vago, uma atrás da outra', () => {
    expect(moved([plan('a', 1, 1), plan('b', 2, 1, 2), plan('c', 4, 1)], 'a')).toEqual({ b: { x: 1, y: 1 }, c: { x: 3, y: 1 } });
    // Do lado esquerdo, para a direita (rumo à sala de guerra).
    expect(moved([plan('a', -1, 1, 2), plan('b', -3, 1)], 'a')).toEqual({ b: { x: -1, y: 1 } });
  });

  it('quem tem sala encostada em cima ou embaixo fica, e segura as de fora', () => {
    const rooms = [plan('a', 1, 1), plan('b', 2, 1), plan('cima', 2, 2), plan('c', 3, 1)];
    expect(moved(rooms, 'a')).toEqual({});
    // Sem nada encostado, anda; a de cima de outra sala não conta para quem não está embaixo dela.
    expect(moved([plan('a', 1, 2), plan('b', 2, 2), plan('baixo', 1, 1)], 'a')).toEqual({ b: { x: 1, y: 2 } });
  });

  it('outras fileiras, o outro lado e as salas de dentro não andam', () => {
    expect(moved([plan('dentro', 1, 1), plan('a', 2, 1), plan('fora', 3, 1), plan('esq', -1, 1), plan('acima', 3, 2)], 'a')).toEqual({});
    expect(moved([plan('dentro', 1, 1), plan('a', 2, 1), plan('fora', 3, 1), plan('esq', -1, 1)], 'a')).toEqual({ fora: { x: 2, y: 1 } });
  });

  it('sala larga que empurrava a vizinha: a vizinha vem até a ponta de dentro do lugar vago', () => {
    expect(moved([plan('a', 1, 1, 3), plan('b', 2, 1)], 'a')).toEqual({ b: { x: 1, y: 1 } });
  });
});

describe('desenho do prédio', () => {
  const agent = (id: string, roomId: string, createdAt: number): Agent => ({
    id,
    roomId,
    name: id,
    cwd: '/',
    sessionId: id,
    status: 'idle',
    activity: '',
    subagents: 0,
    createdAt,
  });

  it('cada sala vai para a sua vaga; andar de cima fica acima no mapa', () => {
    const { rooms } = layoutBuilding([room('a', { x: 1, y: 1 }), room('b', { x: 2, y: 2 })], []);
    // Entre um andar e outro passa um corredor.
    expect(rooms[0].rect).toEqual({ x: CELL_W + CORR, y: -(CELL_H + CORR), w: CELL_W, h: CELL_H });
    expect(rooms[1].rect).toEqual(cellRect({ x: 2, y: 2 }));
  });

  it('sala sem vaga (ainda não migrada) não é desenhada', () => {
    expect(layoutBuilding([room('a')], []).rooms).toEqual([]);
  });

  it('a sala cresce com a squad e engole o corredor entre as vagas; terminais não contam', () => {
    const squad = Array.from({ length: 5 }, (_, i) => agent(`a${i}`, 'r', i));
    const shells = Array.from({ length: 6 }, (_, i) => ({ ...agent(`t${i}`, 'r', 10 + i), kind: 'shell' as const }));
    const [r] = layoutBuilding([room('r', { x: 1, y: 1 })], [...squad, ...shells]).rooms;
    expect(r.span).toEqual({ x: 1, y: 1, w: 2 });
    expect(r.rect).toEqual({ ...cellRect({ x: 1, y: 1 }), w: 2 * CELL_W + CORR });
    expect(visibleAgents(cellRect({ x: 0, y: 0 }))).toBe(MAX_VISIBLE_AGENTS);
    expect(visibleAgents(r.rect)).toBeGreaterThan(MAX_VISIBLE_AGENTS);
  });

  it('mais agentes que mesas: os primeiros a chegar sentam, o resto vira "+N"', () => {
    const [cheia] = layoutBuilding([room('r', { x: 1, y: 1 })], []).rooms;
    const max = visibleAgents({ ...cheia.rect, w: 4 * CELL_W + 3 * CORR });
    const agents = Array.from({ length: max + 3 }, (_, i) => agent(`a${i}`, 'r', i));
    const [r] = layoutBuilding([room('r', { x: 1, y: 1 })], agents.reverse()).rooms;
    expect(r.span.w).toBe(4);
    expect(r.agents).toHaveLength(max);
    expect(r.agents[0].id).toBe('a0');
    expect(r.overflow).toBe(3);
  });

  it('a caixa do prédio inclui as vagas livres e o "+" da próxima sala de guerra', () => {
    const { bounds, warAdd } = layoutBuilding([], []);
    // Vagas livres em -1 e 1 (na fileira 1): de -1 a 1, 3 colunas, com corredor entre elas e meia largura nas pontas.
    expect(bounds.x).toBe(-(CELL_W + CORR) - CORR / 2);
    // Em cima: o "+" da segunda sala de guerra, na fileira 2.
    expect(warAdd).toMatchObject({ x: 0, y: 2 });
    expect(bounds.y).toBe(-2 * (CELL_H + CORR) - CORR / 2);
    expect(bounds.w).toBe(3 * CELL_W + 3 * CORR);
    expect(bounds.h).toBeGreaterThan(2 * CELL_H);
  });
});

describe('câmera', () => {
  it('enquadra o prédio inteiro com o maior zoom que cabe', () => {
    const bounds = { x: 0, y: 0, w: 1000, h: 400 };
    expect(fitCamera(bounds, 1100, 500)).toEqual({ x: 500, y: 200, z: 1 });
    expect(fitCamera(bounds, 2200, 1000)).toEqual({ x: 500, y: 200, z: 2 });
    expect(fitCamera(bounds, 300, 300).z).toBe(ZOOMS[0]);
  });

  it('zoom anda pelos níveis e para nas pontas', () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(ZOOMS[0], -1)).toBe(ZOOMS[0]);
    expect(stepZoom(ZOOMS.at(-1)!, 1)).toBe(ZOOMS.at(-1));
  });
});

describe('andares na tela', () => {
  it('térreo: recepção, elevadores e a rua; andares de empresa: sem rua', () => {
    const terreo = layoutBuilding([], [], 'terreo');
    const andar = layoutBuilding([], [], 'andar');
    expect(terreo.fixed.map((f) => f.id)).toEqual(['recepcao', 'elevadores']);
    expect(terreo.free).toEqual([]);
    expect(andar.fixed.map((f) => f.id)).toEqual(['elevadores', 'copa', 'guerra']);
    expect(terreo.warAdd).toBeUndefined();
    // A caixa do térreo (uma fileira) inclui a rua embaixo; a do andar (elevador e sala de guerra
    // em cima), só as duas fileiras.
    expect(terreo.core.h).toBeGreaterThan(CELL_H + CORR);
    expect(andar.core.h).toBe(2 * (CELL_H + CORR));
  });
});
