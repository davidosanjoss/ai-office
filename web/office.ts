// Escritório em pixel art: um prédio visto de cima. O térreo tem a recepção e a copa; cada
// projeto é uma sala encostada no prédio, e cada funcionário é um agente. O mapa é maior que a
// tela: arraste para navegar e use a rodinha para o zoom.
//
// Desenha o mundo em baixa resolução num canvas fora da tela (só a parte visível) e amplia sem
// suavização; os textos são desenhados depois, já na escala da tela, para ficarem legíveis.
// A arte vem do PixelLab (web/sprites.ts); paredes, balcões, rua e balões são desenhados aqui.

import { FIXED_ROOMS, type Cell, type FixedRoom, freeCells } from '../shared/building.ts';
import type { Agent, AgentStatus, Room } from '../shared/types.ts';
import { RECEPCIONISTA, Sprites, characterFor } from './sprites.ts';
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
/** Onde fica a mesa dentro da vaga de funcionário: baixa o bastante para o monitor não tapar o rosto. */
const DESK_Y = 50;
/**
 * Altura da cabeça do funcionário sentado atrás da mesa. Ele é posicionado pela cabeça, não
 * pelos pés: a animação de digitar é sentada (mais baixa) e afundaria atrás da mesa.
 */
export const HEAD_Y = 36;
/** O funcionário senta um pouco à esquerda: o monitor (de costas para nós) fica à direita do rosto. */
const SEAT_DX = -6;
export const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3];

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
  | (Rect & { kind: 'agent' | 'add' | 'room'; id: string })
  | (Rect & { kind: 'newroom'; cell: Cell });

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
export function layoutBuilding(rooms: Room[], agents: Agent[]): BuildingLayout {
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
  const fixed = FIXED_ROOMS.map((f) => ({ ...f, rect: cellRect(f) }));
  const free = freeCells(rooms).map((c) => ({ ...c, rect: cellRect(c) }));
  const box = (rects: Rect[]): Rect => {
    const all = rects.map(withCorridor);
    const x = Math.min(...all.map((r) => r.x));
    const y = Math.min(...all.map((r) => r.y));
    const right = Math.max(...all.map((r) => r.x + r.w));
    const bottom = Math.max(...all.map((r) => r.y + r.h)) + STREET_H;
    return { x, y, w: right - x, h: bottom - y };
  };
  const built = [...placed.map((p) => p.rect), ...fixed.map((f) => f.rect)];
  return { rooms: placed, fixed, free, bounds: box([...built, ...free.map((f) => f.rect)]), core: box(built) };
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
}

const CAM_KEY = 'officeCam';

export class Office {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pix = document.createElement('canvas');
  private pctx = this.pix.getContext('2d')!;
  private sprites = new Sprites();
  private layout: BuildingLayout = layoutBuilding([], []);
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
  private walkers = new Map<string, Walker & { agent: Agent }>();
  private graph = buildGraph([], GEO);
  private lastWalk = 0;
  selectedAgent?: string;
  selectedRoom?: string;

  constructor(private host: HTMLElement, private cb: OfficeCallbacks) {
    this.canvas = document.createElement('canvas');
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    try {
      const saved = JSON.parse(localStorage.getItem(CAM_KEY) ?? 'null');
      if (saved && [saved.x, saved.y, saved.z].every(Number.isFinite)) {
        this.cam = saved;
        this.userMoved = true;
      }
    } catch {}
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

  update(rooms: Room[], agents: Agent[]) {
    this.layout = layoutBuilding(rooms, agents);
    this.graph = buildGraph(this.builtCells(), GEO);
    this.syncWalkers(rooms, agents);
    if ((!this.cam || !this.userMoved) && this.cssW) this.fit();
    this.draw();
  }

  // ---------- câmera ----------

  get camera(): Camera {
    return this.cam ?? { x: 0, y: 0, z: 1 };
  }

  private setCamera(c: Camera) {
    this.cam = c;
    this.canvas.dataset.cam = `${Math.round(c.x)},${Math.round(c.y)},${c.z}`;
    try {
      localStorage.setItem(CAM_KEY, JSON.stringify(c));
    } catch {}
    this.resizePix();
    this.draw();
  }

  /** Mostra o prédio inteiro (as vagas "+" em volta podem ficar só pela metade). */
  fit() {
    this.userMoved = false;
    this.setCamera(fitCamera(this.layout.core, this.cssW, this.cssH));
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
    const r = this.layout.rooms.find((p) => p.room.id === roomId)?.rect;
    if (!r || !this.cssW) return;
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

  private resizePix() {
    const z = this.camera.z;
    this.pix.width = Math.max(1, Math.ceil(this.cssW / z) + 2);
    this.pix.height = Math.max(1, Math.ceil(this.cssH / z) + 2);
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
    return [...FIXED_ROOMS, ...this.layout.rooms.map((r) => r.room.pos!)];
  }

  /** Quem encerrou a sessão levanta da mesa e sai andando; quem voltou some do corredor. */
  private syncWalkers(rooms: Room[], agents: Agent[]) {
    const now = performance.now();
    for (const a of agents) {
      const room = rooms.find((r) => r.id === a.roomId);
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

  private walk(t: number) {
    const dt = this.lastWalk ? Math.min(250, t - this.lastWalk) : 0;
    this.lastWalk = t;
    for (const w of this.walkers.values()) {
      if (t < w.restUntil) continue;
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
    // A copa é o destino favorito.
    const copa = FIXED_ROOMS.find((f) => f.id === 'copa')!;
    const roll = hash(`${w.agent.id}:${Math.round(t)}`);
    const goCopa = roll % 3 === 0 && (w.cell.x !== copa.x || w.cell.y !== copa.y);
    const target = goCopa ? copa : options[roll % options.length];
    const route = routeBetween(this.graph, w.cell, target, GEO);
    if (!route.length) {
      w.restUntil = t + 5000;
      return;
    }
    const b = cellRect(target);
    // Um lugar para ficar lá dentro: perto da mesa da copa, dos sofás da recepção ou da porta.
    const spot: Point =
      target.x === copa.x && target.y === copa.y
        ? { x: b.x + b.w / 2 - 10 + ((roll % 5) - 2) * 18, y: b.y + 200 }
        : FIXED_ROOMS.some((f) => f.id === 'recepcao' && f.x === target.x && f.y === target.y)
          ? { x: b.x + (roll % 2 ? 60 : b.w - 60), y: b.y + 200 }
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
    const p = this.toWorld(e);
    // Agentes e mesas antes da sala, porque ficam dentro dela.
    return [...this.hits].reverse().find((h) => p.x >= h.x && p.x < h.x + h.w && p.y >= h.y && p.y < h.y + h.h);
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
    this.canvas.style.cursor = this.hover && this.hover.kind !== 'room' ? 'pointer' : 'grab';
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
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    this.zoom(e.deltaY < 0 ? 1 : -1, { x: e.clientX - r.left, y: e.clientY - r.top });
  }

  // ---------- desenho ----------

  private draw() {
    if (!this.cssW || !this.cam) return;
    const p = this.pctx;
    const c = this.camera;
    const left = Math.round(c.x - this.pix.width / 2);
    const top = Math.round(c.y - this.pix.height / 2);
    const view = { x: left, y: top, w: this.pix.width, h: this.pix.height };

    p.setTransform(1, 0, 0, 1, 0, 0);
    p.imageSmoothingEnabled = false;
    p.clearRect(0, 0, this.pix.width, this.pix.height);
    p.setTransform(1, 0, 0, 1, -left, -top);
    this.hits = [];

    this.drawGround(view);
    this.drawStreet(view);
    this.drawTrees(view);
    for (const f of this.layout.free) if (overlaps(f.rect, view)) this.drawFreeCell(f);
    this.drawCorridors();
    for (const f of this.layout.fixed) if (overlaps(f.rect, view)) this.drawFixed(f);
    for (const r of this.layout.rooms) if (overlaps(r.rect, view)) this.drawRoom(r);
    this.drawWalkers(view);

    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    // O canvas de baixa resolução começa em (left, top); a câmera pode estar entre dois pixels.
    const offX = (left - (c.x - this.cssW / 2 / c.z)) * c.z;
    const offY = (top - (c.y - this.cssH / 2 / c.z)) * c.z;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2f6b33';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.pix, offX * dpr, offY * dpr, this.pix.width * c.z * dpr, this.pix.height * c.z * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.drawTexts();
  }

  private drawGround(view: Rect) {
    const p = this.pctx;
    const grama = this.sprites.pisos.get('grama');
    if (!grama) {
      rect(p, view.x, view.y, view.w, view.h, '#2f6b33');
      return;
    }
    const s = grama.width;
    for (let y = Math.floor(view.y / s) * s; y < view.y + view.h; y += s) {
      for (let x = Math.floor(view.x / s) * s; x < view.x + view.w; x += s) p.drawImage(grama, x, y);
    }
  }

  /** Calçada e rua de ponta a ponta, embaixo do térreo, com postes, bancos e um carro passando. */
  private drawStreet(view: Rect) {
    const p = this.pctx;
    const y = STREET_Y;
    if (y > view.y + view.h || y + STREET_H < view.y) return;
    rect(p, view.x, y, view.w, 18, '#b9b4a9');
    for (let x = Math.floor(view.x / 24) * 24; x < view.x + view.w; x += 24) rect(p, x, y, 1, 18, '#a29d92');
    rect(p, view.x, y + 18, view.w, 56, '#3b3d45');
    for (let x = Math.floor(view.x / 40) * 40; x < view.x + view.w; x += 40) rect(p, x, y + 45, 22, 2, '#e8d48a');
    rect(p, view.x, y + 74, view.w, 18, '#b9b4a9');
    for (let x = Math.floor(view.x / 24) * 24; x < view.x + view.w; x += 24) rect(p, x + 12, y + 74, 1, 18, '#a29d92');

    // carro atravessando a rua, sempre para a direita
    const carro = this.sprites.objetos.get('carro');
    if (carro) {
      const span = 2400;
      const cx = view.x + ((performance.now() / 1000) * 70 - view.x + span * 1000) % span - carro.width;
      p.drawImage(carro, Math.round(cx), y + 18 + 28 - carro.height + 6);
    }

    // postes e bancos na calçada de baixo, em intervalos fixos do mundo
    const poste = this.sprites.objetos.get('poste');
    const banco = this.sprites.objetos.get('banco');
    const step = 260;
    for (let x = Math.floor(view.x / step) * step - step; x < view.x + view.w + step; x += step) {
      if (poste) p.drawImage(poste, x, y + 92 - poste.height + 4);
      if (banco && hash(`banco${x}`) % 2) p.drawImage(banco, x + 70, y + 92 - banco.height + 6);
    }
  }

  /** Árvores espalhadas pela grama, sempre nos mesmos lugares, longe do prédio e da rua. */
  private drawTrees(view: Rect) {
    const arvore = this.sprites.objetos.get('arvore');
    if (!arvore) return;
    const keepOut = [...this.layout.rooms.map((r) => r.rect), ...this.layout.fixed.map((f) => f.rect), ...this.layout.free.map((f) => f.rect)].map(
      (r) => ({ x: r.x - 40 - CORR / 2, y: r.y - 50 - CORR / 2, w: r.w + 80 + CORR, h: r.h + 70 + CORR }),
    );
    keepOut.push({ x: view.x - 100, y: STREET_Y - 50, w: view.w + 200, h: STREET_H + 60 });
    const step = 112;
    for (let gy = Math.floor(view.y / step) - 1; gy * step < view.y + view.h; gy++) {
      for (let gx = Math.floor(view.x / step) - 1; gx * step < view.x + view.w; gx++) {
        // Só uma em cada três vagas do terreno ganha árvore, deslocada para não formar grade.
        if (hash(`t${gx}:${gy}`) % 3 !== 0) continue;
        const tx = gx * step + (hash(`${gx},${gy}`) % 60) - 30;
        const ty = gy * step + (hash(`${gy},${gx}`) % 50) - 25;
        const box = { x: tx + 8, y: ty + 8, w: arvore.width - 16, h: arvore.height - 8 };
        if (!keepOut.some((k) => overlaps(box, k))) this.pctx.drawImage(arvore, tx, ty);
      }
    }
  }

  /** Paredes de uma vaga: faixa de cima (com janela), contorno escuro e a porta para o corredor. */
  private drawShell(r: Rect, wallColor: string, opts: { door?: number } = {}) {
    const p = this.pctx;
    rect(p, r.x, r.y, r.w, WALL_H, wallColor);
    rect(p, r.x, r.y, r.w, 4, 'rgba(0,0,0,0.25)');
    rect(p, r.x, r.y + WALL_H - 5, r.w, 5, 'rgba(0,0,0,0.3)');
    rect(p, r.x, r.y + WALL_H, r.w, 3, 'rgba(0,0,0,0.15)');
    // janela com o céu da hora atual
    rect(p, r.x + 14, r.y + 9, 26, 20, '#1f2335');
    rect(p, r.x + 16, r.y + 11, 22, 16, this.skyColor());
    rect(p, r.x + 26, r.y + 11, 2, 16, '#1f2335');
    rect(p, r.x + 16, r.y + 18, 22, 2, '#1f2335');
    // contorno (as vagas vizinhas dividem a mesma parede)
    const wall = '#2a2438';
    rect(p, r.x, r.y, 3, r.h, wall);
    rect(p, r.x + r.w - 3, r.y, 3, r.h, wall);
    rect(p, r.x, r.y, r.w, 3, wall);
    const dw = opts.door ?? 40;
    const dx = r.x + (r.w - dw) / 2;
    rect(p, r.x, r.y + r.h - 4, dx - r.x, 4, wall);
    rect(p, dx + dw, r.y + r.h - 4, r.x + r.w - dx - dw, 4, wall);
    // batentes da porta
    rect(p, dx - 3, r.y + r.h - 8, 3, 8, '#5b6078');
    rect(p, dx + dw, r.y + r.h - 8, 3, 8, '#5b6078');
  }

  /**
   * Corredores: o anel em volta de cada vaga construída, com piso próprio, e a parede externa
   * nos lados que não dão para outra vaga. A entrada principal fica embaixo da recepção.
   */
  private drawCorridors() {
    const p = this.pctx;
    const built = this.builtCells();
    const has = (x: number, y: number) => built.some((c) => c.x === x && c.y === y);
    for (const c of built) this.tileFloor(withCorridor(cellRect(c)), 'corredor', '#8e94a3');
    const wall = '#2a2438';
    for (const c of built) {
      const e = withCorridor(cellRect(c));
      if (!has(c.x, c.y + 1)) rect(p, e.x, e.y, e.w, 4, wall);
      if (!has(c.x - 1, c.y)) rect(p, e.x, e.y, 4, e.h, wall);
      if (!has(c.x + 1, c.y)) rect(p, e.x + e.w - 4, e.y, 4, e.h, wall);
      if (c.y === 0 || !has(c.x, c.y - 1)) {
        const isEntrance = c.y === 0 && FIXED_ROOMS.some((f) => f.id === 'recepcao' && f.x === c.x);
        if (isEntrance) {
          // entrada principal: vão na parede e capacho
          const dw = 72;
          const dx = e.x + (e.w - dw) / 2;
          rect(p, e.x, e.y + e.h - 4, dx - e.x, 4, wall);
          rect(p, dx + dw, e.y + e.h - 4, e.x + e.w - dx - dw, 4, wall);
          rect(p, dx + 12, e.y + e.h - 16, dw - 24, 12, '#6b3f2a');
          rect(p, dx + 14, e.y + e.h - 14, dw - 28, 8, '#8a5236');
        } else {
          rect(p, e.x, e.y + e.h - 4, e.w, 4, wall);
        }
      }
    }
  }

  /** Funcionários andando, desenhados de trás para a frente (quem está mais embaixo, por cima). */
  private drawWalkers(view: Rect) {
    const p = this.pctx;
    const list = [...this.walkers.values()].sort((a, b) => a.y - b.y);
    const names = this.sprites.names();
    for (const w of list) {
      if (w.x < view.x - 50 || w.x > view.x + view.w + 50 || w.y < view.y - 80 || w.y > view.y + view.h + 20) continue;
      const seed = hash(w.agent.id);
      const who = characterFor(seed, names);
      const moving = w.path.length > 0 && performance.now() >= w.restUntil;
      const wx = w.x + laneOf(w.agent.id);
      const anim = this.sprites.anim(who, moving ? `andar-${w.dir}` : 'parado');
      if (!anim) continue;
      const q = Math.floor((this.frame + (seed % 5)) / (moving ? 1 : 2)) % anim.quadros;
      // sombra
      p.fillStyle = 'rgba(0,0,0,0.22)';
      p.beginPath();
      p.ellipse(wx, w.y, 11, 4, 0, 0, Math.PI * 2);
      p.fill();
      p.drawImage(anim.img, q * anim.w, 0, anim.w, anim.h, Math.round(wx - anim.w / 2), Math.round(w.y - anim.pesY), anim.w, anim.h);
      if (this.selectedAgent === w.agent.id) {
        const by = Math.round(w.y - anim.pesY + anim.cabecaY - 10 + (this.frame % 4 < 2 ? 0 : 2));
        for (let i = 0; i < 5; i++) rect(p, wx - 6 + i, by + i, 13 - i * 2, 1, '#c0caf5');
      }
      this.hits.push({ x: wx - 14, y: w.y - 50, w: 28, h: 54, kind: 'agent', id: w.agent.id });
    }
  }

  /** Piso de ladrilhos do PixelLab repetidos, cortado no retângulo (cor lisa se não carregou). */
  private tileFloor(r: Rect, name: string, fallback: string) {
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
    for (let y = r.y; y < r.y + r.h; y += tile.height) {
      for (let x = r.x; x < r.x + r.w; x += tile.width) p.drawImage(tile, x, y);
    }
    p.restore();
  }

  private woodFloor(r: Rect) {
    this.tileFloor(r, 'madeira', '#c9a77a');
  }

  /** Desenha um objeto do PixelLab com o canto superior esquerdo em (x, y), se ele existir. */
  private obj(name: string, x: number, y: number) {
    const img = this.sprites.objetos.get(name);
    if (img) this.pctx.drawImage(img, Math.round(x), Math.round(y));
    return img;
  }

  private drawFixed(f: FixedRoom & { rect: Rect }) {
    if (f.id === 'recepcao') this.drawReception(f.rect);
    else this.drawKitchen(f.rect);
  }

  /** Entrada: porta para o corredor, balcão com a recepcionista, sofás de espera, estante e plantas. */
  private drawReception(r: Rect) {
    const p = this.pctx;
    this.woodFloor({ x: r.x, y: r.y + WALL_H, w: r.w, h: r.h - WALL_H });
    // tapete do caminho da porta ao balcão
    rect(p, r.x + r.w / 2 - 30, r.y + 140, 60, r.h - 144, '#7a2f3a');
    rect(p, r.x + r.w / 2 - 26, r.y + 144, 52, r.h - 152, '#9b3d4a');
    this.drawShell(r, '#5a6b8c', { door: 72 });

    this.obj('estante', r.x + 8, r.y + WALL_H - 18);
    this.obj('vaso-grande', r.x + r.w - 56, r.y + WALL_H - 4);
    // recepcionista atrás do balcão
    const cx = r.x + r.w / 2;
    this.drawPerson(cx, r.y + 58, RECEPCIONISTA, 'parado', 7, r.y + 98);
    const balcao = this.sprites.objetos.get('balcao');
    if (balcao) p.drawImage(balcao, Math.round(cx - balcao.width / 2), r.y + 74);
    // sofás de espera e bebedouro
    this.obj('sofa', r.x + 14, r.y + 168);
    this.obj('sofa', r.x + r.w - 94, r.y + 168);
    this.obj('bebedouro', r.x + r.w - 40, r.y + 108);
  }

  /** Copa: piso de cerâmica, bancada com pia e cafeteira, geladeira, mesa com cadeiras e TV. */
  private drawKitchen(r: Rect) {
    const p = this.pctx;
    this.tileFloor({ x: r.x, y: r.y + WALL_H, w: r.w, h: r.h - WALL_H }, 'copa', '#dfe2ea');
    this.drawShell(r, '#6b8c7a');
    // bancada encostada na parede, com pia, xícaras e a cafeteira em cima
    const by = r.y + WALL_H + 2;
    rect(p, r.x + 10, by, r.w - 80, 26, '#8d93a6');
    rect(p, r.x + 10, by, r.w - 80, 5, '#b4b9c8');
    rect(p, r.x + 40, by + 7, 34, 14, '#5f6b85');
    rect(p, r.x + 54, by + 3, 4, 6, '#d0d4df');
    rect(p, r.x + 170, by + 6, 8, 10, '#f5f5f5');
    rect(p, r.x + 182, by + 6, 8, 10, '#f5f5f5');
    this.obj('cafeteira', r.x + 110, by - 22);
    this.obj('geladeira', r.x + r.w - 60, r.y + WALL_H - 26);
    this.obj('mesa-copa', r.x + r.w / 2 - 58, r.y + 120);
    this.obj('tv', r.x + 14, r.y + 150);
    this.obj('planta', r.x + r.w - 40, r.y + r.h - 40);
  }

  /** Vaga livre encostada no prédio: o "+" que abre uma sala nova ali. */
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
    const cy = r.y + r.h / 2 - 8;
    rect(p, cx - 18, cy - 18, 36, 36, hovered ? '#3d59a1' : 'rgba(26,27,38,0.55)');
    rect(p, cx - 2, cy - 11, 4, 22, '#ffffff');
    rect(p, cx - 11, cy - 2, 22, 4, '#ffffff');
    this.hits.push({ ...r, kind: 'newroom', cell: { x: f.x, y: f.y } });
  }

  private drawRoom(pr: PlacedRoom) {
    const p = this.pctx;
    const { rect: r, room } = pr;
    const hue = hash(room.id) % 360;
    this.woodFloor({ x: r.x, y: r.y + WALL_H, w: r.w, h: r.h - WALL_H });
    this.drawShell(r, `hsl(${hue} 22% 38%)`);

    // placa com o nome (o texto entra no passe de texto)
    const signW = 150;
    rect(p, r.x + (r.w - signW) / 2, r.y + 9, signW, 20, '#2a2f45');
    rect(p, r.x + (r.w - signW) / 2 + 1, r.y + 10, signW - 2, 18, '#3b4261');

    // luz de atenção: pisca quando alguém terminou ou precisa de aprovação
    const needs = pr.agents.some((a) => a.status === 'done' || a.status === 'waiting');
    const lampOn = needs && this.frame % 6 < 3;
    rect(p, r.x + r.w - 26, r.y + 12, 11, 11, '#1f2335');
    rect(p, r.x + r.w - 25, r.y + 13, 9, 9, lampOn ? '#e0af68' : needs ? '#7a5b2a' : '#2a2f45');

    if (this.selectedRoom === room.id) {
      const c = '#c0caf5';
      rect(p, r.x + 3, r.y + 3, r.w - 6, 2, c);
      rect(p, r.x + 3, r.y + r.h - 6, r.w - 6, 2, c);
      rect(p, r.x + 3, r.y + 3, 2, r.h - 6, c);
      rect(p, r.x + r.w - 5, r.y + 3, 2, r.h - 6, c);
    }

    this.hits.push({ ...r, kind: 'room', id: room.id });
    pr.agents.forEach((a, i) => {
      const o = slotOrigin(r, i);
      this.drawDesk(o.x, o.y, a);
    });
    const empty = slotOrigin(r, pr.agents.length);
    this.drawEmptyDesk(empty.x, empty.y, room.id);
  }

  private drawEmptyDesk(sx: number, sy: number, roomId: string) {
    const p = this.pctx;
    const cx = sx + SLOT_W / 2;
    const hovered = this.hover?.kind === 'add' && this.hover.id === roomId;
    const mesa = this.deskSprite();
    if (mesa) {
      p.save();
      p.globalAlpha = hovered ? 0.7 : 0.35;
      p.drawImage(mesa, Math.round(cx - mesa.width / 2), sy + DESK_Y);
      p.restore();
    }
    const col = hovered ? '#ffffff' : '#e0e6ff';
    rect(p, cx - 9, sy + DESK_Y - 12, 18, 18, hovered ? '#3d59a1' : 'rgba(26,27,38,0.7)');
    rect(p, cx - 1, sy + DESK_Y - 8, 2, 10, col);
    rect(p, cx - 5, sy + DESK_Y - 4, 10, 2, col);
    this.hits.push({ x: sx + 4, y: sy + 8, w: SLOT_W - 8, h: SLOT_H - 12, kind: 'add', id: roomId });
  }

  /** Mesa do funcionário: a nova, com o monitor virado para ele; a antiga se a nova faltar. */
  private deskSprite() {
    return this.sprites.objetos.get('mesa-costas') ?? this.sprites.objetos.get('mesa');
  }

  /** Alguém sentado com a cabeça em headY, cortado em clipBottom (a altura do tampo). */
  private drawPerson(cx: number, headY: number, who: string, animName: string, seed: number, clipBottom: number) {
    const anim = this.sprites.anim(who, animName);
    if (!anim) return;
    const p = this.pctx;
    const q = Math.floor((this.frame + seed) / 2) % anim.quadros;
    p.save();
    p.beginPath();
    p.rect(cx - anim.w, headY - anim.h, anim.w * 2, clipBottom - (headY - anim.h));
    p.clip();
    p.drawImage(anim.img, q * anim.w, 0, anim.w, anim.h, Math.round(cx - anim.w / 2), headY - anim.cabecaY, anim.w, anim.h);
    p.restore();
  }

  private drawDesk(sx: number, sy: number, a: Agent) {
    const p = this.pctx;
    const cx = sx + SLOT_W / 2;
    const seed = hash(a.id);
    const f = this.frame + (seed % 7);
    const names = this.sprites.names();
    const who = characterFor(seed, names);

    // cadeira atrás do funcionário
    const cadeira = this.sprites.objetos.get('cadeira');
    if (cadeira) p.drawImage(cadeira, Math.round(cx - cadeira.width / 2) + SEAT_DX, sy + HEAD_Y + 6);

    // funcionário (some quando sai do escritório; pisca enquanto chega)
    const animName = ANIM_FOR[a.status];
    const fading = a.status === 'starting' && f % 4 < 2;
    const anim = animName && !fading ? this.sprites.anim(who, animName) : undefined;
    if (anim) {
      const speed = a.status === 'working' ? 1 : 2;
      const q = Math.floor(f / speed) % anim.quadros;
      // Corta na altura do tampo: as pernas ficariam aparecendo no vão entre os pés da mesa.
      p.save();
      p.beginPath();
      p.rect(sx, sy, SLOT_W, DESK_Y + 24);
      p.clip();
      p.drawImage(anim.img, q * anim.w, 0, anim.w, anim.h, Math.round(cx - anim.w / 2) + SEAT_DX, sy + seatTop(anim), anim.w, anim.h);
      p.restore();
    }

    // mesa na frente (esconde as pernas)
    const mesa = this.deskSprite();
    if (mesa) p.drawImage(mesa, Math.round(cx - mesa.width / 2), sy + DESK_Y);

    // ajudantes (subagentes): colegas em miniatura ao lado da mesa
    for (let i = 0; i < Math.min(2, a.subagents); i++) {
      const helper = this.sprites.anim(characterFor(seed + 1 + i, names), 'parado');
      if (!helper) continue;
      const hx = i === 0 ? sx + SLOT_W - 18 : sx - 2;
      const hop = (f + i * 3) % 6 < 3 ? 0 : -1;
      const q = Math.floor((f + i) / 2) % helper.quadros;
      p.drawImage(helper.img, q * helper.w, 0, helper.w, helper.h, hx - helper.w / 4, sy + 74 - helper.pesY / 2 + hop, helper.w / 2, helper.h / 2);
    }

    // seta sobre o selecionado
    if (this.selectedAgent === a.id) {
      const by = sy + 6 + (f % 4 < 2 ? 0 : 2);
      for (let i = 0; i < 5; i++) rect(p, cx - 6 + i, by + i, 13 - i * 2, 1, '#c0caf5');
    }

    this.hits.push({ x: sx + 2, y: sy + 8, w: SLOT_W - 4, h: SLOT_H - 10, kind: 'agent', id: a.id });
  }

  private skyColor() {
    const h = new Date().getHours();
    if (h >= 7 && h < 17) return '#7dcfff';
    if (h >= 17 && h < 19) return '#ff9e64';
    return '#24283b';
  }

  // ---------- textos (em escala de tela) ----------

  private toScreen(x: number, y: number) {
    const c = this.camera;
    return { x: (x - c.x) * c.z + this.cssW / 2, y: (y - c.y) * c.z + this.cssH / 2 };
  }

  private drawTexts() {
    const c = this.ctx;
    const z = this.camera.z;
    const signFont = Math.max(9, Math.round(10 * z));

    for (const f of this.layout.fixed) {
      const s = this.toScreen(f.rect.x + f.rect.w / 2, f.rect.y + 19);
      this.label(f.name, s.x, s.y, signFont, '#ffffff', 'rgba(26,27,38,0.75)');
    }

    for (const f of this.layout.free) {
      if (!(this.hover?.kind === 'newroom' && this.hover.cell.x === f.x && this.hover.cell.y === f.y)) continue;
      const s = this.toScreen(f.rect.x + f.rect.w / 2, f.rect.y + f.rect.h / 2 + 26);
      this.label('Nova sala aqui', s.x, s.y, Math.max(11, Math.round(9 * z)), '#ffffff', 'rgba(61,89,161,0.9)');
    }

    for (const pr of this.layout.rooms) {
      const r = pr.rect;
      const s = this.toScreen(r.x + r.w / 2, r.y + 19);
      c.font = `${signFont}px "Silkscreen", monospace`;
      this.label(fit(c, pr.room.name, 140 * z), s.x, s.y, signFont, '#e0e6ff');
      if (pr.overflow) {
        const o = this.toScreen(r.x + r.w - 52, r.y + 19);
        this.label(`+${pr.overflow}`, o.x, o.y, Math.max(9, Math.round(8 * z)), '#1a1b26', '#e0af68');
      }

      pr.agents.forEach((a, i) => {
        const o = slotOrigin(r, i);
        const cx = o.x + SLOT_W / 2;
        if (z >= 0.75) {
          const size = Math.max(9, Math.round(9 * z));
          const n = this.toScreen(cx, o.y + DESK_Y + 53);
          c.font = `${size}px "Silkscreen", monospace`;
          this.label(fit(c, a.name, (SLOT_W - 4) * z), n.x, n.y, size, STATUS_COLOR[a.status], 'rgba(26,27,38,0.85)');
        }
        if (a.subagents > 2) {
          const h = this.toScreen(cx + 34, o.y + 54);
          this.label(`+${a.subagents - 2}`, h.x, h.y, 11, '#c0caf5');
        }
        // balão de estado sobre a cabeça
        const hovered = this.hover?.kind === 'agent' && this.hover.id === a.id;
        const icon = { waiting: '!', done: '✓', working: '…', starting: '…' }[a.status as string];
        const head = this.toScreen(cx, o.y + 30);
        if (hovered) this.bubble(head.x, head.y, a.activity, STATUS_COLOR[a.status], true);
        else if (icon) this.bubble(head.x, head.y, icon, STATUS_COLOR[a.status], false);
      });
    }

    for (const w of this.walkers.values()) {
      const wx = w.x + laneOf(w.agent.id);
      const head = this.toScreen(wx, w.y - 46);
      if (head.x < -50 || head.x > this.cssW + 50 || head.y < -50 || head.y > this.cssH + 80) continue;
      if (z >= 0.75) {
        const n = this.toScreen(wx, w.y + 9);
        const size = Math.max(9, Math.round(8 * z));
        this.label(w.agent.name, n.x, n.y, size, '#c0caf5', 'rgba(26,27,38,0.7)');
      }
      if (this.hover?.kind === 'agent' && this.hover.id === w.agent.id) {
        this.bubble(head.x, head.y, 'Fora do escritório: clique para retomar', STATUS_COLOR.exited, true);
      }
    }

    if (!this.layout.rooms.length) {
      const b = this.layout.bounds;
      const s = this.toScreen(b.x + b.w / 2, b.y - 10);
      this.label('Clique num + para abrir a sala do seu primeiro projeto', s.x, s.y, 13, '#ffffff', 'rgba(26,27,38,0.85)');
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

/** Cada um anda numa "faixa" do corredor, para dois no mesmo caminho não ficarem sobrepostos. */
function laneOf(id: string) {
  return ((hash(id) % 5) - 2) * 5;
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
