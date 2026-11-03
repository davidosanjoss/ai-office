// Escritório em pixel art: um prédio em isométrico. O térreo tem a recepção e a copa; cada
// projeto é uma sala encostada no prédio, e cada funcionário é um agente. O mapa é maior que a
// tela: arraste para navegar e use a rodinha para o zoom.
//
// Desenha o mundo em baixa resolução num canvas fora da tela (só a parte visível) e amplia sem
// suavização; os textos são desenhados depois, já na escala da tela, para ficarem legíveis.
// A arte vem do PixelLab (web/sprites.ts); paredes, balcões, rua e balões são desenhados aqui.

import { type Cell, type FixedRoom, type FloorKind, fixedRooms, freeCells, nextWarCell } from '../shared/building.ts';
import type { Agent, AgentStatus, Incident, Room } from '../shared/types.ts';
import { type Area, type Projection, type ScreenDir, depth, floorMatrix, pick, planBox, projectRect, screenDir, toScreen as project } from './iso.ts';
import { type Anim, RECEPCIONISTA, Sprites, characterFor } from './sprites.ts';
import {
  type Geometry,
  type Point,
  type Walker,
  buildGraph,
  cellBox,
  insideDoor,
  routeBetween,
  step,
} from './walk.ts';

/** Tamanho de uma vaga do prédio (uma sala), em pixels do mundo. */
export const CELL_W = 344;
export const CELL_H = 260;
const SLOT_W = 80;
const SLOT_H = 104;
const WALL_H = 40;
const PAD = 12;
/** Mesas por sala: 4 por fileira, 2 fileiras. A última vaga visível é sempre a mesa de contratar. */
const COLS = 4;
const ROWS = 2;
export const MAX_VISIBLE_AGENTS = COLS * ROWS - 1;
/** Corredor em volta de cada sala: é por ele que os funcionários andam. */
export const CORR = 48;
const GEO: Geometry = { cellW: CELL_W, cellH: CELL_H, corr: CORR };
const STREET_H = 92;
/** Onde a calçada começa: logo embaixo do corredor do térreo. */
const STREET_Y = CELL_H + CORR;
const FPS = 12;
/** Velocidade de quem anda pelos corredores, em pixels do mundo por segundo. */
const WALK_SPEED = 28;
/** Cadeira (os pés de quem senta) e mesa da vaga de funcionário número i de uma sala, na planta. */
export function deskSpot(room: Rect, i: number): { seat: Point; desk: Point } {
  const o = slotOrigin(room, i);
  const cx = o.x + SLOT_W / 2;
  return { seat: { x: cx + SEAT_DX, y: o.y + DESK_Y - 2 }, desk: { x: cx, y: o.y + DESK_Y + 18 } };
}

/** Onde fica a mesa dentro da vaga de funcionário: baixa o bastante para o monitor não tapar o rosto. */
const DESK_Y = 50;
/**
 * Altura da cabeça do funcionário sentado atrás da mesa. Ele é posicionado pela cabeça, não
 * pelos pés: a animação de digitar é sentada (mais baixa) e afundaria atrás da mesa.
 */
export const HEAD_Y = 36;
/** O funcionário senta um pouco à esquerda: o monitor (de costas para nós) fica à direita do rosto. */
const SEAT_DX = -6;
/** Altura das paredes do fundo de cada vaga, na tela. As da frente são baixas, em corte. */
const WALL_UP = 56;
const WALL_LOW = 7;
const WALL_DARK = '#2a2438';
/** Altura da placa com o nome da sala, na parede do fundo. */
const SIGN_Z = 46;
/** Raios da mesa redonda da sala de guerra, na planta. */
const WAR_RX = 84;
const WAR_RY = 54;
/** Animação de andar que existe (de cima) mais parecida com cada diagonal da tela. */
const WALK_FALLBACK: Partial<Record<ScreenDir, string>> = { 'south-east': 'east', 'north-west': 'west', 'south-west': 'south', 'north-east': 'north' };
export const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3];
/** Como o mapa é desenhado: a câmera e os cliques ficam na tela, a planta continua 2D. */
export const VIEW: Projection = 'iso';

export const STATUS_COLOR: Record<AgentStatus, string> = {
  starting: '#565f89',
  idle: '#a9b1d6',
  working: '#7dcfff',
  waiting: '#e0af68',
  done: '#9ece6a',
  exited: '#414868',
};

/** Animação de cada estado. Quem terminou comemora, com o balão ✓. */
const ANIM_FOR: Record<AgentStatus, string | undefined> = {
  starting: 'parado',
  idle: 'parado',
  working: 'digitando',
  waiting: 'mao',
  done: 'comemorando',
  exited: undefined,
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Hit =
  | (Area & { kind: 'agent' | 'add' | 'room'; id: string })
  | (Area & { kind: 'newroom'; cell: Cell })
  | (Area & { kind: 'war'; slot: number })
  | (Area & { kind: 'newwar' });

export interface PlacedRoom {
  room: Room;
  rect: Rect;
  /** Agentes com mesa visível (os primeiros a chegar). */
  agents: Agent[];
  /** Quantos não couberam na sala. */
  overflow: number;
}

export interface BuildingLayout {
  rooms: PlacedRoom[];
  fixed: (FixedRoom & { rect: Rect })[];
  free: (Cell & { rect: Rect })[];
  /** Vaga do "+" que abre mais uma sala de guerra, em cima da última. */
  warAdd?: Cell & { rect: Rect };
  /** Caixa que contém o prédio, as vagas livres e a rua. */
  bounds: Rect;
  /** Só o prédio construído e a rua: é o que o enquadramento inicial mostra. */
  core: Rect;
}

export function cellRect(c: Cell): Rect {
  return cellBox(c, GEO);
}

/** A vaga com o corredor em volta (metade da largura de cada lado). */
function withCorridor(r: Rect): Rect {
  return { x: r.x - CORR / 2, y: r.y - CORR / 2, w: r.w + CORR, h: r.h + CORR };
}

/** Canto superior esquerdo da vaga de funcionário número i dentro de uma sala. */
export function slotOrigin(room: Rect, i: number): { x: number; y: number } {
  return { x: room.x + PAD + (i % COLS) * SLOT_W, y: room.y + WALL_H + 4 + Math.floor(i / COLS) * SLOT_H };
}

/** Onde cada coisa fica no mundo: salas nas vagas, as fixas no térreo e os "+" nas vagas livres. */
/** O andar que está na tela: o térreo (entrada) ou um andar de empresa, com a cor dele. */
export interface FloorView {
  id: string;
  kind: FloorKind;
  color: string;
  /** Salas de guerra do andar (ausente = 1). */
  warRooms?: number;
}

export function layoutBuilding(rooms: Room[], agents: Agent[], kind: FloorKind = 'andar', warRooms = 1): BuildingLayout {
  const placed: PlacedRoom[] = rooms
    .filter((r) => r.pos)
    .map((room) => {
      const inRoom = agents.filter((a) => a.roomId === room.id).sort((a, b) => a.createdAt - b.createdAt);
      return {
        room,
        rect: cellRect(room.pos!),
        agents: inRoom.slice(0, MAX_VISIBLE_AGENTS),
        overflow: Math.max(0, inRoom.length - MAX_VISIBLE_AGENTS),
      };
    });
  const fixed = fixedRooms(kind, warRooms).map((f) => ({ ...f, rect: cellRect(f) }));
  const free = freeCells(rooms, kind, warRooms).map((c) => ({ ...c, rect: cellRect(c) }));
  const next = kind === 'andar' ? nextWarCell(warRooms) : undefined;
  const warAdd = next && { ...next, rect: cellRect(next) };
  const box = (rects: Rect[]): Rect => {
    const all = rects.map(withCorridor);
    const x = Math.min(...all.map((r) => r.x));
    const y = Math.min(...all.map((r) => r.y));
    const right = Math.max(...all.map((r) => r.x + r.w));
    const bottom = Math.max(...all.map((r) => r.y + r.h)) + (kind === 'terreo' ? STREET_H : 0);
    return { x, y, w: right - x, h: bottom - y };
  };
  const built = [...placed.map((p) => p.rect), ...fixed.map((f) => f.rect)];
  const extras = [...free.map((f) => f.rect), ...(warAdd ? [warAdd.rect] : [])];
  return { rooms: placed, fixed, free, warAdd, bounds: box([...built, ...extras]), core: box(built) };
}

/** Onde o quadro da animação começa (em y, dentro da vaga) para a cabeça ficar em HEAD_Y. */
export function seatTop(anim: { cabecaY: number }): number {
  return HEAD_Y - anim.cabecaY;
}

export interface Camera {
  /** Centro da tela, em coordenadas do mundo. */
  x: number;
  y: number;
  z: number;
}

/** Zoom e centro que mostram a caixa inteira na tela, com folga. */
export function fitCamera(bounds: Rect, viewW: number, viewH: number): Camera {
  const fits = ZOOMS.filter((z) => bounds.w * z + 48 <= viewW && bounds.h * z + 48 <= viewH);
  const z = fits.length ? fits[fits.length - 1] : ZOOMS[0];
  return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2, z };
}

/** Próximo nível de zoom (dir = +1 aproxima, -1 afasta). */
export function stepZoom(z: number, dir: 1 | -1): number {
  const i = ZOOMS.findIndex((v) => v >= z - 1e-6);
  const cur = i < 0 ? ZOOMS.length - 1 : i;
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, cur + dir))];
}

export interface OfficeCallbacks {
  onSelectAgent(id: string): void;
  onAddAgent(roomId: string): void;
  onSelectRoom(roomId: string): void;
  onNewRoom(cell: Cell): void;
  onSelectWarRoom(slot: number): void;
  onAddWarRoom(): void;
}

/** A câmera de cada andar fica salva separada: voltar a um andar volta à mesma vista. */
// O 2 é da vista isométrica: a câmera guardada da vista de cima abriria noutro lugar.
const camKey = (floorId: string) => `officeCam2:${floorId}`;

export class Office {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pix = document.createElement('canvas');
  private pctx = this.pix.getContext('2d')!;
  private sprites = new Sprites();
  private layout: BuildingLayout = layoutBuilding([], []);
  private floor: FloorView = { id: '', kind: 'andar', color: '#7aa2f7' };
  private hits: Hit[] = [];
  private hover?: Hit;
  private frame = 0;
  private lastTick = 0;
  private cam: Camera | undefined;
  /** Você arrastou ou deu zoom: a partir daí, mudar o tamanho do painel não re-enquadra. */
  private userMoved = false;
  private drag?: { x: number; y: number; camX: number; camY: number; moved: boolean };
  private cssW = 0;
  private cssH = 0;
  /** Funcionários fora da mesa (sessão encerrada), andando pelo prédio. */
  private walkers = new Map<string, Walker & { agent: Agent; transit?: boolean }>();
  /** Incidente de cada agente na última atualização: quando muda, ele levanta e vai (ou volta) andando. */
  private lastIncident = new Map<string, string | undefined>();
  private incidents: Incident[] = [];
  /** Todos os agentes do andar, inclusive os que não couberam nas mesas. */
  private floorAgents: Agent[] = [];
  private graph = buildGraph([], GEO);
  private lastWalk = 0;
  selectedAgent?: string;
  selectedRoom?: string;
  /** Sala de guerra selecionada (número no andar). */
  selectedWar?: number;

  constructor(private host: HTMLElement, private cb: OfficeCallbacks) {
    this.canvas = document.createElement('canvas');
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.drag) this.hover = undefined;
    });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.sprites
      .load()
      .then(() => this.draw())
      .catch((err) => console.error('[office]', err));
    requestAnimationFrame((t) => this.loop(t));
  }

  /** Mostra um andar: só as salas dele e os agentes delas. */
  update(floor: FloorView, rooms: Room[], agents: Agent[], incidents: Incident[] = []) {
    if (floor.id !== this.floor.id) this.enterFloor(floor);
    this.floor = floor;
    this.incidents = incidents.filter((i) => i.floorId === floor.id);
    this.floorAgents = agents;
    this.layout = layoutBuilding(rooms, agents, floor.kind, floor.warRooms ?? 1);
    this.graph = buildGraph(this.builtCells(), GEO);
    this.syncWalkers(rooms, agents);
    if ((!this.cam || !this.userMoved) && this.cssW) this.fit();
    this.draw();
  }

  /** Trocou de andar: quem andava no outro some, e a câmera volta à vista salva deste andar. */
  private enterFloor(floor: FloorView) {
    this.walkers.clear();
    this.lastIncident.clear();
    this.hover = undefined;
    this.cam = undefined;
    this.userMoved = false;
    try {
      const saved = JSON.parse(localStorage.getItem(camKey(floor.id)) ?? 'null');
      if (saved && [saved.x, saved.y, saved.z].every(Number.isFinite)) {
        this.cam = saved;
        this.userMoved = true;
      }
    } catch {}
  }

  // ---------- câmera ----------

  get camera(): Camera {
    return this.cam ?? { x: 0, y: 0, z: 1 };
  }

  private setCamera(c: Camera) {
    this.cam = c;
    try {
      if (this.floor.id) localStorage.setItem(camKey(this.floor.id), JSON.stringify(c));
    } catch {}
    this.resizePix();
    this.draw();
  }

  /** Mostra o prédio inteiro (as vagas "+" em volta podem ficar só pela metade). */
  fit() {
    this.userMoved = false;
    this.setCamera(fitCamera(projectRect(this.layout.core, VIEW), this.cssW, this.cssH));
  }

  zoom(dir: 1 | -1, at?: { x: number; y: number }) {
    const c = this.camera;
    const z = stepZoom(c.z, dir);
    if (z === c.z) return;
    this.userMoved = true;
    // Mantém parado o ponto do mundo que está sob o cursor (ou o centro da tela).
    const sx = at?.x ?? this.cssW / 2;
    const sy = at?.y ?? this.cssH / 2;
    const wx = c.x + (sx - this.cssW / 2) / c.z;
    const wy = c.y + (sy - this.cssH / 2) / c.z;
    this.setCamera({ x: wx - (sx - this.cssW / 2) / z, y: wy - (sy - this.cssH / 2) / z, z });
  }

  /** Leva a câmera até a sala, se ela não estiver inteira na tela. */
  reveal(roomId: string) {
    this.revealRect(this.layout.rooms.find((p) => p.room.id === roomId)?.rect);
  }

  /** Leva a câmera até uma sala de guerra. */
  revealWar(slot: number) {
    this.revealRect(this.layout.fixed.find((f) => f.id === 'guerra' && f.slot === slot)?.rect);
  }

  private revealRect(plan: Rect | undefined) {
    if (!plan || !this.cssW) return;
    const r = projectRect(plan, VIEW);
    const c = this.camera;
    const view = { x: c.x - this.cssW / 2 / c.z, y: c.y - this.cssH / 2 / c.z, w: this.cssW / c.z, h: this.cssH / c.z };
    const inside = r.x >= view.x && r.y >= view.y && r.x + r.w <= view.x + view.w && r.y + r.h <= view.y + view.h;
    if (inside) return;
    // Conta como mexer no mapa: senão a próxima atualização re-enquadraria o prédio e desfaria isto.
    this.userMoved = true;
    this.setCamera({ ...c, x: r.x + r.w / 2, y: r.y + r.h / 2 });
  }

  private resize() {
    this.cssW = this.host.clientWidth;
    this.cssH = this.host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    if (!this.cam || !this.userMoved) this.fit();
    else this.setCamera(this.cam);
  }

  /** Canvas de baixa resolução do tamanho da tela no zoom atual (só mexe nele se mudou: limpar custa). */
  private resizePix() {
    const z = this.camera.z;
    const w = Math.max(1, Math.ceil(this.cssW / z) + 2);
    const h = Math.max(1, Math.ceil(this.cssH / z) + 2);
    if (this.pix.width !== w) this.pix.width = w;
    if (this.pix.height !== h) this.pix.height = h;
  }

  private loop(t: number) {
    requestAnimationFrame((t2) => this.loop(t2));
    if (t - this.lastTick < 1000 / FPS || document.hidden) return;
    this.lastTick = t;
    this.frame++;
    this.walk(t);
    this.draw();
  }

  // ---------- quem anda pelo prédio ----------

  private builtCells(): Cell[] {
    return [...this.layout.fixed, ...this.layout.rooms.map((r) => r.room.pos!)];
  }

  /**
   * Quem encerrou a sessão levanta da mesa e sai andando; quem voltou some do corredor.
   * Quem foi chamado para a sala de guerra (ou voltou dela) atravessa o corredor até lá.
   */
  private syncWalkers(rooms: Room[], agents: Agent[]) {
    const now = performance.now();
    for (const a of agents) {
      const room = rooms.find((r) => r.id === a.roomId);
      const known = this.lastIncident.has(a.id);
      const before = this.lastIncident.get(a.id);
      this.lastIncident.set(a.id, a.incidentId);
      // Recém-contratado para o incidente também vai andando, da sala do projeto até a de guerra.
      const fresh = !known && !!a.incidentId && Date.now() - a.createdAt < 15_000;
      if (room?.pos && a.status !== 'exited' && ((known && before !== a.incidentId) || fresh)) {
        const war = this.warCellOf(before ?? a.incidentId);
        const going = !!a.incidentId;
        const from = going ? room.pos : war;
        const to = going ? war : room.pos;
        if (from && to) this.startTransit(a, from, to, now);
      }
      if (this.walkers.get(a.id)?.transit) {
        this.walkers.get(a.id)!.agent = a;
        continue;
      }
      if (a.status !== 'exited' || a.kind === 'shell' || !room?.pos) {
        this.walkers.delete(a.id);
        continue;
      }
      const existing = this.walkers.get(a.id);
      if (existing) {
        existing.agent = a;
        continue;
      }
      // Começa na cadeira (se tinha mesa visível) e vai até a porta da sala.
      const placed = this.layout.rooms.find((r) => r.room.id === room.id);
      const i = placed?.agents.findIndex((x) => x.id === a.id) ?? -1;
      const door = insideDoor(room.pos, GEO);
      const start = i >= 0 && placed ? slotOrigin(placed.rect, i) : undefined;
      const from = start ? { x: start.x + SLOT_W / 2 + SEAT_DX, y: start.y + DESK_Y + 30 } : door;
      this.walkers.set(a.id, {
        agent: a,
        x: from.x,
        y: from.y,
        dir: 'south',
        path: start ? [{ x: from.x, y: door.y - 30 }, door] : [],
        // Cada um levanta num momento diferente, para não saírem todos juntos pela porta.
        restUntil: now + 800 + (hash(a.id) % 6000),
        cell: room.pos,
      });
    }
    for (const id of this.walkers.keys()) if (!agents.some((a) => a.id === id)) this.walkers.delete(id);
  }

  /** Vaga da sala de guerra de um incidente deste andar. */
  private warCellOf(incidentId: string | undefined): Cell | undefined {
    const slot = this.incidents.find((i) => i.id === incidentId)?.slot;
    return this.layout.fixed.find((f) => f.id === 'guerra' && f.slot === slot);
  }

  /** Levanta, sai pela porta e vai pelo corredor até a outra sala; lá some e senta. */
  private startTransit(a: Agent, from: Cell, to: Cell, now: number) {
    const route = routeBetween(this.graph, from, to, GEO);
    if (!route.length) return;
    const start = route[0];
    this.walkers.set(a.id, { agent: a, x: start.x, y: start.y, dir: 'south', path: route.slice(1), restUntil: now + 300, cell: to, transit: true });
  }

  /** Está atravessando o corredor: nem na mesa, nem na sala de guerra ainda. */
  private inTransit(id: string) {
    return !!this.walkers.get(id)?.transit;
  }

  private walk(t: number) {
    const dt = this.lastWalk ? Math.min(250, t - this.lastWalk) : 0;
    this.lastWalk = t;
    for (const w of this.walkers.values()) {
      if (t < w.restUntil) continue;
      if (w.transit) {
        // Chegou: senta (na mesa redonda ou na própria mesa) e para de andar.
        if (w.path.length) step(w, dt, WALK_SPEED * 1.6);
        if (!w.path.length) this.walkers.delete(w.agent.id);
        continue;
      }
      if (w.path.length) {
        step(w, dt, WALK_SPEED);
        if (!w.path.length) {
          w.dir = 'south';
          w.restUntil = t + 3000 + (hash(`${w.agent.id}${Math.round(t)}`) % 7000);
        }
      } else {
        this.chooseDestination(w, t);
      }
    }
  }

  /** Próximo passeio: copa, recepção ou a sala de algum colega. Nunca a vaga onde já está. */
  private chooseDestination(w: Walker & { agent: Agent }, t: number) {
    const options = this.builtCells().filter((c) => c.x !== w.cell.x || c.y !== w.cell.y);
    if (!options.length) {
      w.restUntil = t + 5000;
      return;
    }
    // A copa do andar é o destino favorito.
    const copa = this.layout.fixed.find((f) => f.id === 'copa');
    const roll = hash(`${w.agent.id}:${Math.round(t)}`);
    const goCopa = !!copa && roll % 3 === 0 && (w.cell.x !== copa.x || w.cell.y !== copa.y);
    const target = goCopa && copa ? copa : options[roll % options.length];
    const route = routeBetween(this.graph, w.cell, target, GEO);
    if (!route.length) {
      w.restUntil = t + 5000;
      return;
    }
    const b = cellRect(target);
    // Um lugar para ficar lá dentro: perto da mesa da copa, dos sofás da recepção ou da porta.
    const spot: Point =
      copa && target.x === copa.x && target.y === copa.y
        ? { x: b.x + b.w / 2 - 10 + ((roll % 5) - 2) * 18, y: b.y + 200 }
        : this.layout.fixed.some((f) => f.id === 'elevadores' && f.x === target.x && f.y === target.y)
          ? { x: b.x + (roll % 2 ? 70 : b.w - 70), y: b.y + 190 }
          : { x: b.x + b.w / 2 + ((roll % 3) - 1) * 30, y: b.y + b.h - 30 };
    // Sai da posição atual direto até a porta da vaga onde está, depois segue o caminho.
    w.path = [...route, spot];
    w.cell = target;
  }

  // ---------- interação ----------

  private toWorld(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    const c = this.camera;
    return { x: c.x + (e.clientX - r.left - this.cssW / 2) / c.z, y: c.y + (e.clientY - r.top - this.cssH / 2) / c.z };
  }

  private hitAt(e: { clientX: number; clientY: number }): Hit | undefined {
    // Agentes e mesas antes da sala, porque são desenhados depois, dentro dela.
    return pick(this.hits, this.toWorld(e), VIEW);
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const c = this.camera;
    this.drag = { x: e.clientX, y: e.clientY, camX: c.x, camY: c.y, moved: false };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    if (this.drag) {
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      // Só vira arraste depois de alguns pixels: um clique com a mão tremendo continua clique.
      if (!this.drag.moved && Math.hypot(dx, dy) < 5) return;
      this.drag.moved = true;
      this.userMoved = true;
      this.canvas.style.cursor = 'grabbing';
      const z = this.camera.z;
      this.setCamera({ x: this.drag.camX - dx / z, y: this.drag.camY - dy / z, z });
      return;
    }
    this.hover = this.hitAt(e);
    this.canvas.style.cursor = this.hover && this.hover.kind !== 'room' && this.hover.kind !== 'war' ? 'pointer' : 'grab';
  }

  private onUp(e: PointerEvent) {
    const drag = this.drag;
    this.drag = undefined;
    this.canvas.style.cursor = 'grab';
    if (!drag || drag.moved) return;
    const hit = this.hitAt(e);
    if (!hit) return;
    if (hit.kind === 'agent') this.cb.onSelectAgent(hit.id);
    else if (hit.kind === 'add') this.cb.onAddAgent(hit.id);
    else if (hit.kind === 'room') this.cb.onSelectRoom(hit.id);
    else if (hit.kind === 'newroom') this.cb.onNewRoom(hit.cell);
    else if (hit.kind === 'war') this.cb.onSelectWarRoom(hit.slot);
    else if (hit.kind === 'newwar') this.cb.onAddWarRoom();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    this.zoom(e.deltaY < 0 ? 1 : -1, { x: e.clientX - r.left, y: e.clientY - r.top });
  }

  // ---------- desenho ----------
  //
  // Em duas passadas: o que é deitado no chão (pisos, tapetes, rua, vagas livres) é desenhado
  // na hora, com a matriz da projeção, em coordenadas da planta. O que fica em pé (paredes,
  // móveis, pessoas) entra numa lista e é desenhado no fim, de trás para a frente.

  /** Coisas em pé deste quadro, com a profundidade de cada uma. */
  private items: { d: number; i: number; draw: () => void }[] = [];
  /** Canto de cima à esquerda do canvas de baixa resolução, na tela (antes da câmera). */
  private origin: Point = { x: 0, y: 0 };

  /** Ponto da planta → ponto do canvas de baixa resolução, `z` pixels acima do chão. */
  private sp(x: number, y: number, z = 0): Point {
    const s = project({ x, y }, VIEW, z);
    return { x: s.x - this.origin.x, y: s.y - this.origin.y };
  }

  /** Entra na ordem de desenho pela posição na planta. */
  private upright(at: Point, draw: () => void, bias = 0) {
    this.items.push({ d: depth(at, VIEW) + bias, i: this.items.length, draw });
  }

  /** Desenha deitado: dentro de fn, as coordenadas são da planta. `z` levanta o plano (um tampo). */
  private flat(fn: () => void, z = 0) {
    const p = this.pctx;
    const [a, b, c, d] = floorMatrix(VIEW);
    p.save();
    p.setTransform(a, b, c, d, -this.origin.x, -this.origin.y - z);
    fn();
    p.restore();
  }

  private draw() {
    if (!this.cssW || !this.cam) return;
    // A câmera pode ter mudado sem passar por setCamera (a vista salva do andar, ao trocar de andar).
    this.resizePix();
    const p = this.pctx;
    const c = this.camera;
    this.canvas.dataset.cam = `${Math.round(c.x)},${Math.round(c.y)},${c.z}`;
    const left = Math.round(c.x - this.pix.width / 2);
    const top = Math.round(c.y - this.pix.height / 2);
    const view = { x: left, y: top, w: this.pix.width, h: this.pix.height };
    this.origin = { x: left, y: top };
    // O que a tela enxerga na planta, com folga para as paredes que sobem de fora dela.
    const pb = planBox(view, VIEW);
    const plan = { x: pb.x - WALL_UP * 2, y: pb.y - WALL_UP * 2, w: pb.w + WALL_UP * 4, h: pb.h + WALL_UP * 4 };

    p.setTransform(1, 0, 0, 1, 0, 0);
    p.imageSmoothingEnabled = false;
    p.clearRect(0, 0, this.pix.width, this.pix.height);
    this.hits = [];
    this.items = [];

    this.drawGround(view, plan);
    if (this.floor.kind === 'terreo') {
      this.drawStreet(plan);
      this.drawTrees(plan);
    }
    this.flat(() => {
      for (const f of this.layout.free) if (overlaps(f.rect, plan)) this.drawFreeCell(f);
      if (this.layout.warAdd && overlaps(this.layout.warAdd.rect, plan)) this.drawWarAdd(this.layout.warAdd.rect);
    });
    this.drawCorridors();
    for (const f of this.layout.fixed) if (overlaps(f.rect, plan)) this.drawFixed(f);
    for (const r of this.layout.rooms) if (overlaps(r.rect, plan)) this.drawRoom(r);
    this.drawWalkers(plan);
    // Ordem estável: o que empata fica na ordem em que foi pedido.
    this.items.sort((a, b) => a.d - b.d || a.i - b.i);
    for (const it of this.items) it.draw();

    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    // O canvas de baixa resolução começa em (left, top); a câmera pode estar entre dois pixels.
    const offX = (left - (c.x - this.cssW / 2 / c.z)) * c.z;
    const offY = (top - (c.y - this.cssH / 2 / c.z)) * c.z;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.floor.kind === 'terreo' ? '#2f6b33' : this.skyBackground();
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.pix, offX * dpr, offY * dpr, this.pix.width * c.z * dpr, this.pix.height * c.z * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.drawTexts();
  }

  private drawGround(view: Rect, plan: Rect) {
    const p = this.pctx;
    if (this.floor.kind !== 'terreo') {
      // Andares de cima: só céu em volta, com nuvens paradas nos mesmos lugares da tela.
      rect(p, 0, 0, view.w, view.h, this.skyBackground());
      const step = 180;
      for (let gy = Math.floor(view.y / step) - 1; gy * step < view.y + view.h; gy++) {
        for (let gx = Math.floor(view.x / step) - 1; gx * step < view.x + view.w; gx++) {
          if (hash(`n${gx}:${gy}`) % 4) continue;
          const cx = gx * step + (hash(`${gx}n${gy}`) % 80) - view.x;
          const cy = gy * step + (hash(`${gy}n${gx}`) % 60) - view.y;
          const c = 'rgba(255,255,255,0.35)';
          rect(p, cx, cy + 8, 60, 12, c);
          rect(p, cx + 10, cy, 30, 10, c);
          rect(p, cx + 30, cy + 4, 20, 6, c);
        }
      }
      return;
    }
    this.flat(() => this.tileFloor(plan, 'grama', '#2f6b33', true));
  }

  /** Calçada e rua de ponta a ponta, na frente do térreo, com postes, bancos e um carro passando. */
  private drawStreet(plan: Rect) {
    const y = STREET_Y;
    if (y > plan.y + plan.h || y + STREET_H < plan.y) return;
    this.flat(() => {
      const p = this.pctx;
      rect(p, plan.x, y, plan.w, 18, '#b9b4a9');
      for (let x = Math.floor(plan.x / 24) * 24; x < plan.x + plan.w; x += 24) rect(p, x, y, 1, 18, '#a29d92');
      rect(p, plan.x, y + 18, plan.w, 56, '#3b3d45');
      for (let x = Math.floor(plan.x / 40) * 40; x < plan.x + plan.w; x += 40) rect(p, x, y + 45, 22, 2, '#e8d48a');
      rect(p, plan.x, y + 74, plan.w, 18, '#b9b4a9');
      for (let x = Math.floor(plan.x / 24) * 24; x < plan.x + plan.w; x += 24) rect(p, x + 12, y + 74, 1, 18, '#a29d92');
    });

    // carro atravessando a rua, sempre para a direita da planta
    const span = 2400;
    const cx = plan.x + (((performance.now() / 1000) * 70 - plan.x + span * 1000) % span);
    this.objAt('carro', cx, y + 46);

    // postes e bancos na calçada da frente, em intervalos fixos do mundo
    const step = 260;
    for (let x = Math.floor(plan.x / step) * step - step; x < plan.x + plan.w + step; x += step) {
      this.objAt('poste', x + 16, y + 88);
      if (hash(`banco${x}`) % 2) this.objAt('banco', x + 110, y + 88);
    }
  }

  /** Árvores espalhadas pela grama, sempre nos mesmos lugares, longe do prédio e da rua. */
  private drawTrees(plan: Rect) {
    const arvore = this.sprites.objetos.get('arvore');
    if (!arvore) return;
    const keepOut: Rect[] = [...this.layout.fixed.map((f) => f.rect), ...this.layout.rooms.map((r) => r.rect)].map(
      (r) => ({ x: r.x - 40 - CORR / 2, y: r.y - 50 - CORR / 2, w: r.w + 80 + CORR, h: r.h + 70 + CORR }),
    );
    keepOut.push({ x: plan.x - 100, y: STREET_Y - 50, w: plan.w + 200, h: STREET_H + 60 });
    const step = 112;
    for (let gy = Math.floor(plan.y / step) - 1; gy * step < plan.y + plan.h; gy++) {
      for (let gx = Math.floor(plan.x / step) - 1; gx * step < plan.x + plan.w; gx++) {
        // Só uma em cada três vagas do terreno ganha árvore, deslocada para não formar grade.
        if (hash(`t${gx}:${gy}`) % 3 !== 0) continue;
        const tx = gx * step + (hash(`${gx},${gy}`) % 60) - 30;
        const ty = gy * step + (hash(`${gy},${gx}`) % 50) - 25;
        const box = { x: tx + 8, y: ty + 8, w: arvore.width - 16, h: arvore.height - 8 };
        if (!keepOut.some((k) => overlaps(box, k))) this.obj('arvore', tx, ty);
      }
    }
  }

  // ---------- paredes ----------

  /**
   * Parede em pé ao longo de uma linha da planta, em pedaços de 16 px: cada pedaço entra na
   * ordem de desenho pela própria posição, para quem está atrás dele sumir e quem está na
   * frente aparecer. `gap` é um vão (a porta), em pixels a partir do meio da linha.
   */
  private wall(x0: number, y0: number, x1: number, y1: number, h: number, color: string, gap = 0) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / 16));
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const t1 = (i + 1) / n;
      const mid = ((t0 + t1) / 2) * len;
      if (gap && Math.abs(mid - len / 2) < gap / 2) continue;
      // Um pouco de sobra em cada ponta: sem ela, a borda suavizada deixa um fio entre os pedaços.
      const e = 0.6 / len;
      const a = { x: x0 + (x1 - x0) * Math.max(0, t0 - e), y: y0 + (y1 - y0) * Math.max(0, t0 - e) };
      const b = { x: x0 + (x1 - x0) * Math.min(1, t1 + e), y: y0 + (y1 - y0) * Math.min(1, t1 + e) };
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.upright(m, () => this.face(a, b, 0, h, color, true));
    }
  }

  /** Painel em pé entre dois pontos do chão, de z0 a z1 (parede, janela, porta de elevador). */
  private face(a: Point, b: Point, z0: number, z1: number, color: string, cap = false) {
    const p = this.pctx;
    const A0 = this.sp(a.x, a.y, z0);
    const B0 = this.sp(b.x, b.y, z0);
    const A1 = this.sp(a.x, a.y, z1);
    const B1 = this.sp(b.x, b.y, z1);
    p.fillStyle = color;
    p.beginPath();
    p.moveTo(A0.x, A0.y);
    p.lineTo(B0.x, B0.y);
    p.lineTo(B1.x, B1.y);
    p.lineTo(A1.x, A1.y);
    p.closePath();
    p.fill();
    if (!cap) return;
    // topo da parede, mais escuro
    p.fillStyle = WALL_DARK;
    p.beginPath();
    p.moveTo(A1.x, A1.y);
    p.lineTo(B1.x, B1.y);
    p.lineTo(B1.x, B1.y + 3);
    p.lineTo(A1.x, A1.y + 3);
    p.closePath();
    p.fill();
  }

  /** Algo pregado na parede do fundo de uma vaga (em y = r.y), de x0 a x1 e de z0 a z1. */
  private onBackWall(r: Rect, x0: number, x1: number, z0: number, z1: number, color: string) {
    const a = { x: r.x + x0, y: r.y };
    const b = { x: r.x + x1, y: r.y };
    this.upright({ x: (a.x + b.x) / 2, y: r.y }, () => this.face(a, b, z0, z1, color), 0.5);
  }

  /** Caixa em pé (bancada, balcão): tampo e as duas faces que dão para quem olha. */
  private box(x: number, y: number, w: number, d: number, h: number, color: string) {
    this.upright({ x: x + w / 2, y: y + d / 2 }, () => {
      const p = this.pctx;
      const poly = (pts: Point[], col: string) => {
        p.fillStyle = col;
        p.beginPath();
        pts.forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y)));
        p.closePath();
        p.fill();
      };
      poly([this.sp(x, y + d), this.sp(x + w, y + d), this.sp(x + w, y + d, h), this.sp(x, y + d, h)], shade(color, 0.8));
      poly([this.sp(x + w, y), this.sp(x + w, y + d), this.sp(x + w, y + d, h), this.sp(x + w, y, h)], shade(color, 0.65));
      poly([this.sp(x, y, h), this.sp(x + w, y, h), this.sp(x + w, y + d, h), this.sp(x, y + d, h)], color);
    });
  }

  /**
   * Paredes de uma vaga: as do fundo (em cima e à esquerda na planta) são altas, com janela; as
   * da frente são baixas, em corte, para não esconderem quem está dentro. A porta fica na da frente.
   */
  private drawShell(r: Rect, wallColor: string, opts: { door?: number } = {}) {
    const x1 = r.x + r.w;
    const y1 = r.y + r.h;
    this.wall(r.x, r.y, x1, r.y, WALL_UP, wallColor);
    this.wall(r.x, r.y, r.x, y1, WALL_UP, shade(wallColor, 0.8));
    this.wall(x1, r.y, x1, y1, WALL_LOW, WALL_DARK);
    this.wall(r.x, y1, x1, y1, WALL_LOW, WALL_DARK, opts.door ?? 40);
    // janela com o céu da hora atual
    this.onBackWall(r, 14, 46, 16, 42, '#1f2335');
    this.onBackWall(r, 16, 44, 18, 40, this.skyColor());
    this.onBackWall(r, 29, 31, 18, 40, '#1f2335');
  }

  /**
   * Corredores: o anel em volta de cada vaga construída, com piso próprio, e a parede externa
   * nos lados que não dão para outra vaga. A entrada principal fica na frente da recepção.
   */
  private drawCorridors() {
    const built = this.builtCells();
    const has = (x: number, y: number) => built.some((c) => c.x === x && c.y === y);
    this.flat(() => {
      for (const c of built) this.tileFloor(withCorridor(cellRect(c)), 'corredor', '#8e94a3');
    });
    const outer = shade(this.floor.color, 0.3);
    for (const c of built) {
      const e = withCorridor(cellRect(c));
      if (!has(c.x, c.y + 1)) this.wall(e.x, e.y, e.x + e.w, e.y, WALL_UP, outer);
      if (!has(c.x - 1, c.y)) this.wall(e.x, e.y, e.x, e.y + e.h, WALL_UP, shade(outer, 0.8));
      if (!has(c.x + 1, c.y)) this.wall(e.x + e.w, e.y, e.x + e.w, e.y + e.h, WALL_LOW, WALL_DARK);
      if (c.y === 0 || !has(c.x, c.y - 1)) {
        const isEntrance = c.y === 0 && this.layout.fixed.some((f) => f.id === 'recepcao' && f.x === c.x);
        this.wall(e.x, e.y + e.h, e.x + e.w, e.y + e.h, WALL_LOW, WALL_DARK, isEntrance ? 72 : 0);
        if (isEntrance) {
          // capacho da entrada principal
          const dx = e.x + (e.w - 72) / 2;
          this.flat(() => {
            rect(this.pctx, dx + 12, e.y + e.h - 16, 48, 12, '#6b3f2a');
            rect(this.pctx, dx + 14, e.y + e.h - 14, 44, 8, '#8a5236');
          });
        }
      }
    }
  }

  // ---------- pessoas e objetos ----------

  /** Animação de alguém olhando para uma direção da tela; cai na de frente se não houver. */
  private animToward(who: string | undefined, name: string, dir: ScreenDir): Anim | undefined {
    const anims = who ? this.sprites.personagens.get(who) : undefined;
    return anims?.get(`${name}-${dir}`) ?? this.sprites.anim(who, name);
  }

  /** Funcionários andando pelos corredores, cada um na ordem de desenho pelos pés. */
  private drawWalkers(plan: Rect) {
    const names = this.sprites.names();
    for (const w of this.walkers.values()) {
      if (w.x < plan.x || w.x > plan.x + plan.w || w.y < plan.y || w.y > plan.y + plan.h) continue;
      const seed = hash(w.agent.id);
      const who = characterFor(seed, names);
      const moving = w.path.length > 0 && (w.transit || performance.now() >= w.restUntil);
      const wx = w.x + laneOf(w.agent.id);
      const dir = screenDir(w.dir, VIEW);
      // As animações de andar só existem nas 4 direções de cima: a diagonal usa a mais parecida.
      const anim = moving
        ? (this.animToward(who, 'andar', dir) ?? this.sprites.anim(who, `andar-${WALK_FALLBACK[dir] ?? w.dir}`))
        : this.sprites.anim(who, 'parado');
      if (!anim) continue;
      this.upright({ x: wx, y: w.y }, () => {
        const p = this.pctx;
        const s = this.sp(wx, w.y);
        const q = Math.floor((this.frame + (seed % 5)) / (moving ? 1 : 2)) % anim.quadros;
        p.fillStyle = 'rgba(0,0,0,0.22)';
        p.beginPath();
        p.ellipse(s.x, s.y, 11, 5, 0, 0, Math.PI * 2);
        p.fill();
        p.drawImage(anim.img, q * anim.w, 0, anim.w, anim.h, Math.round(s.x - anim.w / 2), Math.round(s.y - anim.pesY), anim.w, anim.h);
        if (this.selectedAgent === w.agent.id) this.arrow(s.x, s.y - anim.pesY + anim.cabecaY - 10);
        this.hits.push({ space: 'screen', x: s.x - 14 + this.origin.x, y: s.y - 50 + this.origin.y, w: 28, h: 54, kind: 'agent', id: w.agent.id });
      });
    }
  }

  /** Seta sobre a cabeça de quem está selecionado. */
  private arrow(cx: number, by: number) {
    const y = Math.round(by + (this.frame % 4 < 2 ? 0 : 2));
    for (let i = 0; i < 5; i++) rect(this.pctx, cx - 6 + i, y + i, 13 - i * 2, 1, '#c0caf5');
  }

  /**
   * Piso de ladrilhos do PixelLab repetidos, cortado no retângulo (cor lisa se não carregou).
   * Chamado dentro de flat(): os ladrilhos de cima ficam deitados, como num piso de verdade.
   */
  private tileFloor(r: Rect, name: string, fallback: string, aligned = false) {
    const p = this.pctx;
    const tile = this.sprites.pisos.get(name);
    if (!tile) {
      rect(p, r.x, r.y, r.w, r.h, fallback);
      return;
    }
    p.save();
    p.beginPath();
    p.rect(r.x, r.y, r.w, r.h);
    p.clip();
    // A grama de fora segue a grade do mundo; o piso de cada vaga começa no canto dela.
    const x0 = aligned ? Math.floor(r.x / tile.width) * tile.width : r.x;
    const y0 = aligned ? Math.floor(r.y / tile.height) * tile.height : r.y;
    for (let y = y0; y < r.y + r.h; y += tile.height) {
      for (let x = x0; x < r.x + r.w; x += tile.width) p.drawImage(tile, x, y);
    }
    p.restore();
  }

  private woodFloor(r: Rect) {
    this.flat(() => this.tileFloor(r, 'madeira', '#c9a77a'));
  }

  /**
   * Objeto do PixelLab em pé. (x, y) é onde o canto de cima ficava na vista de cima: o objeto é
   * posto com a base no meio da borda de baixo dessa caixa. `z` o levanta (em cima da bancada).
   */
  private obj(name: string, x: number, y: number, z = 0) {
    const img = this.sprites.objetos.get(name);
    if (img) this.objAt(name, x + img.width / 2, y + img.height - 6, z);
  }

  /** Objeto do PixelLab em pé com a base em (x, y) da planta. */
  private objAt(name: string, x: number, y: number, z = 0) {
    const img = this.sprites.objetos.get(name);
    if (!img) return;
    this.upright({ x, y }, () => {
      const s = this.sp(x, y, z);
      this.pctx.drawImage(img, Math.round(s.x - img.width / 2), Math.round(s.y - img.height + 6));
    });
  }

  /** Alguém em pé ou sentado com os pés em `at` (planta), olhando para quem vê. */
  private person(at: Point, who: string, animName: string, seed: number, dir: ScreenDir = 'south') {
    const anim = this.animToward(who, animName, dir);
    if (!anim) return undefined;
    const s = this.sp(at.x, at.y);
    const q = Math.floor((this.frame + seed) / 2) % anim.quadros;
    this.pctx.drawImage(anim.img, q * anim.w, 0, anim.w, anim.h, Math.round(s.x - anim.w / 2), Math.round(s.y - anim.pesY), anim.w, anim.h);
    return { x: s.x, top: s.y - anim.pesY + anim.cabecaY };
  }

  private drawFixed(f: FixedRoom & { rect: Rect }) {
    if (f.id === 'recepcao') this.drawReception(f.rect);
    else if (f.id === 'elevadores') this.drawElevators(f.rect);
    else if (f.id === 'guerra') this.drawWarRoom(f.rect, f.slot ?? 0);
    else this.drawKitchen(f.rect);
  }

  /** Hall dos elevadores: duas portas de metal na parede do fundo, com o andar aceso em cima. */
  private drawElevators(r: Rect) {
    this.flat(() => this.tileFloor(r, 'corredor', '#8e94a3'));
    this.drawShell(r, shade(this.floor.color, 0.45), { door: 120 });
    for (const dx of [70, r.w - 70 - 72]) {
      this.onBackWall(r, dx - 4, dx + 76, 0, 62, '#4a4f63');
      this.onBackWall(r, dx, dx + 35, 0, 56, '#9aa3b8');
      this.onBackWall(r, dx + 37, dx + 72, 0, 56, '#9aa3b8');
      this.onBackWall(r, dx + 24, dx + 48, 63, 70, '#1f2335');
      this.onBackWall(r, dx + 27, dx + 45, 64, 68, this.frame % 20 < 10 ? this.floor.color : shade(this.floor.color, 0.6));
    }
    this.obj('banco', r.x + r.w / 2 - 40, r.y + 150);
    this.obj('vaso-grande', r.x + 10, r.y + r.h - 70);
    this.obj('vaso-grande', r.x + r.w - 58, r.y + r.h - 70);
  }

  /** Entrada: porta para o corredor, balcão com a recepcionista, sofás de espera, estante e plantas. */
  private drawReception(r: Rect) {
    this.woodFloor(r);
    // tapete do caminho da porta ao balcão
    this.flat(() => {
      rect(this.pctx, r.x + r.w / 2 - 30, r.y + 140, 60, r.h - 144, '#7a2f3a');
      rect(this.pctx, r.x + r.w / 2 - 26, r.y + 144, 52, r.h - 152, '#9b3d4a');
    });
    this.drawShell(r, '#5a6b8c', { door: 72 });
    this.obj('estante', r.x + 8, r.y + 8);
    this.obj('vaso-grande', r.x + r.w - 56, r.y + 12);
    // recepcionista atrás do balcão
    const cx = r.x + r.w / 2;
    this.upright({ x: cx, y: r.y + 96 }, () => this.person({ x: cx, y: r.y + 96 }, RECEPCIONISTA, 'parado', 7));
    this.obj('balcao', cx - 64, r.y + 74);
    this.obj('sofa', r.x + 14, r.y + 168);
    this.obj('sofa', r.x + r.w - 94, r.y + 168);
    this.obj('bebedouro', r.x + r.w - 40, r.y + 108);
  }

  /** Copa: piso de cerâmica, bancada com a cafeteira encostada no fundo, geladeira, mesa e TV. */
  private drawKitchen(r: Rect) {
    this.flat(() => this.tileFloor(r, 'copa', '#dfe2ea'));
    this.drawShell(r, '#6b8c7a');
    this.box(r.x + 10, r.y + 2, r.w - 80, 26, 22, '#8d93a6');
    this.obj('cafeteira', r.x + 110, r.y + 2 - 22 + 26, 22);
    this.obj('geladeira', r.x + r.w - 60, r.y + 4);
    this.obj('mesa-copa', r.x + r.w / 2 - 58, r.y + 120);
    this.obj('tv', r.x + 14, r.y + 150);
    this.obj('planta', r.x + r.w - 40, r.y + r.h - 40);
  }

  /** Quem está sentado na mesa redonda de um incidente (quem saiu do escritório ou ainda está a caminho, não). */
  private seatedAt(incident: Incident | undefined): Agent[] {
    if (!incident) return [];
    return incident.participants
      .map((id) => this.floorAgents.find((a) => a.id === id))
      .filter((a): a is Agent => !!a && a.status !== 'exited' && !this.inTransit(a.id))
      .slice(0, WAR_SEATS.length);
  }

  /** Centro da mesa redonda e o lugar de cada cadeira, na planta. */
  private warTable(r: Rect) {
    const t = { x: r.x + r.w / 2, y: r.y + r.h / 2 + 14 };
    const seats = WAR_SEATS.map(([dx, dy]) => {
      // Os lugares foram pensados para a mesa achatada da vista de cima: o ângulo continua o mesmo.
      const a = Math.atan2(dy * 2.4, dx);
      return { x: t.x + Math.cos(a) * (WAR_RX + 20), y: t.y + Math.sin(a) * (WAR_RY + 20) };
    });
    return { t, seats };
  }

  /**
   * Sala de guerra: carpete, telão com o incidente na parede e uma mesa redonda com os participantes.
   * Sem incidente, a luz fica apagada.
   */
  private drawWarRoom(r: Rect, slot: number) {
    const incident = this.incidents.find((i) => i.slot === slot);
    this.flat(() => {
      this.tileFloor(r, 'corredor', '#8e94a3');
      rect(this.pctx, r.x + 20, r.y + 30, r.w - 40, r.h - 50, '#5b2f3a');
      rect(this.pctx, r.x + 24, r.y + 34, r.w - 48, r.h - 58, '#6e3846');
    });
    this.drawShell(r, '#3b2f45');
    // telão na parede do fundo: aceso com o incidente, apagado sem
    this.onBackWall(r, r.w / 2 - 70, r.w / 2 + 70, 14, 48, '#1f2335');
    this.onBackWall(r, r.w / 2 - 67, r.w / 2 + 67, 17, 45, incident ? (this.frame % 12 < 6 ? '#b8434f' : '#9a3440') : '#2a2f45');

    const { t, seats } = this.warTable(r);
    const seated = this.seatedAt(incident);
    seats.forEach((s, i) => {
      const a = seated[i];
      if (!a) {
        this.obj('cadeira', s.x - 16, s.y - 30);
        return;
      }
      this.upright(s, () => {
        const head = this.drawSeated(a, s);
        if (!head) return;
        this.hits.push({ space: 'screen', x: head.x - 16 + this.origin.x, y: head.top - 6 + this.origin.y, w: 32, h: 52, kind: 'agent', id: a.id });
      });
    });
    // mesa redonda: sombra no chão, borda e tampo
    this.upright(t, () => {
      const p = this.pctx;
      const ellipse = (rx: number, ry: number, col: string) => {
        p.fillStyle = col;
        p.beginPath();
        p.ellipse(t.x, t.y, rx, ry, 0, 0, Math.PI * 2);
        p.fill();
      };
      this.flat(() => ellipse(WAR_RX + 4, WAR_RY + 4, 'rgba(0,0,0,0.25)'));
      this.flat(() => ellipse(WAR_RX, WAR_RY, '#6b4329'), 12);
      this.flat(() => ellipse(WAR_RX, WAR_RY, '#8a5a3c'), 16);
      if (incident) {
        this.flat(() => {
          rect(p, t.x - 40, t.y - 8, 14, 10, '#e0e6ff');
          rect(p, t.x + 12, t.y - 2, 12, 9, '#e0e6ff');
          rect(p, t.x - 6, t.y + 8, 16, 8, '#f5e6a8');
        }, 17);
      }
    });

    if (!incident) this.dim(r, 'rgba(8,10,22,0.55)');
    if (this.selectedWar === slot) this.flat(() => outline(this.pctx, r, '#c0caf5'));
    this.hits.push({ ...r, kind: 'war', slot });
  }

  /** Escurece a vaga inteira (piso e paredes do fundo), por cima de tudo o que está nela. */
  private dim(r: Rect, color: string) {
    const x1 = r.x + r.w;
    const y1 = r.y + r.h;
    this.upright({ x: x1, y: y1 }, () => {
      const p = this.pctx;
      const pts = [this.sp(r.x, y1), this.sp(x1, y1), this.sp(x1, r.y), this.sp(x1, r.y, WALL_UP), this.sp(r.x, r.y, WALL_UP), this.sp(r.x, y1, WALL_UP)];
      p.fillStyle = color;
      p.beginPath();
      pts.forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y)));
      p.closePath();
      p.fill();
    }, 1);
  }

  /** Participante na mesa redonda, com a animação do estado e a seta se estiver selecionado. */
  private drawSeated(a: Agent, at: Point) {
    const seed = hash(a.id);
    const who = characterFor(seed, this.sprites.names());
    if (!who) return undefined;
    const head = this.person(at, who, ANIM_FOR[a.status] ?? 'parado', seed % 7);
    if (head && this.selectedAgent === a.id) this.arrow(head.x, head.top - 14);
    return head;
  }

  /** "+" em cima da última sala de guerra: abre mais uma, para outro incidente ao mesmo tempo. Dentro de flat(). */
  private drawWarAdd(r: Rect) {
    const p = this.pctx;
    const hovered = this.hover?.kind === 'newwar';
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h - 50;
    rect(p, cx - 16, cy - 16, 32, 32, hovered ? '#9a3440' : 'rgba(26,27,38,0.55)');
    rect(p, cx - 2, cy - 10, 4, 20, '#ffffff');
    rect(p, cx - 10, cy - 2, 20, 4, '#ffffff');
    this.hits.push({ x: cx - 40, y: cy - 30, w: 80, h: 60, kind: 'newwar' });
  }

  /** Vaga livre encostada no prédio: o "+" que abre uma sala nova ali. Dentro de flat(). */
  private drawFreeCell(f: Cell & { rect: Rect }) {
    const p = this.pctx;
    const r = f.rect;
    const hovered = this.hover?.kind === 'newroom' && this.hover.cell.x === f.x && this.hover.cell.y === f.y;
    const inset = 18;
    const col = hovered ? '#ffffff' : 'rgba(255,255,255,0.55)';
    if (hovered) rect(p, r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2, 'rgba(255,255,255,0.12)');
    for (let x = r.x + inset; x < r.x + r.w - inset; x += 12) {
      rect(p, x, r.y + inset, 6, 2, col);
      rect(p, x, r.y + r.h - inset - 2, 6, 2, col);
    }
    for (let y = r.y + inset; y < r.y + r.h - inset; y += 12) {
      rect(p, r.x + inset, y, 2, 6, col);
      rect(p, r.x + r.w - inset - 2, y, 2, 6, col);
    }
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    rect(p, cx - 18, cy - 18, 36, 36, hovered ? '#3d59a1' : 'rgba(26,27,38,0.55)');
    rect(p, cx - 2, cy - 11, 4, 22, '#ffffff');
    rect(p, cx - 11, cy - 2, 22, 4, '#ffffff');
    this.hits.push({ ...r, kind: 'newroom', cell: { x: f.x, y: f.y } });
  }

  private drawRoom(pr: PlacedRoom) {
    const { rect: r, room } = pr;
    this.woodFloor(r);
    // As salas de um andar têm a parede na cor dele, cada uma num tom um pouco diferente.
    const wallColor = shade(this.floor.color, 0.42 + ((hash(room.id) % 5) - 2) * 0.03);
    this.drawShell(r, wallColor);

    // placa com o nome na parede do fundo (o texto entra no passe de texto)
    const signW = 150;
    this.onBackWall(r, (r.w - signW) / 2, (r.w + signW) / 2, SIGN_Z - 10, SIGN_Z + 10, '#2a2f45');
    this.onBackWall(r, (r.w - signW) / 2 + 1, (r.w + signW) / 2 - 1, SIGN_Z - 9, SIGN_Z + 9, '#3b4261');

    // luz de atenção: pisca quando alguém terminou ou precisa de aprovação
    const needs = pr.agents.some((a) => a.status === 'done' || a.status === 'waiting');
    const lampOn = needs && this.frame % 6 < 3;
    this.onBackWall(r, r.w - 30, r.w - 16, SIGN_Z - 7, SIGN_Z + 7, '#1f2335');
    this.onBackWall(r, r.w - 29, r.w - 17, SIGN_Z - 6, SIGN_Z + 6, lampOn ? '#e0af68' : needs ? '#7a5b2a' : '#2a2f45');

    if (this.selectedRoom === room.id) this.flat(() => outline(this.pctx, r, '#c0caf5'));

    this.hits.push({ ...r, kind: 'room', id: room.id });
    pr.agents.forEach((a, i) => this.drawDesk(r, i, a));
    this.drawEmptyDesk(r, pr.agents.length, room.id);
  }

  /** Mesa isométrica (espelhada: o tampo corre ao longo da fileira), ou a antiga se faltar. */
  private drawDeskSprite(at: Point, alpha = 1) {
    const p = this.pctx;
    const s = this.sp(at.x, at.y);
    const iso = this.sprites.objetos.get('mesa-iso');
    const img = iso ?? this.deskSprite();
    if (!img) return { x: s.x - 32, y: s.y - 40, w: 64, h: 48 };
    p.save();
    p.globalAlpha = alpha;
    if (iso) {
      p.translate(Math.round(s.x), 0);
      p.scale(-1, 1);
      p.drawImage(iso, -48, Math.round(s.y - 58));
    } else {
      p.drawImage(img, Math.round(s.x - img.width / 2), Math.round(s.y - img.height + 8));
    }
    p.restore();
    return { x: s.x - 34, y: s.y - 52, w: 68, h: 60 };
  }

  private drawEmptyDesk(r: Rect, i: number, roomId: string) {
    const { desk } = deskSpot(r, i);
    this.upright(desk, () => {
      const p = this.pctx;
      const hovered = this.hover?.kind === 'add' && this.hover.id === roomId;
      const box = this.drawDeskSprite(desk, hovered ? 0.7 : 0.35);
      const s = this.sp(desk.x, desk.y, 34);
      const col = hovered ? '#ffffff' : '#e0e6ff';
      rect(p, s.x - 9, s.y - 9, 18, 18, hovered ? '#3d59a1' : 'rgba(26,27,38,0.7)');
      rect(p, s.x - 1, s.y - 5, 2, 10, col);
      rect(p, s.x - 5, s.y - 1, 10, 2, col);
      this.hits.push({ space: 'screen', x: box.x + this.origin.x, y: box.y - 20 + this.origin.y, w: box.w, h: box.h + 20, kind: 'add', id: roomId });
    });
  }

  /** Mesa do funcionário antiga (de cima), usada quando a isométrica falta. */
  private deskSprite() {
    return this.sprites.objetos.get('mesa-costas') ?? this.sprites.objetos.get('mesa');
  }

  private drawDesk(r: Rect, i: number, a: Agent) {
    const sx = slotOrigin(r, i).x;
    const { seat, desk } = deskSpot(r, i);
    const seed = hash(a.id);
    const f = this.frame + (seed % 7);
    const names = this.sprites.names();
    const who = characterFor(seed, names);
    // Quem está atrás da mesa e a mesa formam um alvo só: a caixa é guardada até a mesa ser desenhada.
    let top = Infinity;

    // Na sala de guerra (ou indo para lá): a mesa fica vazia, com uma bandeirinha.
    const away = !!a.incidentId || this.inTransit(a.id);
    if (!away) {
      // funcionário (some quando sai do escritório; pisca enquanto chega)
      const animName = ANIM_FOR[a.status];
      const fading = a.status === 'starting' && f % 4 < 2;
      if (animName && !fading) {
        this.upright(seat, () => {
          const anim = this.animToward(who, animName, 'south-west');
          if (!anim) return;
          const p = this.pctx;
          const s = this.sp(seat.x, seat.y);
          const speed = a.status === 'working' ? 1 : 2;
          const q = Math.floor(f / speed) % anim.quadros;
          const y = Math.round(s.y - anim.pesY);
          p.drawImage(anim.img, q * anim.w, 0, anim.w, anim.h, Math.round(s.x - anim.w / 2), y, anim.w, anim.h);
          top = y + anim.cabecaY;
          if (this.selectedAgent === a.id) this.arrow(s.x, top - 14);
        });
      }
    }

    this.upright(desk, () => {
      const p = this.pctx;
      const box = this.drawDeskSprite(desk);
      if (away) {
        const s = this.sp(desk.x + 18, desk.y - 6, 30);
        rect(p, s.x, s.y - 16, 2, 16, '#c0caf5');
        rect(p, s.x + 2, s.y - 16, 10, 7, '#b8434f');
      }
      const y0 = Math.min(box.y, top - 6);
      this.hits.push({ space: 'screen', x: box.x + this.origin.x, y: y0 + this.origin.y, w: box.w, h: box.y + box.h - y0, kind: 'agent', id: a.id });
    });

    // ajudantes (subagentes): colegas em miniatura ao lado da mesa
    if (away) return;
    for (let i = 0; i < Math.min(2, a.subagents); i++) {
      const at = { x: i === 0 ? sx + SLOT_W - 6 : sx + 4, y: desk.y + 4 };
      this.upright(at, () => {
        const helper = this.sprites.anim(characterFor(seed + 1 + i, names), 'parado');
        if (!helper) return;
        const s = this.sp(at.x, at.y);
        const hop = (f + i * 3) % 6 < 3 ? 0 : -1;
        const q = Math.floor((f + i) / 2) % helper.quadros;
        this.pctx.drawImage(helper.img, q * helper.w, 0, helper.w, helper.h, Math.round(s.x - helper.w / 4), Math.round(s.y - helper.pesY / 2 + hop), helper.w / 2, helper.h / 2);
      });
    }
  }

  private skyBackground() {
    const h = new Date().getHours();
    if (h >= 7 && h < 17) return '#8ec5ea';
    if (h >= 17 && h < 19) return '#e9a777';
    return '#1d2340';
  }

  private skyColor() {
    const h = new Date().getHours();
    if (h >= 7 && h < 17) return '#7dcfff';
    if (h >= 17 && h < 19) return '#ff9e64';
    return '#24283b';
  }

  // ---------- textos (em escala de tela) ----------

  /** Ponto da planta (`z` pixels acima do chão) → pixel do canvas na tela, já com a câmera. */
  private toScreen(x: number, y: number, z = 0) {
    const c = this.camera;
    const s = project({ x, y }, VIEW, z);
    return { x: (s.x - c.x) * c.z + this.cssW / 2, y: (s.y - c.y) * c.z + this.cssH / 2 };
  }

  private drawTexts() {
    const c = this.ctx;
    const z = this.camera.z;
    const signFont = Math.max(9, Math.round(10 * z));

    for (const f of this.layout.fixed) {
      if (f.id === 'guerra') {
        this.drawWarTexts(f.rect, f.slot ?? 0, signFont);
        continue;
      }
      const s = this.toScreen(f.rect.x + f.rect.w / 2, f.rect.y, f.id === 'elevadores' ? WALL_UP + 12 : SIGN_Z);
      this.label(f.name, s.x, s.y, signFont, '#ffffff', 'rgba(26,27,38,0.75)');
    }
    if (this.layout.warAdd && this.hover?.kind === 'newwar') {
      const r = this.layout.warAdd.rect;
      const s = this.toScreen(r.x + r.w / 2, r.y + r.h - 14);
      this.label('Nova sala de guerra', s.x, s.y, Math.max(11, Math.round(9 * z)), '#ffffff', 'rgba(154,52,64,0.9)');
    }

    for (const f of this.layout.free) {
      if (!(this.hover?.kind === 'newroom' && this.hover.cell.x === f.x && this.hover.cell.y === f.y)) continue;
      const s = this.toScreen(f.rect.x + f.rect.w / 2, f.rect.y + f.rect.h / 2 + 40);
      this.label('Nova sala aqui', s.x, s.y, Math.max(11, Math.round(9 * z)), '#ffffff', 'rgba(61,89,161,0.9)');
    }

    for (const pr of this.layout.rooms) {
      const r = pr.rect;
      const s = this.toScreen(r.x + r.w / 2, r.y, SIGN_Z);
      c.font = `${signFont}px "Silkscreen", monospace`;
      this.label(fit(c, pr.room.name, 140 * z), s.x, s.y, signFont, '#e0e6ff');
      if (pr.overflow) {
        const o = this.toScreen(r.x + r.w - 52, r.y, SIGN_Z);
        this.label(`+${pr.overflow}`, o.x, o.y, Math.max(9, Math.round(8 * z)), '#1a1b26', '#e0af68');
      }

      pr.agents.forEach((a, i) => {
        const o = slotOrigin(r, i);
        const { seat, desk } = deskSpot(r, i);
        if (a.incidentId || this.inTransit(a.id)) {
          if (z >= 0.75) {
            const size = Math.max(9, Math.round(8 * z));
            const n = this.toScreen(desk.x, desk.y + 22);
            this.label('na guerra', n.x, n.y, size, '#f7768e', 'rgba(26,27,38,0.85)');
          }
          return;
        }
        if (z >= 0.75) {
          const size = Math.max(9, Math.round(9 * z));
          const n = this.toScreen(desk.x, desk.y + 22);
          c.font = `${size}px "Silkscreen", monospace`;
          this.label(fit(c, a.name, (SLOT_W - 4) * z), n.x, n.y, size, STATUS_COLOR[a.status], 'rgba(26,27,38,0.85)');
        }
        if (a.subagents > 2) {
          const h = this.toScreen(o.x + SLOT_W - 6, desk.y + 4, 40);
          this.label(`+${a.subagents - 2}`, h.x, h.y, 11, '#c0caf5');
        }
        // balão de estado sobre a cabeça
        const hovered = this.hover?.kind === 'agent' && this.hover.id === a.id;
        const icon = { waiting: '!', done: '✓', working: '…', starting: '…' }[a.status as string];
        const head = this.toScreen(seat.x, seat.y, 62);
        if (hovered) this.bubble(head.x, head.y, a.activity, STATUS_COLOR[a.status], true);
        else if (icon) this.bubble(head.x, head.y, icon, STATUS_COLOR[a.status], false);
      });
    }

    for (const w of this.walkers.values()) {
      const wx = w.x + laneOf(w.agent.id);
      const head = this.toScreen(wx, w.y, 50);
      if (head.x < -50 || head.x > this.cssW + 50 || head.y < -50 || head.y > this.cssH + 80) continue;
      if (z >= 0.75) {
        const n = this.toScreen(wx, w.y + 12);
        const size = Math.max(9, Math.round(8 * z));
        this.label(w.agent.name, n.x, n.y, size, '#c0caf5', 'rgba(26,27,38,0.7)');
      }
      if (this.hover?.kind === 'agent' && this.hover.id === w.agent.id) {
        this.bubble(head.x, head.y, 'Fora do escritório: clique para retomar', STATUS_COLOR.exited, true);
      }
    }

    // Dica de primeira sala: só nos andares de empresa (o térreo não recebe salas).
    if (!this.layout.rooms.length && this.floor.kind !== 'terreo') {
      // Acima do canto de trás do prédio, que é o ponto mais alto dele na tela.
      const b = this.layout.bounds;
      const s = this.toScreen(b.x, b.y, WALL_UP + 24);
      this.label('Clique num + para abrir a sala do seu primeiro projeto', s.x, s.y, 13, '#ffffff', 'rgba(26,27,38,0.85)');
    }
  }

  /** Placa, título do incidente no telão, nomes e balões de quem está na mesa redonda. */
  private drawWarTexts(r: Rect, slot: number, signFont: number) {
    const c = this.ctx;
    const z = this.camera.z;
    const incident = this.incidents.find((i) => i.slot === slot);
    const screen = this.toScreen(r.x + r.w / 2, r.y, 31);
    c.font = `${signFont}px "Silkscreen", monospace`;
    this.label(incident ? fit(c, incident.title, 126 * z) : 'Sala de guerra · livre', screen.x, screen.y, signFont, incident ? '#ffffff' : '#a9b1d6');
    if (!incident) {
      if (this.hover?.kind === 'war' && this.hover.slot === slot) {
        const s = this.toScreen(r.x + r.w / 2, r.y + r.h / 2 + 40);
        this.label('Clique para abrir um incidente', s.x, s.y, Math.max(11, Math.round(9 * z)), '#ffffff', 'rgba(154,52,64,0.9)');
      }
      return;
    }
    const { seats } = this.warTable(r);
    this.seatedAt(incident).forEach((a, i) => {
      const s = seats[i];
      if (z >= 0.75) {
        const size = Math.max(9, Math.round(8 * z));
        const n = this.toScreen(s.x, s.y + 10);
        this.label(a.name, n.x, n.y, size, STATUS_COLOR[a.status], 'rgba(26,27,38,0.85)');
      }
      const hovered = this.hover?.kind === 'agent' && this.hover.id === a.id;
      const icon = { waiting: '!', done: '✓', working: '…', starting: '…' }[a.status as string];
      const head = this.toScreen(s.x, s.y, 58);
      if (hovered) this.bubble(head.x, head.y, a.activity, STATUS_COLOR[a.status], true);
      else if (icon) this.bubble(head.x, head.y, icon, STATUS_COLOR[a.status], false);
    });
    const extra = incident.participants.length - this.seatedAt(incident).length;
    if (extra > 0 && incident.participants.length > WAR_SEATS.length) {
      const o = this.toScreen(r.x + r.w - 40, r.y, 31);
      this.label(`+${incident.participants.length - WAR_SEATS.length}`, o.x, o.y, Math.max(9, Math.round(8 * z)), '#1a1b26', '#e0af68');
    }
  }

  private label(text: string, x: number, y: number, size: number, color: string, bg?: string) {
    const c = this.ctx;
    c.font = `${size}px "Silkscreen", monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    if (bg) {
      const w = c.measureText(text).width + size;
      c.fillStyle = bg;
      roundRect(c, x - w / 2, y - size * 0.8, w, size * 1.6, 3);
      c.fill();
    }
    c.fillStyle = color;
    c.fillText(text, x, y + 1);
  }

  private bubble(cx: number, bottom: number, text: string, color: string, wide: boolean) {
    const c = this.ctx;
    c.font = `${wide ? 12 : 13}px ${wide ? 'system-ui, sans-serif' : '"Silkscreen", monospace'}`;
    const label = wide ? fit(c, text, 260) : text;
    const w = c.measureText(label).width + 12;
    const h = 18;
    const x = Math.max(4, cx - w / 2);
    const y = bottom - h - 6;
    c.fillStyle = wide ? '#1f2335' : color;
    c.strokeStyle = color;
    c.lineWidth = 2;
    roundRect(c, x, y, w, h, 5);
    c.fill();
    c.stroke();
    c.beginPath();
    c.moveTo(cx - 4, y + h);
    c.lineTo(cx, y + h + 5);
    c.lineTo(cx + 4, y + h);
    c.closePath();
    c.fill();
    c.fillStyle = wide ? '#e0e6ff' : '#1a1b26';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, x + w / 2, y + h / 2 + 1);
  }
}

/**
 * Lugares na mesa redonda, em relação ao centro do tampo, na ordem em que são ocupados: do meio
 * para as pontas atrás da mesa (dy < 0), depois nas cabeceiras e na frente.
 */
const WAR_SEATS: [number, number][] = [
  [-40, -26],
  [40, -26],
  [-84, -16],
  [84, -16],
  [0, -30],
  [-124, 4],
  [124, 4],
  [0, 40],
];

/** Cada um anda numa "faixa" do corredor, para dois no mesmo caminho não ficarem sobrepostos. */
function laneOf(id: string) {
  return ((hash(id) % 5) - 2) * 5;
}

/** Mistura a cor com o roxo escuro das paredes: factor 1 é a cor pura, 0 é o escuro. */
export function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number, d: number) => Math.round(d + (c - d) * Math.max(0, Math.min(1, factor)));
  const r = mix((n >> 16) & 255, 0x2a);
  const g = mix((n >> 8) & 255, 0x24);
  const b = mix(n & 255, 0x38);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Contorno de um retângulo da planta (a seleção), dentro de flat(). */
function outline(p: CanvasRenderingContext2D, r: Rect, c: string) {
  rect(p, r.x + 3, r.y + 3, r.w - 6, 2, c);
  rect(p, r.x + 3, r.y + r.h - 6, r.w - 6, 2, c);
  rect(p, r.x + 3, r.y + 3, 2, r.h - 6, c);
  rect(p, r.x + r.w - 5, r.y + 3, 2, r.h - 6, c);
}

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function rect(p: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  p.fillStyle = color;
  p.fillRect(Math.round(x), Math.round(y), w, h);
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

function fit(c: CanvasRenderingContext2D, text: string, maxW: number) {
  if (c.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && c.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

export function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
