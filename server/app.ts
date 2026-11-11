import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
import { FileError, MAX_FILE, listDir, makeDir, readFile, removePath, renamePath, writeFile } from './files.ts';
import { fileDiff, gitInfo } from './git.ts';
import { commitDetail, commitLog, compareRefs, fileAt, fileAtHead, listRefs, treeAt } from './history.ts';
import { handleHook } from './hooks.ts';
import { IncidentError, addParticipants, closeIncident, incidentAt, leaveIncidents, openIncident, openWarShell, sendMessage, shareMessage } from './incidents.ts';
import { MemoryError, memoryEvents, memoryStatus, openDataDir, startInstall, startUninstall } from './memory.ts';
import { pickFolder } from './picker.ts';
import { parseModels } from '../shared/models.ts';
import { type Place, type Price, type UsageRecord, costOf, dayKey, priceFor, summarize, tokensOf } from '../shared/usage.ts';
import { customPrices, prices, receiveRecords, setPrice, usageRecords } from './usage.ts';
import { planUsage, recordPlan } from './plan.ts';
import { startShellWatch } from './live.ts';
import { officeVersion } from './version.ts';
import { cachedSummaries, dayReport, startDayTracking, summarizeWithClaude } from './day.ts';
import { projectDigest } from '../shared/day.ts';
import { PARTY_MS } from '../shared/live.ts';
import { answerRequest, dropRequest, openRequest, pendingRequests, requestEvents, setViewers, waitAnswer } from './permissions.ts';
import type { RequestAnswer } from '../shared/permissions.ts';
import { detectProjects, draftSummary, insideRoot, newProject, projectOf } from './projects.ts';
import { WorktreeError, mergeWorktree, openPr, removeWorktree, worktreeStatus } from './worktree.ts';
import { DATA_DIR, PORT } from './platform.ts';
import { DEFAULT_FLOOR, store } from './store.ts';
import { FLOOR_COLORS, MAX_WAR_ROOMS, autoPlace, canPlace, closeGap, isValidCell } from '../shared/building.ts';
import type { Agent, Floor, FloorDefaults, Room } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Monta o servidor sem abrir porta: o index.ts escuta, e os testes usam inject() ou listen(0). */
export async function buildApp(opts: { port?: number } = {}) {
  const port = opts.port ?? PORT;
  const app = Fastify({ logger: false });

  startShellWatch();
  startDayTracking();
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

  let viewers = 0;
  app.get('/ws', { websocket: true }, (socket) => {
    const send = (msg: ServerMsg) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg));
    const onMsg = (msg: ServerMsg) => send(msg);
    const onMemory = (memory: MemoryStatus) => send({ t: 'memory', memory });
    const onRequests = (requests: ReturnType<typeof pendingRequests>) => send({ t: 'requests', requests });
    store.on('msg', onMsg);
    memoryEvents.on('status', onMemory);
    requestEvents.on('change', onRequests);
    setViewers(++viewers);
    send({ t: 'state', state: store.snapshot() });
    send({ t: 'requests', requests: pendingRequests() });

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
      requestEvents.off('change', onRequests);
      setViewers(--viewers);
    });
  });

  app.post<{ Body: { event: string; agentId?: string; payload: Record<string, unknown> } }>('/api/hook', async (req) => {
    if (req.body && typeof req.body === 'object') handleHook(req.body);
    return { ok: true };
  });

  // ---------- pedidos (permissões e perguntas) respondidos pelo escritório ----------

  /** O hook PermissionRequest registra o pedido. Sem id na resposta, ele segue pelo terminal. */
  app.post<{ Body: { agentId?: string; payload?: Record<string, unknown> } }>('/api/pedidos', async (req) => {
    const r = openRequest(req.body?.agentId, req.body?.payload ?? {});
    return r ? { id: r.id } : {};
  });
  /** Espera longa do hook: a saída para o Claude Code, ou que o pedido sumiu, ou nada ainda. */
  app.get<{ Params: { id: string }; Querystring: { ms?: string } }>('/api/pedidos/:id/espera', async (req) => {
    const ms = Math.max(0, Math.min(25_000, Number(req.query.ms) || 25_000));
    const r = await waitAnswer(req.params.id, ms);
    return r === 'gone' ? { gone: true } : r === 'wait' ? {} : { output: r };
  });
  app.delete<{ Params: { id: string } }>('/api/pedidos/:id', async (req) => {
    dropRequest(req.params.id);
    return { ok: true };
  });
  /** Sua resposta, pelo cartão do escritório. */
  app.post<{ Params: { id: string }; Body: RequestAnswer }>('/api/pedidos/:id/resposta', async (req, reply) => {
    const b = req.body as RequestAnswer | undefined;
    if (!b || (b.behavior !== 'allow' && b.behavior !== 'deny')) return reply.code(400).send({ error: 'Resposta inválida' });
    const answer: RequestAnswer =
      b.behavior === 'allow'
        ? { behavior: 'allow', always: !!b.always, answers: cleanAnswers((b as { answers?: unknown }).answers) }
        : { behavior: 'deny', message: typeof b.message === 'string' ? b.message.slice(0, 2000) : undefined, interrupt: !!b.interrupt };
    if (!answerRequest(req.params.id, answer)) return reply.code(410).send({ error: 'Esse pedido já foi respondido (no terminal ou em outra janela)' });
    return { ok: true };
  });

  // Uso oficial do plano, que a statusline das sessões do escritório manda (rate_limits).
  app.post<{ Body: { rate_limits?: unknown } }>('/api/plano', async (req) => ({ ok: !!recordPlan(req.body?.rate_limits) }));

  app.get('/api/versao', async () => officeVersion());

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

  app.post<{ Body: { name?: string; color?: string; defaults?: FloorDefaults } }>('/api/floors', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'Dê um nome ao andar' });
    const defaults = floorDefaults(req.body?.defaults);
    if (defaults === null) return reply.code(400).send({ error: `As instruções do andar têm até ${MAX_FLOOR_INSTRUCTIONS} caracteres` });
    const floors = [...store.floors.values()];
    const order = floors.reduce((max, f) => Math.max(max, f.order), 0) + 1;
    const color = validColor(req.body?.color) ?? FLOOR_COLORS[floors.length % FLOOR_COLORS.length];
    const floor: Floor = { id: randomUUID().slice(0, 8), name, color, order, createdAt: Date.now(), defaults };
    store.putFloor(floor);
    return floor;
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; color?: string; warRooms?: number; defaults?: FloorDefaults } }>('/api/floors/:id', async (req, reply) => {
    const floor = store.floors.get(req.params.id);
    if (!floor) return reply.code(404).send({ error: 'Andar não encontrado' });
    const name = req.body?.name === undefined ? floor.name : String(req.body.name).trim();
    if (!name) return reply.code(400).send({ error: 'Dê um nome ao andar' });
    const defaults = req.body?.defaults === undefined ? floor.defaults : floorDefaults(req.body.defaults);
    if (defaults === null) return reply.code(400).send({ error: `As instruções do andar têm até ${MAX_FLOOR_INSTRUCTIONS} caracteres` });
    let warRooms = store.warRoomsOf(floor.id);
    if (req.body?.warRooms !== undefined) {
      const n = Number(req.body.warRooms);
      if (!Number.isInteger(n) || n < 1 || n > MAX_WAR_ROOMS) return reply.code(400).send({ error: `Um andar tem de 1 a ${MAX_WAR_ROOMS} salas de guerra` });
      for (let slot = n; slot < warRooms; slot++) {
        if (incidentAt(floor.id, slot)) return reply.code(400).send({ error: 'Encerre o incidente antes de tirar essa sala de guerra' });
      }
      warRooms = n;
    }
    const updated = { ...floor, name, color: validColor(req.body?.color) ?? floor.color, warRooms, defaults };
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
    const rooms = store.planRooms(floorId);
    const wanted = req.body.pos;
    if (wanted !== undefined && !(isValidCell(wanted) && canPlace(rooms, wanted, 'andar', store.warRoomsOf(floorId)))) {
      return reply.code(400).send({ error: 'Essa vaga do andar não está livre' });
    }
    const pos = wanted ? { x: wanted.x, y: wanted.y } : autoPlace(rooms, 'andar', store.warRoomsOf(floorId));
    const room: Room = {
      id: randomUUID().slice(0, 8),
      name: req.body.name?.trim() || path.basename(dir),
      path: dir,
      // A pasta é a raiz do sistema: cada repositório dentro dela vira um projeto da sala.
      projects: detectProjects(dir).map(newProject),
      createdAt: Date.now(),
      floorId,
      pos,
    };
    store.putRoom(room);
    return room;
  });

  /** Renomeia a sala ou muda o resumo do sistema que os agentes dela recebem. */
  app.patch<{ Params: { id: string }; Body: { name?: string; brief?: string } }>('/api/rooms/:id', async (req, reply) => {
    const room = store.rooms.get(req.params.id);
    if (!room) return reply.code(404).send({ error: 'Sala não encontrada' });
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : room.name;
    const brief = typeof req.body?.brief === 'string' ? req.body.brief.trim().slice(0, 4000) : room.brief;
    const updated: Room = { ...room, name, brief: brief || undefined };
    store.putRoom(updated);
    return updated;
  });

  /** Mais um projeto na sala: uma pasta na raiz dela. */
  app.post<{ Params: { id: string }; Body: { path?: string } }>('/api/rooms/:id/projects', async (req, reply) => {
    const room = store.rooms.get(req.params.id);
    if (!room) return reply.code(404).send({ error: 'Sala não encontrada' });
    const raw = String(req.body?.path ?? '').trim();
    const dir = path.resolve(room.path, raw);
    if (!raw || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return reply.code(400).send({ error: 'Pasta não existe' });
    if (!insideRoot(room.path, dir)) return reply.code(400).send({ error: `O projeto precisa ficar dentro da pasta da sala (${room.path})` });
    const projects = room.projects ?? [];
    if (projects.some((p) => p.path === dir)) return reply.code(400).send({ error: 'Esse projeto já está na sala' });
    const updated: Room = { ...room, projects: [...projects, newProject(dir)] };
    store.putRoom(updated);
    return updated;
  });

  /** Edita a ficha de um projeto. `redraft` refaz o rascunho automático e volta a deixá-lo automático. */
  app.patch<{ Params: { id: string; pid: string }; Body: { name?: string; summary?: string; redraft?: boolean; models?: unknown } }>(
    '/api/rooms/:id/projects/:pid',
    async (req, reply) => {
      const room = store.rooms.get(req.params.id);
      const project = room?.projects?.find((p) => p.id === req.params.pid);
      if (!room || !project) return reply.code(404).send({ error: 'Projeto não encontrado' });
      const next = { ...project };
      // Modelos: null ou vazio volta ao padrão da conta; nome estranho é recusado (vira argumento do claude).
      if (req.body && 'models' in req.body) {
        const models = parseModels(req.body.models);
        if (models === null) return reply.code(400).send({ error: 'Modelo inválido: use um alias (ex.: opus) ou o nome completo (ex.: claude-opus-5-5)' });
        if (models) next.models = models;
        else delete next.models;
      }
      if (typeof req.body?.name === 'string' && req.body.name.trim()) next.name = req.body.name.trim();
      if (req.body?.redraft) {
        next.summary = draftSummary(project.path);
        delete next.summaryEdited;
      } else if (typeof req.body?.summary === 'string') {
        next.summary = req.body.summary.trim().slice(0, 2000);
        next.summaryEdited = true;
      }
      const updated: Room = { ...room, projects: room.projects!.map((p) => (p.id === project.id ? next : p)) };
      store.putRoom(updated);
      return updated;
    },
  );

  app.delete<{ Params: { id: string; pid: string } }>('/api/rooms/:id/projects/:pid', async (req, reply) => {
    const room = store.rooms.get(req.params.id);
    const project = room?.projects?.find((p) => p.id === req.params.pid);
    if (!room || !project) return reply.code(404).send({ error: 'Projeto não encontrado' });
    if (room.projects!.length === 1) return reply.code(400).send({ error: 'A sala precisa de pelo menos um projeto' });
    const busy = [...store.agents.values()].filter((a) => a.roomId === room.id && projectOf(room, a.projectId).id === project.id);
    if (busy.length) return reply.code(400).send({ error: `Ainda tem gente trabalhando nele: ${busy.map((a) => a.name).join(', ')}` });
    const updated: Room = { ...room, projects: room.projects!.filter((p) => p.id !== project.id) };
    store.putRoom(updated);
    return updated;
  });

  /** Leva a sala (com os agentes, que continuam trabalhando) para uma vaga livre de outro andar. */
  app.post<{ Params: { id: string }; Body: { floorId: string } }>('/api/rooms/:id/move', async (req, reply) => {
    const room = store.rooms.get(req.params.id);
    if (!room) return reply.code(404).send({ error: 'Sala não encontrada' });
    const floorId = String(req.body?.floorId ?? '');
    if (!store.floors.has(floorId)) return reply.code(400).send({ error: 'Andar não encontrado' });
    if (room.floorId === floorId) return room;
    const fill = gapMoves(room.id);
    const moved = { ...room, floorId, pos: autoPlace(store.planRooms(floorId), 'andar', store.warRoomsOf(floorId)) };
    store.putRoom(moved);
    applyGap(fill);
    return moved;
  });

  app.delete<{ Params: { id: string } }>('/api/rooms/:id', async (req) => {
    const fill = gapMoves(req.params.id);
    for (const a of store.agents.values()) {
      if (a.roomId !== req.params.id) continue;
      leaveIncidents(a.id);
      removeAgent(a.id);
    }
    store.removeRoom(req.params.id);
    applyGap(fill);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id/git', async (req, reply) => {
    const room = store.rooms.get(req.params.id);
    if (!room) return reply.code(404).send({ error: 'Sala não encontrada' });
    return gitInfo(room.path);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/git', async (req, reply) => {
    const dir = projectDir(req.params.id);
    if (!dir) return reply.code(404).send({ error: 'Projeto não encontrado' });
    return gitInfo(dir);
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
      const cwd = folderOf(kind, id);
      if (!cwd) return reply.code(404).send({ error: 'Não encontrado' });
      const scope = req.query.scope === 'branch' ? 'branch' : 'working';
      try {
        return await fileDiff(cwd, String(req.query.path ?? ''), scope);
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  // ---------- explorador de arquivos e histórico, na pasta do agente ou da sala ----------

  /** Acha a pasta (agente ou sala); erros de caminho, conflito ou ref viram a mensagem para você. */
  const folderRoute = (fn: (cwd: string, req: any) => unknown) => async (req: any, reply: any) => {
    const cwd = folderOf(req.params.kind, req.params.id);
    if (!cwd) return reply.code(404).send({ error: 'Não encontrado' });
    try {
      return await fn(cwd, req);
    } catch (err) {
      if (err instanceof FileError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  };
  // O arquivo vai como texto dentro de um JSON: as aspas e as quebras de linha ocupam o dobro.
  const bodyLimit = MAX_FILE * 3;

  app.get('/api/:kind/:id/files/list', folderRoute((cwd, req) => listDir(cwd, req.query.path ?? '')));
  app.get('/api/:kind/:id/files/read', folderRoute((cwd, req) => readFile(cwd, req.query.path)));
  app.get('/api/:kind/:id/files/head', folderRoute((cwd, req) => fileAtHead(cwd, req.query.path)));
  app.put(
    '/api/:kind/:id/files/write',
    { bodyLimit },
    folderRoute((cwd, req) => writeFile(cwd, req.body?.path, req.body?.content, { version: req.body?.version, create: !!req.body?.create })),
  );
  app.post('/api/:kind/:id/files/mkdir', folderRoute((cwd, req) => makeDir(cwd, req.body?.path)));
  app.post('/api/:kind/:id/files/rename', folderRoute((cwd, req) => renamePath(cwd, req.body?.from, req.body?.to)));
  app.post('/api/:kind/:id/files/delete', folderRoute((cwd, req) => removePath(cwd, req.body?.path)));

  app.get('/api/:kind/:id/history/refs', folderRoute((cwd) => listRefs(cwd)));
  app.get('/api/:kind/:id/history/log', folderRoute((cwd, req) => commitLog(cwd, req.query.ref, { skip: req.query.skip, file: req.query.path })));
  app.get('/api/:kind/:id/history/commit', folderRoute((cwd, req) => commitDetail(cwd, req.query.ref)));
  app.get('/api/:kind/:id/history/compare', folderRoute((cwd, req) => compareRefs(cwd, req.query.from, req.query.to)));
  app.get('/api/:kind/:id/history/tree', folderRoute((cwd, req) => treeAt(cwd, req.query.ref, req.query.path ?? '')));
  app.get('/api/:kind/:id/history/show', folderRoute((cwd, req) => fileAt(cwd, req.query.ref, req.query.path)));

  app.post<{ Body: { roomId: string; name?: string; worktree?: boolean; projectId?: string } }>('/api/agents', async (req, reply) => {
    try {
      const projectId = req.body?.projectId ? String(req.body.projectId) : undefined;
      return await createAgent(String(req.body?.roomId), { name: req.body?.name, worktree: !!req.body?.worktree, projectId });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { roomId: string; projectId?: string } }>('/api/shells', async (req, reply) => {
    try {
      return createShell(String(req.body?.roomId), { projectId: req.body?.projectId ? String(req.body.projectId) : undefined });
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

  // ---------- consumo de tokens ----------

  /** Resumo do período (padrão: últimos 7 dias), por sala, projeto, modelo, dia e janela do plano. */
  app.get<{ Querystring: { from?: string; to?: string; ler?: string } }>('/api/uso', async (req) => {
    const now = Date.now();
    const from = Number(req.query.from) || now - 7 * 24 * 3600 * 1000;
    const to = Number(req.query.to) || now + 1;
    // ler=1 (o painel aberto agora): lê o que há de novo mesmo que a última leitura seja recente.
    return summarize(await usageRecords(req.query.ler === '1'), { from, to, now, locate: placeOf, prices: prices(), plan: planUsage() });
  });

  /** Outras fontes (Codex, Gemini, um script seu): um registro ou uma lista no formato UsageRecord. */
  app.post<{ Body: unknown }>('/api/uso', async (req, reply) => {
    const result = receiveRecords(req.body);
    if (!result.accepted) return reply.code(400).send({ error: 'Nenhum registro válido: veja o formato em shared/usage.ts (UsageRecord)', ...result });
    await usageRecords(true);
    return result;
  });

  // ---------- meu dia e relatório ----------

  const validDate = (d: unknown) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : dayKey(Date.now()));
  app.get<{ Querystring: { data?: string } }>('/api/dia', async (req) => {
    const date = validDate(req.query.data);
    const report = await dayReport(date, await usageRecords(), placeOf, prices());
    return { ...report, summaries: cachedSummaries(date) };
  });
  /** Resumo em texto de um projeto no dia, pelo Claude (usa o seu plano: só quando você pede). */
  app.post<{ Body: { data?: string; key?: string } }>('/api/dia/resumo', async (req, reply) => {
    const date = validDate(req.body?.data);
    const report = await dayReport(date, await usageRecords(), placeOf, prices());
    const p = report.projects.find((x) => x.place.key === req.body?.key);
    if (!p) return reply.code(404).send({ error: 'Projeto sem nada nesse dia' });
    if (!p.prompts.length && !p.commits.length && !p.events.length) return reply.code(400).send({ error: 'Não há pedidos nem commits para resumir' });
    try {
      return { text: await summarizeWithClaude(date, p.place.key, projectDigest(p)) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Detalhes de um agente: tokens e custo da sessão dele, modelo, branch e linhas alteradas. */
  app.get<{ Params: { id: string } }>('/api/agents/:id/detalhes', async (req, reply) => {
    const agent = store.agents.get(req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Agente não encontrado' });
    const mine = (await usageRecords()).filter((r) => r.session === agent.sessionId);
    const table = prices();
    let cost = 0;
    const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    for (const r of mine) {
      const t = tokensOf(r);
      tokens.input += t.input;
      tokens.output += t.output;
      tokens.cacheWrite += t.cacheWrite;
      tokens.cacheRead += t.cacheRead;
      const p = priceFor(r.model, table);
      if (p) cost += costOf(r, p);
    }
    const last = mine.reduce<UsageRecord | undefined>((a, r) => (!a || r.ts > a.ts ? r : a), undefined);
    const git = agent.kind === 'shell' ? undefined : await gitInfo(agent.cwd).catch(() => undefined);
    const lines = (git?.files ?? []).reduce((s, f) => ({ add: s.add + (f.additions ?? 0), del: s.del + (f.deletions ?? 0) }), { add: 0, del: 0 });
    return { tokens, cost, model: last?.model, replies: mine.length, branch: git?.branch, files: git?.files?.length ?? 0, linesAdded: lines.add, linesRemoved: lines.del };
  });

  app.get('/api/uso/precos', async () => {
    const seen = [...new Set((await usageRecords()).map((r) => r.model))].sort();
    return { prices: prices(), custom: Object.keys(customPrices()), seen };
  });

  /** Preço de um modelo (USD por milhão de tokens); price null volta ao padrão. */
  app.put<{ Body: { model?: string; price?: Price | null } }>('/api/uso/precos', async (req, reply) => {
    const model = String(req.body?.model ?? '').trim();
    if (!/^[\w.\-[\]:/]{1,100}$/.test(model)) return reply.code(400).send({ error: 'Nome de modelo inválido' });
    const p = req.body?.price;
    if (p === null || p === undefined) {
      setPrice(model, null);
      return { ok: true };
    }
    const keys = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const;
    if (!keys.every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0 && p[k] < 10_000)) {
      return reply.code(400).send({ error: 'Preço inválido: cinco números (USD por milhão de tokens)' });
    }
    setPrice(model, Object.fromEntries(keys.map((k) => [k, p[k]])) as unknown as Price);
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
      const sala = agent && store.rooms.get(agent.roomId);
      if (!agent || !sala) return reply.code(404).send({ error: 'Agente não encontrado' });
      // O worktree sai do repositório do projeto do agente, e é para ele que o trabalho volta.
      const room = { ...sala, path: projectOf(sala, agent.projectId).path };
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
      // O PR aberto pelo escritório também é festa na sala.
      const sala = store.rooms.get(agent.roomId);
      const n = /\/pull\/(\d+)/.exec(pr.url)?.[1];
      if (sala) store.putRoom({ ...sala, effect: { kind: 'festa', text: n ? `PR #${n} aberto!` : 'PR aberto!', until: Date.now() + PARTY_MS } });
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
/**
 * Quem anda para o lugar de uma sala que vai sair do andar (fechada ou levada para outro): as
 * salas de fora dela na mesma fileira, se não têm outra encostada em cima ou embaixo.
 */
function gapMoves(roomId: string): { id: string; pos: { x: number; y: number } }[] {
  const room = store.rooms.get(roomId);
  if (!room?.floorId) return [];
  const plan = store.planRooms(room.floorId);
  const removed = plan.find((r) => r.id === roomId);
  if (!removed) return [];
  return [...closeGap(plan, removed)].map(([r, pos]) => ({ id: r.id, pos }));
}

function applyGap(moves: { id: string; pos: { x: number; y: number } }[]) {
  for (const m of moves) {
    const r = store.rooms.get(m.id);
    if (r) store.putRoom({ ...r, pos: m.pos });
  }
}

/**
 * Onde uma pasta fica no escritório, para o consumo: a do agente (worktree incluso), a de um
 * projeto (ou dentro dele), a raiz de uma sala; senão, fora do escritório.
 */
function placeOf(cwd: string): Place {
  const project = (roomId: string, projectId?: string): Place => {
    const room = store.rooms.get(roomId)!;
    const p = projectId ? room.projects?.find((x) => x.id === projectId) : undefined;
    const multi = (room.projects?.length ?? 0) > 1;
    return {
      key: p ? `p:${p.id}` : `r:${room.id}`,
      label: p && multi ? `${room.name} · ${p.name}` : p ? room.name : `${room.name} (raiz)`,
      roomId: room.id,
      projectId: p?.id,
      floorId: room.floorId,
    };
  };
  if (cwd) {
    const agent = [...store.agents.values()].find((a) => a.cwd === cwd && a.kind !== 'shell');
    const room = agent && store.rooms.get(agent.roomId);
    if (agent && room) return project(room.id, projectOf(room, agent.projectId).id);
    // Worktree de um agente que já saiu: ~/.ai-office/worktrees/<pasta do projeto>/<agente> (também o
    // de outro escritório nesta máquina, como o de testes em ~/.ai-office-teste).
    const rel = path.relative(path.join(DATA_DIR, 'worktrees'), cwd);
    const wt = !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : /[\\/]\.ai-office[^\\/]*[\\/]worktrees[\\/]([^\\/]+)/.exec(cwd)?.[1];
    // Worktree que ainda existe: o .git dele aponta o repositório de verdade (mais certo que o nome da pasta).
    const repo = worktreeRepo(cwd);
    let best: { place: Place; len: number } | undefined;
    for (const r of store.rooms.values()) {
      for (const p of r.projects ?? []) {
        if (repo && path.resolve(p.path) === repo) return project(r.id, p.id);
      }
    }
    for (const r of store.rooms.values()) {
      for (const p of r.projects ?? []) {
        if (!repo && wt && path.basename(p.path) === wt) return project(r.id, p.id);
        if (insideRoot(p.path, cwd) && (!best || p.path.length > best.len)) best = { place: project(r.id, p.id), len: p.path.length };
      }
      if (insideRoot(r.path, cwd) && (!best || r.path.length > best.len)) best = { place: project(r.id), len: r.path.length };
    }
    if (best) return best.place;
  }
  const home = os.homedir();
  return { key: `fora:${cwd}`, label: cwd ? cwd.replace(home, '~') : '(pasta desconhecida)' };
}

/** Repositório principal de um worktree do git (o .git dele é um arquivo "gitdir: <repo>/.git/worktrees/<nome>"). */
function worktreeRepo(cwd: string): string | undefined {
  let d = cwd;
  for (let i = 0; i < 6; i++) {
    const git = path.join(d, '.git');
    // Repositório comum (.git é uma pasta): não é worktree.
    if (fs.existsSync(git) && fs.statSync(git).isDirectory()) return undefined;
    try {
      const m = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/m.exec(fs.readFileSync(git, 'utf8'));
      if (m) return path.resolve(m[1]);
      return undefined;
    } catch {}
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
  return undefined;
}

/** Respostas das perguntas: texto da pergunta → opção (ou texto livre), só strings curtas. */
function cleanAnswers(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string' && k.length < 2000) out[k] = v.slice(0, 4000);
  return out;
}

/** Pasta de um projeto, procurando em todas as salas. */
function projectDir(id: string): string | undefined {
  for (const r of store.rooms.values()) {
    const p = r.projects?.find((x) => x.id === id);
    if (p) return p.path;
  }
  return undefined;
}

/** Pasta das rotas de arquivos, diff e histórico: a do agente (worktree incluso), a de um projeto ou a raiz da sala. */
function folderOf(kind: string, id: string): string | undefined {
  if (kind === 'agents') return store.agents.get(id)?.cwd;
  if (kind === 'projects') return projectDir(id);
  if (kind === 'rooms') return store.rooms.get(id)?.path;
  return undefined;
}

function firstFloorId(): string | undefined {
  return [...store.floors.values()].sort((a, b) => a.order - b.order)[0]?.id;
}

const MAX_FLOOR_INSTRUCTIONS = 4000;

/**
 * Padrões do andar vindos da interface: guarda só o que difere do Claude Code (co-autoria
 * desligada, instruções não vazias). null = instruções longas demais.
 */
function floorDefaults(d: unknown): FloorDefaults | undefined | null {
  if (!d || typeof d !== 'object') return undefined;
  const { coAuthor, instructions } = d as Record<string, unknown>;
  const text = typeof instructions === 'string' ? instructions.trim() : '';
  if (text.length > MAX_FLOOR_INSTRUCTIONS) return null;
  const out: FloorDefaults = {};
  if (coAuthor === false) out.coAuthor = false;
  if (text) out.instructions = text;
  return Object.keys(out).length ? out : undefined;
}

/** Só cores no formato #rrggbb: o valor vai direto para o CSS e para o canvas. */
function validColor(c: unknown): string | undefined {
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : undefined;
}
