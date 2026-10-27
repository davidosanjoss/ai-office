import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { ClientMsg, MemoryStatus, ServerMsg } from '../shared/types.ts';
import {
  createAgent,
  createShell,
  getScrollback,
  isBusy,
  killAgent,
  removeAgent,
  resize,
  resumeAgent,
  stopAgent,
  writeInput,
} from './agents.ts';
import { discoverProjects } from './discover.ts';
import { fileDiff, gitInfo } from './git.ts';
import { handleHook } from './hooks.ts';
import { IncidentError, addParticipants, closeIncident, incidentAt, leaveIncidents, openIncident, openWarShell, sendMessage, shareMessage } from './incidents.ts';
import { MemoryError, memoryEvents, memoryStatus, openDataDir, startInstall, startUninstall } from './memory.ts';
import { pickFolder } from './picker.ts';
import { WorktreeError, mergeWorktree, openPr, removeWorktree, worktreeStatus } from './worktree.ts';
import { PORT } from './platform.ts';
import { DEFAULT_FLOOR, store } from './store.ts';
import { FLOOR_COLORS, MAX_WAR_ROOMS, autoPlace, canPlace, isValidCell } from '../shared/building.ts';
import type { Agent, Floor, Room } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Monta o servidor sem abrir porta: o index.ts escuta, e os testes usam inject() ou listen(0). */
export async function buildApp(opts: { port?: number } = {}) {
  const port = opts.port ?? PORT;
  const app = Fastify({ logger: false });

  // Instalação nova: o prédio já começa com um andar, para a primeira sala ter onde ficar.
  if (!store.floors.size) store.putFloor({ ...DEFAULT_FLOOR, createdAt: Date.now() });

  // Proteção contra sites maliciosos falando com o localhost (CSRF e DNS rebinding).
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    const viaVite = host === 'localhost:5173' || host === '127.0.0.1:5173';
    if (!allowedHosts.has(host) && !viaVite) return reply.code(403).send({ error: 'host não permitido' });
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: 'origem não permitida' });
  });

  await app.register(fastifyWebsocket);

  app.get('/ws', { websocket: true }, (socket) => {
    const send = (msg: ServerMsg) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg));
    const onMsg = (msg: ServerMsg) => send(msg);
    const onMemory = (memory: MemoryStatus) => send({ t: 'memory', memory });
    store.on('msg', onMsg);
    memoryEvents.on('status', onMemory);
    send({ t: 'state', state: store.snapshot() });

    socket.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.t) {
        case 'in':
          writeInput(msg.id, msg.data);
          break;
        case 'resize':
          resize(msg.id, msg.cols, msg.rows);
          break;
        case 'attach':
          send({ t: 'replay', id: msg.id, data: getScrollback(msg.id) });
          break;
        case 'seen': {
          const agent = store.agents.get(msg.id);
          if (agent?.status === 'done') store.patchAgent(msg.id, { status: 'idle', activity: 'Esperando o próximo pedido', attentionAt: undefined });
          break;
        }
      }
    });
    socket.on('close', () => {
      store.off('msg', onMsg);
      memoryEvents.off('status', onMemory);
    });
  });

  app.post<{ Body: { event: string; agentId?: string; payload: Record<string, unknown> } }>('/api/hook', async (req) => {
    if (req.body && typeof req.body === 'object') handleHook(req.body);
    return { ok: true };
  });

  app.get('/api/projects', async () => discoverProjects());

  app.post<{ Body: { start?: string } }>('/api/pick-folder', async (req, reply) => {
    const start = req.body?.start && fs.existsSync(req.body.start) ? req.body.start : undefined;
    try {
      return { path: (await pickFolder(start)) ?? null };
    } catch (err) {
      return reply.code(501).send({ error: (err as Error).message });
    }
  });

  // ---------- andares ----------

  app.post<{ Body: { name?: string; color?: string } }>('/api/floors', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'Dê um nome ao andar' });
    const floors = [...store.floors.values()];
    const order = floors.reduce((max, f) => Math.max(max, f.order), 0) + 1;
    const color = validColor(req.body?.color) ?? FLOOR_COLORS[floors.length % FLOOR_COLORS.length];
    const floor: Floor = { id: randomUUID().slice(0, 8), name, color, order, createdAt: Date.now() };
    store.putFloor(floor);
    return floor;
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; color?: string; warRooms?: number } }>('/api/floors/:id', async (req, reply) => {
    const floor = store.floors.get(req.params.id);
    if (!floor) return reply.code(404).send({ error: 'Andar não encontrado' });
    const name = req.body?.name === undefined ? floor.name : String(req.body.name).trim();
    if (!name) return reply.code(400).send({ error: 'Dê um nome ao andar' });
    let warRooms = store.warRoomsOf(floor.id);
    if (req.body?.warRooms !== undefined) {
      const n = Number(req.body.warRooms);
      if (!Number.isInteger(n) || n < 1 || n > MAX_WAR_ROOMS) return reply.code(400).send({ error: `Um andar tem de 1 a ${MAX_WAR_ROOMS} salas de guerra` });
      for (let slot = n; slot < warRooms; slot++) {
        if (incidentAt(floor.id, slot)) return reply.code(400).send({ error: 'Encerre o incidente antes de tirar essa sala de guerra' });
      }
      warRooms = n;
    }
    const updated = { ...floor, name, color: validColor(req.body?.color) ?? floor.color, warRooms };
    store.putFloor(updated);
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/api/floors/:id', async (req, reply) => {
    if (!store.floors.has(req.params.id)) return reply.code(404).send({ error: 'Andar não encontrado' });
    if (store.roomsOn(req.params.id).length) {
      return reply.code(400).send({ error: 'O andar ainda tem salas: mova ou feche as salas antes de apagar' });
    }
    store.removeFloor(req.params.id);
    return { ok: true };
  });

  // ---------- salas ----------

  app.post<{ Body: { path: string; name?: string; floorId?: string; pos?: { x: number; y: number } } }>('/api/rooms', async (req, reply) => {
    const dir = path.resolve(String(req.body?.path ?? '').trim());
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return reply.code(400).send({ error: 'Pasta não existe' });
    const existing = [...store.rooms.values()].find((r) => r.path === dir);
    if (existing) return existing;
    const floorId = req.body.floorId ?? firstFloorId();
    if (!floorId || !store.floors.has(floorId)) return reply.code(400).send({ error: 'Escolha um andar para a sala' });
    const rooms = store.roomsOn(floorId);
    const wanted = req.body.pos;
    if (wanted !== undefined && !(isValidCell(wanted) && canPlace(rooms, wanted, 'andar', store.warRoomsOf(floorId)))) {
      return reply.code(400).send({ error: 'Essa vaga do andar não está livre' });
    }
    const pos = wanted ? { x: wanted.x, y: wanted.y } : autoPlace(rooms, 'andar', store.warRoomsOf(floorId));
    const room: Room = { id: randomUUID().slice(0, 8), name: req.body.name?.trim() || path.basename(dir), path: dir, createdAt: Date.now(), floorId, pos };
    store.putRoom(room);
    return room;
  });

  /** Leva a sala (com os agentes, que continuam trabalhando) para uma vaga livre de outro andar. */
  app.post<{ Params: { id: string }; Body: { floorId: string } }>('/api/rooms/:id/move', async (req, reply) => {
    const room = store.rooms.get(req.params.id);
    if (!room) return reply.code(404).send({ error: 'Sala não encontrada' });
    const floorId = String(req.body?.floorId ?? '');
    if (!store.floors.has(floorId)) return reply.code(400).send({ error: 'Andar não encontrado' });
    if (room.floorId === floorId) return room;
    const moved = { ...room, floorId, pos: autoPlace(store.roomsOn(floorId), 'andar', store.warRoomsOf(floorId)) };
    store.putRoom(moved);
    return moved;
  });

  app.delete<{ Params: { id: string } }>('/api/rooms/:id', async (req) => {
    for (const a of store.agents.values()) {
      if (a.roomId !== req.params.id) continue;
      leaveIncidents(a.id);
      removeAgent(a.id);
    }
    store.removeRoom(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id/git', async (req, reply) => {
    const room = store.rooms.get(req.params.id);
    if (!room) return reply.code(404).send({ error: 'Sala não encontrada' });
    return gitInfo(room.path);
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id/git', async (req, reply) => {
    const agent = store.agents.get(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Agente não encontrado' });
    return gitInfo(agent.cwd);
  });

  // Diff de um arquivo alterado, na pasta do agente (worktree incluso) ou da sala.
  app.get<{ Params: { kind: string; id: string }; Querystring: { path?: string; scope?: string } }>(
    '/api/:kind/:id/diff',
    async (req, reply) => {
      const { kind, id } = req.params;
      const cwd = kind === 'agents' ? store.agents.get(id)?.cwd : kind === 'rooms' ? store.rooms.get(id)?.path : undefined;
      if (!cwd) return reply.code(404).send({ error: 'Não encontrado' });
      const scope = req.query.scope === 'branch' ? 'branch' : 'working';
      try {
        return await fileDiff(cwd, String(req.query.path ?? ''), scope);
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { roomId: string; name?: string; worktree?: boolean } }>('/api/agents', async (req, reply) => {
    try {
      return await createAgent(String(req.body?.roomId), { name: req.body?.name, worktree: !!req.body?.worktree });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { roomId: string } }>('/api/shells', async (req, reply) => {
    try {
      return createShell(String(req.body?.roomId));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id/busy', async (req) => ({ busy: isBusy(req.params.id) }));

  app.post<{ Params: { id: string } }>('/api/agents/:id/resume', async (req) => {
    resumeAgent(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/agents/:id/stop', async (req) => {
    killAgent(req.params.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/agents/:id', async (req) => {
    leaveIncidents(req.params.id);
    removeAgent(req.params.id);
    return { ok: true };
  });

  // ---------- ai-memory (memória dos agentes) ----------

  const memoryRoute = (fn: () => unknown) => async (_req: unknown, reply: any) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MemoryError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  };
  app.get('/api/memory', async () => memoryStatus());
  /** Instala em segundo plano: responde na hora e o progresso chega pelo WebSocket. */
  app.post('/api/memory/install', memoryRoute(() => startInstall()));
  app.post('/api/memory/uninstall', memoryRoute(() => startUninstall()));
  app.post('/api/memory/open', memoryRoute(() => (openDataDir(), { ok: true })));

  // ---------- worktree de um agente: PR, merge na sala e encerrar ----------

  /** Acha o agente e a sala dele; erros de regra (conflito, sem origin...) viram 400 com a mensagem. */
  const worktreeRoute =
    (fn: (agent: Agent, room: Room, req: any) => unknown) =>
    async (req: any, reply: any) => {
      const agent = store.agents.get(req.params.id);
      const room = agent && store.rooms.get(agent.roomId);
      if (!agent || !room) return reply.code(404).send({ error: 'Agente não encontrado' });
      try {
        return await fn(agent, room, req);
      } catch (err) {
        if (err instanceof WorktreeError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    };

  app.get('/api/agents/:id/worktree', worktreeRoute((agent, room) => worktreeStatus(agent, room)));
  app.post('/api/agents/:id/worktree/merge', worktreeRoute((agent, room) => mergeWorktree(agent, room)));
  app.post(
    '/api/agents/:id/worktree/pr',
    worktreeRoute(async (agent, room, req) => {
      const pr = await openPr(agent, room, String(req.body?.title ?? ''), String(req.body?.body ?? ''));
      store.patchAgent(agent.id, { worktreePr: pr.url });
      return pr;
    }),
  );
  /** Encerra a sessão do agente, remove a pasta do worktree e, se pedido, a branch. O agente sai do escritório. */
  app.post(
    '/api/agents/:id/worktree/remove',
    worktreeRoute(async (agent, room, req) => {
      await removeWorktree(agent, room, !!req.body?.deleteBranch, () => stopAgent(agent.id));
      leaveIncidents(agent.id);
      removeAgent(agent.id);
      return { ok: true };
    }),
  );

  // ---------- sala de guerra ----------

  /** Erros de regra (sala ocupada, @ desconhecido...) viram 400 com a mensagem para você. */
  const incidentRoute = (fn: (req: any) => unknown) => async (req: any, reply: any) => {
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof IncidentError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  };

  app.post('/api/incidents', incidentRoute((req) => openIncident(req.body ?? {})));
  app.post('/api/incidents/:id/participants', incidentRoute((req) => addParticipants(req.params.id, req.body?.roomIds, req.body?.agentIds)));
  app.post('/api/incidents/:id/messages', incidentRoute((req) => sendMessage(req.params.id, req.body?.text)));
  app.post('/api/incidents/:id/messages/:msg/share', incidentRoute((req) => shareMessage(req.params.id, Number(req.params.msg))));
  app.post('/api/incidents/:id/shells', incidentRoute((req) => openWarShell(req.params.id)));
  app.post('/api/incidents/:id/close', incidentRoute((req) => closeIncident(req.params.id, String(req.body?.resolution ?? ''))));

  if (fs.existsSync(DIST)) {
    await app.register(fastifyStatic, { root: DIST });
  } else {
    app.get('/', async () => 'Frontend não compilado. Rode "npm run build" ou use "npm run dev".');
  }

  return app;
}

/** Primeiro andar acima do térreo: destino padrão de salas novas sem andar escolhido. */
function firstFloorId(): string | undefined {
  return [...store.floors.values()].sort((a, b) => a.order - b.order)[0]?.id;
}

/** Só cores no formato #rrggbb: o valor vai direto para o CSS e para o canvas. */
function validColor(c: unknown): string | undefined {
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : undefined;
}
