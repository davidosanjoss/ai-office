import { describe, expect, it } from 'vitest';
import { MAX_WAR_ROOMS, autoPlace, canPlace, fixedRooms, freeCells, isValidCell, isWarColumn, nextWarCell, occupiedCells } from '../shared/building.ts';
import type { Agent, Room } from '../shared/types.ts';
import { CELL_H, CELL_W, CORR, MAX_VISIBLE_AGENTS, ZOOMS, cellRect, fitCamera, layoutBuilding, stepZoom } from '../web/office.ts';

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

  it('sem salas, os "+" ficam dos lados do elevador, da copa e da sala de guerra, nunca abaixo da primeira fileira', () => {
    expect(keys(freeCells([]))).toEqual(keys([
      { x: -1, y: 0 },
      { x: 2, y: 0 },
      { x: -1, y: 1 },
      { x: 1, y: 1 },
    ]));
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
    expect(first.y).toBe(0);
    expect([-1, 2]).toContain(first.x);
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
    const { rooms } = layoutBuilding([room('a', { x: 1, y: 1 }), room('b', { x: 2, y: 0 })], []);
    // Entre um andar e outro passa um corredor.
    expect(rooms[0].rect).toEqual({ x: CELL_W + CORR, y: -(CELL_H + CORR), w: CELL_W, h: CELL_H });
    expect(rooms[1].rect).toEqual(cellRect({ x: 2, y: 0 }));
  });

  it('sala sem vaga (ainda não migrada) não é desenhada', () => {
    expect(layoutBuilding([room('a')], []).rooms).toEqual([]);
  });

  it('mais agentes que mesas: os primeiros a chegar sentam, o resto vira "+N"', () => {
    const agents = Array.from({ length: MAX_VISIBLE_AGENTS + 3 }, (_, i) => agent(`a${i}`, 'r', i));
    const [r] = layoutBuilding([room('r', { x: 1, y: 1 })], agents.reverse()).rooms;
    expect(r.agents).toHaveLength(MAX_VISIBLE_AGENTS);
    expect(r.agents[0].id).toBe('a0');
    expect(r.overflow).toBe(3);
  });

  it('a caixa do prédio inclui as vagas livres e o "+" da próxima sala de guerra', () => {
    const { bounds, warAdd } = layoutBuilding([], []);
    // Vagas livres de -1 a 2 (4 colunas), com corredor entre elas e meia largura nas pontas.
    expect(bounds.x).toBe(-(CELL_W + CORR) - CORR / 2);
    // Em cima: o "+" da segunda sala de guerra, na fileira 2.
    expect(warAdd).toMatchObject({ x: 0, y: 2 });
    expect(bounds.y).toBe(-2 * (CELL_H + CORR) - CORR / 2);
    expect(bounds.w).toBe(4 * CELL_W + 4 * CORR);
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
