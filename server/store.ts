import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { ActivityEvent, Agent, OfficeState, Room, ServerMsg } from '../shared/types.ts';
import { autoPlace } from '../shared/building.ts';
import { DATA_DIR } from './platform.ts';

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_ACTIVITY = 300;

interface Persisted {
  rooms: Room[];
  agents: Agent[];
}

/** Estado do escritório. Emite 'msg' com cada mudança para o WebSocket repassar. */
export class Store extends EventEmitter {
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
      for (const r of data.rooms ?? []) this.rooms.set(r.id, r);
      // Salas de antes do prédio ganham uma vaga encostada nele, na ordem em que foram criadas.
      const semVaga = [...this.rooms.values()].filter((r) => !r.pos).sort((a, b) => a.createdAt - b.createdAt);
      for (const r of semVaga) r.pos = autoPlace([...this.rooms.values()]);
      if (semVaga.length) this.save();
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
      const data: Persisted = { rooms: [...this.rooms.values()], agents: [...this.agents.values()] };
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
    }, 300);
  }

  snapshot(): OfficeState {
    return { rooms: [...this.rooms.values()], agents: [...this.agents.values()], activity: this.activity };
  }

  private send(msg: ServerMsg) {
    this.emit('msg', msg);
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
