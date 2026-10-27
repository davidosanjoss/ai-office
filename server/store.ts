import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { FLOOR_COLORS, autoPlace } from '../shared/building.ts';
import type { ActivityEvent, Agent, Floor, OfficeState, Room, ServerMsg } from '../shared/types.ts';
import { DATA_DIR } from './platform.ts';

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_ACTIVITY = 300;

interface Persisted {
  floors?: Floor[];
  rooms: Room[];
  agents: Agent[];
}

/** Andar criado para as salas de antes dos andares existirem. */
export const DEFAULT_FLOOR: Omit<Floor, 'createdAt'> = { id: 'geral', name: 'Geral', color: FLOOR_COLORS[0], order: 1 };

/** Estado do escritório. Emite 'msg' com cada mudança para o WebSocket repassar. */
export class Store extends EventEmitter {
  floors = new Map<string, Floor>();
  rooms = new Map<string, Room>();
  agents = new Map<string, Agent>();
  activity: ActivityEvent[] = [];
  private nextEventId = 1;
  private saveTimer?: NodeJS.Timeout;

  constructor(private file = STATE_FILE) {
    super();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Persisted;
      for (const f of data.floors ?? []) this.floors.set(f.id, f);
      for (const r of data.rooms ?? []) this.rooms.set(r.id, r);
      let migrated = false;
      // Salas de antes dos andares vão para o andar "Geral", mantendo a vaga que já tinham.
      const semAndar = [...this.rooms.values()].filter((r) => !r.floorId || !this.floors.has(r.floorId));
      if (semAndar.length) {
        if (!this.floors.has(DEFAULT_FLOOR.id)) this.floors.set(DEFAULT_FLOOR.id, { ...DEFAULT_FLOOR, createdAt: Date.now() });
        for (const r of semAndar) {
          r.floorId = DEFAULT_FLOOR.id;
          // A vaga antiga pode já estar ocupada no andar de destino: aí ganha uma livre.
          const ocupada = this.roomsOn(DEFAULT_FLOOR.id).some((o) => o !== r && o.pos && r.pos && o.pos.x === r.pos.x && o.pos.y === r.pos.y);
          if (ocupada) r.pos = undefined;
        }
        migrated = true;
      }
      // Salas de antes do prédio ganham uma vaga encostada nele, na ordem em que foram criadas.
      const semVaga = [...this.rooms.values()].filter((r) => !r.pos).sort((a, b) => a.createdAt - b.createdAt);
      for (const r of semVaga) r.pos = autoPlace(this.roomsOn(r.floorId!));
      if (semVaga.length || migrated) this.save();
      // Processos não sobrevivem a um reinício do servidor; o agente fica disponível para retomar.
      for (const a of data.agents ?? []) {
        this.agents.set(a.id, { ...a, status: 'exited', activity: 'Fora do escritório', subagents: 0 });
      }
    } catch (err) {
      console.error('[store] state.json inválido, ignorando:', err);
    }
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const data: Persisted = { floors: [...this.floors.values()], rooms: [...this.rooms.values()], agents: [...this.agents.values()] };
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
    }, 300);
  }

  snapshot(): OfficeState {
    return {
      floors: [...this.floors.values()].sort((a, b) => a.order - b.order),
      rooms: [...this.rooms.values()],
      agents: [...this.agents.values()],
      activity: this.activity,
    };
  }

  private send(msg: ServerMsg) {
    this.emit('msg', msg);
  }

  /** Salas de um andar. */
  roomsOn(floorId: string): Room[] {
    return [...this.rooms.values()].filter((r) => r.floorId === floorId);
  }

  putFloor(floor: Floor) {
    this.floors.set(floor.id, floor);
    this.save();
    this.send({ t: 'floor', floor });
  }

  removeFloor(id: string) {
    this.floors.delete(id);
    this.save();
    this.send({ t: 'floorRemoved', id });
  }

  putRoom(room: Room) {
    this.rooms.set(room.id, room);
    this.save();
    this.send({ t: 'room', room });
  }

  removeRoom(id: string) {
    this.rooms.delete(id);
    this.save();
    this.send({ t: 'roomRemoved', id });
  }

  putAgent(agent: Agent) {
    this.agents.set(agent.id, agent);
    this.save();
    this.send({ t: 'agent', agent });
  }

  patchAgent(id: string, patch: Partial<Agent>) {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.putAgent({ ...agent, ...patch });
  }

  removeAgent(id: string) {
    this.agents.delete(id);
    this.save();
    this.send({ t: 'agentRemoved', id });
  }

  log(agentId: string, text: string, kind: ActivityEvent['kind']) {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const event: ActivityEvent = { id: this.nextEventId++, ts: Date.now(), agentId, roomId: agent.roomId, text, kind };
    this.activity.push(event);
    if (this.activity.length > MAX_ACTIVITY) this.activity.splice(0, this.activity.length - MAX_ACTIVITY);
    this.send({ t: 'activity', event });
  }

  output(id: string, data: string) {
    this.send({ t: 'out', id, data });
  }
}

export const store = new Store();
