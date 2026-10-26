// Planta do prédio: uma grade de vagas. O térreo (y = 0) tem a recepção e a copa fixas e a rua
// embaixo; as salas de projeto ocupam vagas livres encostadas em alguma sala, dos lados ou em cima.
// Usado pelo servidor (validar e escolher vagas) e pelo navegador (desenhar e mostrar os "+").

export interface Cell {
  x: number;
  /** Andar: 0 é o térreo, cresce para cima. Não existe andar negativo (lá é a rua). */
  y: number;
}

export interface FixedRoom extends Cell {
  id: 'recepcao' | 'copa';
  name: string;
}

export const FIXED_ROOMS: FixedRoom[] = [
  { id: 'recepcao', name: 'Recepção', x: 0, y: 0 },
  { id: 'copa', name: 'Copa', x: 1, y: 0 },
];

export const cellKey = (c: Cell) => `${c.x},${c.y}`;

export function isValidCell(c: unknown): c is Cell {
  if (!c || typeof c !== 'object') return false;
  const { x, y } = c as Cell;
  return Number.isInteger(x) && Number.isInteger(y) && y >= 0 && Math.abs(x) <= 1000 && y <= 1000;
}

/** Vagas ocupadas: as fixas e as das salas que já têm posição. */
export function occupiedCells(rooms: { pos?: Cell }[]): Set<string> {
  const set = new Set(FIXED_ROOMS.map(cellKey));
  for (const r of rooms) if (r.pos) set.add(cellKey(r.pos));
  return set;
}

/** Vizinhas de uma vaga onde uma sala nova pode encostar: dos lados, em cima e embaixo (sem descer para a rua). */
function neighbors(c: Cell): Cell[] {
  return [
    { x: c.x - 1, y: c.y },
    { x: c.x + 1, y: c.y },
    { x: c.x, y: c.y + 1 },
    { x: c.x, y: c.y - 1 },
  ].filter((n) => n.y >= 0);
}

/** Vagas livres encostadas no prédio: onde aparecem os botões "+". */
export function freeCells(rooms: { pos?: Cell }[]): Cell[] {
  const taken = occupiedCells(rooms);
  const cells = [...FIXED_ROOMS, ...rooms.map((r) => r.pos).filter((p): p is Cell => !!p)];
  const out = new Map<string, Cell>();
  for (const c of cells) {
    for (const n of neighbors(c)) if (!taken.has(cellKey(n))) out.set(cellKey(n), n);
  }
  return [...out.values()].sort((a, b) => a.y - b.y || Math.abs(a.x - 0.5) - Math.abs(b.x - 0.5) || a.x - b.x);
}

export function canPlace(rooms: { pos?: Cell }[], c: Cell): boolean {
  return isValidCell(c) && freeCells(rooms).some((f) => f.x === c.x && f.y === c.y);
}

/** Vaga automática (para "+ Sala" e salas antigas): a livre mais baixa e mais perto do centro. */
export function autoPlace(rooms: { pos?: Cell }[]): Cell {
  return freeCells(rooms)[0];
}
