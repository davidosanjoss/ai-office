// Planta de um andar do prédio: uma grade de vagas.
//
// O térreo é a entrada: recepção e elevadores, com a rua embaixo, e não recebe salas.
// Cada andar de empresa tem o hall dos elevadores e a copa fixos na primeira fileira; as salas
// de projeto ocupam vagas livres encostadas em alguma sala, dos lados, em cima ou embaixo.
// Usado pelo servidor (validar e escolher vagas) e pelo navegador (desenhar e mostrar os "+").

export interface Cell {
  x: number;
  /** Fileira da planta: 0 é a primeira (a do elevador), cresce para cima. Não há fileira negativa. */
  y: number;
}

export type FloorKind = 'terreo' | 'andar';

export interface FixedRoom extends Cell {
  id: 'recepcao' | 'elevadores' | 'copa';
  name: string;
}

/** Salas fixas de cada tipo de andar. */
export function fixedRooms(kind: FloorKind): FixedRoom[] {
  return kind === 'terreo'
    ? [
        { id: 'recepcao', name: 'Recepção', x: 0, y: 0 },
        { id: 'elevadores', name: 'Elevadores', x: 1, y: 0 },
      ]
    : [
        { id: 'elevadores', name: 'Elevadores', x: 0, y: 0 },
        { id: 'copa', name: 'Copa', x: 1, y: 0 },
      ];
}

export const cellKey = (c: Cell) => `${c.x},${c.y}`;

export function isValidCell(c: unknown): c is Cell {
  if (!c || typeof c !== 'object') return false;
  const { x, y } = c as Cell;
  return Number.isInteger(x) && Number.isInteger(y) && y >= 0 && Math.abs(x) <= 1000 && y <= 1000;
}

/** Vagas ocupadas de um andar de empresa: as fixas e as das salas que já têm posição. */
export function occupiedCells(rooms: { pos?: Cell }[], kind: FloorKind = 'andar'): Set<string> {
  const set = new Set(fixedRooms(kind).map(cellKey));
  for (const r of rooms) if (r.pos) set.add(cellKey(r.pos));
  return set;
}

/** Vizinhas de uma vaga onde uma sala nova pode encostar: dos lados, em cima e embaixo. */
function neighbors(c: Cell): Cell[] {
  return [
    { x: c.x - 1, y: c.y },
    { x: c.x + 1, y: c.y },
    { x: c.x, y: c.y + 1 },
    { x: c.x, y: c.y - 1 },
  ].filter((n) => n.y >= 0);
}

/**
 * Vagas livres encostadas no andar: onde aparecem os botões "+".
 * `rooms` são só as salas DESTE andar. O térreo não recebe salas.
 */
export function freeCells(rooms: { pos?: Cell }[], kind: FloorKind = 'andar'): Cell[] {
  if (kind === 'terreo') return [];
  const taken = occupiedCells(rooms, kind);
  const cells = [...fixedRooms(kind), ...rooms.map((r) => r.pos).filter((p): p is Cell => !!p)];
  const out = new Map<string, Cell>();
  for (const c of cells) {
    for (const n of neighbors(c)) if (!taken.has(cellKey(n))) out.set(cellKey(n), n);
  }
  return [...out.values()].sort((a, b) => a.y - b.y || Math.abs(a.x - 0.5) - Math.abs(b.x - 0.5) || a.x - b.x);
}

export function canPlace(rooms: { pos?: Cell }[], c: Cell, kind: FloorKind = 'andar'): boolean {
  return isValidCell(c) && freeCells(rooms, kind).some((f) => f.x === c.x && f.y === c.y);
}

/** Vaga automática (para "+ Sala" e salas movidas): a livre mais baixa e mais perto do centro. */
export function autoPlace(rooms: { pos?: Cell }[], kind: FloorKind = 'andar'): Cell {
  return freeCells(rooms, kind)[0];
}

/** Cores para os andares: paredes, placas e o botão do elevador. */
export const FLOOR_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64', '#c0caf5'];
