// Integração: servidor real (HTTP + WebSocket), processos reais em PTY e o Claude falso,
// com os hooks passando pelo mesmo office-hook.mjs da produção.

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, Floor, Incident, Room } from '../shared/types.ts';
import { killAll } from '../server/agents.ts';
import { buildApp } from '../server/app.ts';
import { store } from '../server/store.ts';
import { BASE, PORT, WsClient, api, makeRepo, tempDir, waitFor } from './helpers.ts';

let app: FastifyInstance;
let ws: WsClient;

beforeAll(async () => {
  app = await buildApp({ port: PORT });
  await app.listen({ host: '127.0.0.1', port: PORT });
  ws = await WsClient.connect();
});

afterAll(async () => {
  ws?.close();
  killAll();
  await app?.close();
});

const agentState = (id: string) => store.agents.get(id);
const waitStatus = (id: string, status: Agent['status'], timeout = 8000) =>
  waitFor(() => agentState(id)?.status === status, timeout, `agente ${id} ficar "${status}" (está "${agentState(id)?.status}")`);
const waitOutput = (id: string, text: string, timeout = 8000) =>
  waitFor(() => ws.out(id).includes(text), timeout, `"${text}" no terminal (saída: ${JSON.stringify(ws.out(id).slice(-300))})`);

async function newRoom(name = 'proj', repo = false): Promise<Room> {
  const dir = repo ? makeRepo(name) : tempDir(name);
  const { status, data } = await api<Room>('POST', '/api/rooms', { path: dir });
  expect(status).toBe(200);
  return data;
}

async function hire(room: Room, body: Record<string, unknown> = {}): Promise<Agent> {
  const { status, data } = await api<Agent>('POST', '/api/agents', { roomId: room.id, ...body });
  expect(status, JSON.stringify(data)).toBe(200);
  ws.send({ t: 'attach', id: data.id });
  return data;
}

describe('segurança', () => {
  it('recusa Host de outro domínio (DNS rebinding)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'evil.com' } });
    expect(res.statusCode).toBe(403);
  });

  it('recusa requisição vinda de outro site (CSRF)', async () => {
    const res = await api('POST', '/api/rooms', { path: '/' }, { origin: 'http://evil.com' });
    expect(res.status).toBe(403);
  });

  it('aceita a própria origem', async () => {
    const res = await api('GET', '/api/projects', undefined, { origin: `http://localhost:${PORT}` });
    expect(res.status).toBe(200);
  });

  it('serve a interface compilada', async () => {
    const res = await fetch(`${BASE}/`);
    expect(await res.text()).toContain('<title>AI Office</title>');
  });
});

describe('salas', () => {
  it('pasta inexistente dá erro', async () => {
    expect((await api('POST', '/api/rooms', { path: '/nao/existe/xyz' })).status).toBe(400);
  });

  it('a mesma pasta não vira duas salas', async () => {
    const dir = tempDir('dup');
    const a = await api<Room>('POST', '/api/rooms', { path: dir });
    const b = await api<Room>('POST', '/api/rooms', { path: dir, name: 'outro nome' });
    expect(b.data.id).toBe(a.data.id);
  });

  it('nome padrão é o nome da pasta; dá para escolher outro', async () => {
    const dir = tempDir('meu-app');
    expect((await api<Room>('POST', '/api/rooms', { path: dir })).data.name).toBe(path.basename(dir));
    const dir2 = tempDir('x');
    expect((await api<Room>('POST', '/api/rooms', { path: dir2, name: '  Loja  ' })).data.name).toBe('Loja');
  });

  it('fechar a sala encerra os agentes dela', async () => {
    const room = await newRoom('fechar');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    await api('DELETE', `/api/rooms/${room.id}`);
    expect(store.rooms.has(room.id)).toBe(false);
    expect(agentState(a.id)).toBeUndefined();
  });

  it('diff de arquivo alterado, e 404 para o que não mudou', async () => {
    const room = await newRoom('diff-api', true);
    fs.writeFileSync(path.join(room.path, 'README.md'), 'mudou\n');
    const ok = await api(`GET`, `/api/rooms/${room.id}/diff?scope=working&path=README.md`);
    expect(ok.status).toBe(200);
    expect(ok.data.diff).toContain('+mudou');
    const nope = await api('GET', `/api/rooms/${room.id}/diff?scope=working&path=package.json`);
    expect(nope.status).toBe(404);
    expect((await api('GET', `/api/coisas/${room.id}/diff?path=README.md`)).status).toBe(404);
  });

  it('git da sala', async () => {
    const room = await newRoom('git', true);
    const { data } = await api(`GET`, `/api/rooms/${room.id}/git`);
    expect(data).toMatchObject({ isRepo: true, branch: 'main' });
    expect((await api('GET', '/api/rooms/nada/git')).status).toBe(404);
  });
});

describe('ciclo de vida de um agente', () => {
  it('abre o Claude com os hooks do escritório, e o SessionStart chega pelo script real', async () => {
    const room = await newRoom('vida');
    const a = await hire(room);
    expect(a.status).toBe('starting');
    await waitOutput(a.id, 'FAKE CLAUDE mode=new');
    // A saída chega em pedaços (no Windows, bem picada): espera a linha, não confere na hora.
    await waitOutput(a.id, 'hooks=yes');
    await waitStatus(a.id, 'idle');
    expect(store.activity.some((e) => e.agentId === a.id && e.text.includes('entrou na sala'))).toBe(true);
  });

  it('um pedido passa por trabalhando → terminou, com a atividade registrada', async () => {
    const room = await newRoom('pedido');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    ws.type(a.id, 'prompt arruma o login\r');
    await waitStatus(a.id, 'done');
    expect(agentState(a.id)!.attentionAt).toBeGreaterThan(0);
    const texts = store.activity.filter((e) => e.agentId === a.id).map((e) => e.text);
    expect(texts).toEqual(expect.arrayContaining(['Pedido: arruma o login', 'Lendo README.md', 'Terminou o pedido']));
    await waitOutput(a.id, 'feito: arruma o login');
  });

  it('marcar como visto tira da fila', async () => {
    const room = await newRoom('visto');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    ws.type(a.id, 'prompt x\r');
    await waitStatus(a.id, 'done');
    ws.send({ t: 'seen', id: a.id });
    await waitStatus(a.id, 'idle');
    expect(agentState(a.id)!.attentionAt).toBeUndefined();
  });

  it('pedido de permissão levanta a mão', async () => {
    const room = await newRoom('perm');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    ws.type(a.id, 'ask\r');
    await waitStatus(a.id, 'waiting');
  });

  it('attach devolve o histórico do terminal', async () => {
    const room = await newRoom('replay');
    const a = await hire(room);
    await waitOutput(a.id, 'FAKE CLAUDE');
    ws.output.delete(a.id);
    ws.send({ t: 'attach', id: a.id });
    await waitOutput(a.id, 'FAKE CLAUDE mode=new');
  });

  it('regressão: o agente não herda os marcadores da sessão do Claude que iniciou o servidor', async () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    try {
      const room = await newRoom('env');
      const a = await hire(room);
      await waitOutput(a.id, 'child=none');
    } finally {
      delete process.env.CLAUDE_CODE_CHILD_SESSION;
    }
  });

  it('demitir encerra o processo e tira o agente', async () => {
    const room = await newRoom('demitir');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    await api('DELETE', `/api/agents/${a.id}`);
    expect(agentState(a.id)).toBeUndefined();
    await waitFor(() => ws.messages.some((m) => m.t === 'agentRemoved' && m.id === a.id));
  });

  it('a conversa aparece nas sugestões de projetos', async () => {
    const room = await newRoom('sugestao');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    ws.type(a.id, 'prompt oi\r');
    await waitStatus(a.id, 'done');
    const { data } = await api<{ path: string }[]>('GET', '/api/projects');
    expect(data.map((p) => p.path)).toContain(room.path);
  });
});

describe('retomar conversa', () => {
  it('com conversa salva: retoma com --resume', async () => {
    const room = await newRoom('retomar');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    ws.type(a.id, 'prompt lembra disso\r');
    await waitStatus(a.id, 'done');
    ws.type(a.id, '/exit\r');
    await waitStatus(a.id, 'exited');
    expect(agentState(a.id)!.exitCode).toBe(0);

    await api('POST', `/api/agents/${a.id}/resume`);
    await waitOutput(a.id, 'FAKE CLAUDE mode=resume');
    await waitStatus(a.id, 'idle');
  });

  it('regressão: sessão fechada sem nenhuma mensagem não fica presa em "fora do escritório"', async () => {
    const room = await newRoom('sem-conversa');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    ws.type(a.id, '/exit\r');
    await waitStatus(a.id, 'exited');

    await api('POST', `/api/agents/${a.id}/resume`);
    // Antes: `claude --resume` saía com "No conversation found" e o agente voltava a "exited".
    await waitStatus(a.id, 'idle');
    await waitFor(() => ws.out(a.id).split('FAKE CLAUDE mode=new').length - 1 === 2, 8000, 'as duas sessões novas na saída');
    expect(ws.out(a.id)).not.toContain('No conversation found');
    expect(store.activity.some((e) => e.agentId === a.id && e.text.includes('começando uma nova'))).toBe(true);
  });

  it('regressão: a saída de quem encerrou continua no terminal (para você ver o erro)', async () => {
    const room = await newRoom('saida');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    ws.type(a.id, '/exit\r');
    await waitStatus(a.id, 'exited');
    ws.output.delete(a.id);
    ws.send({ t: 'attach', id: a.id });
    await waitOutput(a.id, 'tchau');
  });

  it('regressão: quando o Claude falha ao abrir, o motivo aparece na atividade', async () => {
    const room = await newRoom('falha');
    process.env.FAKE_CLAUDE_FAIL = 'Erro: conta não logada';
    let a: Agent;
    try {
      a = await hire(room);
      await waitStatus(a.id, 'exited');
    } finally {
      delete process.env.FAKE_CLAUDE_FAIL;
    }
    expect(agentState(a.id)!.activity).toBe('Não conseguiu abrir: Erro: conta não logada');
    expect(store.activity.some((e) => e.agentId === a.id && e.text.includes('conta não logada'))).toBe(true);
  });

  it('retomar quem ainda está rodando não abre um segundo processo', async () => {
    const room = await newRoom('duplo');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    await api('POST', `/api/agents/${a.id}/resume`);
    await new Promise((r) => setTimeout(r, 500));
    expect(ws.out(a.id).split('FAKE CLAUDE').length - 1).toBe(1);
  });
});

describe('worktree', () => {
  it('agente num worktree trabalha numa branch própria', async () => {
    const room = await newRoom('wt', true);
    const a = await hire(room, { name: 'Júlia', worktree: true });
    expect(a.worktreeBranch).toMatch(/^office\/julia-/);
    expect(a.cwd).not.toBe(room.path);
    expect(fs.existsSync(path.join(a.cwd, 'README.md'))).toBe(true);
    const { data } = await api('GET', `/api/agents/${a.id}/git`);
    expect(data.branch).toBe(a.worktreeBranch);
  });

  it('pedir worktree numa pasta sem git dá erro claro', async () => {
    const room = await newRoom('wt-sem-git');
    const res = await api('POST', '/api/agents', { roomId: room.id, worktree: true });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/worktree/);
  });
});

describe('terminal comum', () => {
  it('abre o shell na pasta da sala, sem hooks do escritório', async () => {
    const room = await newRoom('shell');
    const { data: sh } = await api<Agent>('POST', '/api/shells', { roomId: room.id });
    expect(sh).toMatchObject({ kind: 'shell', name: 'Terminal 1', status: 'idle' });
    ws.send({ t: 'attach', id: sh.id });
    ws.type(sh.id, process.platform === 'win32' ? 'cd\r' : 'pwd; echo "url=${AI_OFFICE_URL:-nenhuma}"\r');
    await waitOutput(sh.id, path.basename(room.path));
    if (process.platform !== 'win32') await waitOutput(sh.id, 'url=nenhuma');
    const { data: sh2 } = await api<Agent>('POST', '/api/shells', { roomId: room.id });
    expect(sh2.name).toBe('Terminal 2');
  });

  it.skipIf(process.platform === 'win32')('avisa se tem programa rodando antes de fechar', async () => {
    const room = await newRoom('busy');
    const { data: sh } = await api<Agent>('POST', '/api/shells', { roomId: room.id });
    await waitFor(async () => (await api('GET', `/api/agents/${sh.id}/busy`)).data.busy === false);
    ws.type(sh.id, 'sleep 3\r');
    await waitFor(async () => (await api('GET', `/api/agents/${sh.id}/busy`)).data.busy === true, 3000, 'busy=true');
  });

  it('regressão: `exit` fecha a aba', async () => {
    const room = await newRoom('exit');
    const { data: sh } = await api<Agent>('POST', '/api/shells', { roomId: room.id });
    ws.type(sh.id, 'exit\r');
    await waitFor(() => ws.messages.some((m) => m.t === 'agentRemoved' && m.id === sh.id), 5000, 'aba fechar');
    expect(agentState(sh.id)).toBeUndefined();
  });
});

describe('andares', () => {
  const novoAndar = async (name: string, color?: string) => {
    const { status, data } = await api<Floor>('POST', '/api/floors', { name, color });
    expect(status).toBe(200);
    return data;
  };

  it('o prédio já começa com um andar, para a primeira sala ter onde ficar', () => {
    expect(store.floors.size).toBeGreaterThanOrEqual(1);
  });

  it('cria, renomeia e troca a cor de um andar; nome é obrigatório e cor inválida é ignorada', async () => {
    const f = await novoAndar('Freelance', '#9ece6a');
    expect(f).toMatchObject({ name: 'Freelance', color: '#9ece6a' });
    expect(f.order).toBe(Math.max(...[...store.floors.values()].map((x) => x.order)));
    const { data } = await api<Floor>('PATCH', `/api/floors/${f.id}`, { name: 'Freela', color: 'red; background:url(x)' });
    expect(data).toMatchObject({ name: 'Freela', color: '#9ece6a' });
    expect((await api('POST', '/api/floors', { name: '  ' })).status).toBe(400);
  });

  it('cada andar tem a própria planta: a mesma vaga pode ter uma sala em cada andar', async () => {
    const a = await novoAndar('Empresa');
    const b = await novoAndar('Pessoal');
    const r1 = await api<Room>('POST', '/api/rooms', { path: tempDir('p1'), floorId: a.id, pos: { x: -1, y: 0 } });
    const r2 = await api<Room>('POST', '/api/rooms', { path: tempDir('p2'), floorId: b.id, pos: { x: -1, y: 0 } });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.data).toMatchObject({ floorId: b.id, pos: { x: -1, y: 0 } });
    // No mesmo andar, a vaga já está ocupada.
    expect((await api('POST', '/api/rooms', { path: tempDir('p3'), floorId: a.id, pos: { x: -1, y: 0 } })).status).toBe(400);
  });

  it('sala em andar que não existe dá erro', async () => {
    expect((await api('POST', '/api/rooms', { path: tempDir('x'), floorId: 'nao-existe' })).status).toBe(400);
  });

  it('mover sala de andar leva junto os agentes, que continuam trabalhando', async () => {
    const de = await novoAndar('Origem');
    const para = await novoAndar('Destino');
    const { data: room } = await api<Room>('POST', '/api/rooms', { path: tempDir('mover'), floorId: de.id });
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    const { status, data: moved } = await api<Room>('POST', `/api/rooms/${room.id}/move`, { floorId: para.id });
    expect(status).toBe(200);
    expect(moved.floorId).toBe(para.id);
    expect(moved.pos).toBeDefined();
    expect(agentState(a.id)!.status).toBe('idle');
    expect((await api('POST', `/api/rooms/${room.id}/move`, { floorId: 'nao-existe' })).status).toBe(400);
  });

  it('só apaga andar vazio', async () => {
    const f = await novoAndar('Temporário');
    const { data: room } = await api<Room>('POST', '/api/rooms', { path: tempDir('tmp'), floorId: f.id });
    const cheio = await api('DELETE', `/api/floors/${f.id}`);
    expect(cheio.status).toBe(400);
    expect(cheio.data.error).toMatch(/mova ou feche/);
    await api('DELETE', `/api/rooms/${room.id}`);
    expect((await api('DELETE', `/api/floors/${f.id}`)).status).toBe(200);
    expect(store.floors.has(f.id)).toBe(false);
  });
});

describe('sala de guerra', () => {
  let floor: Floor;
  let gateway: Room;
  let filas: Room;
  let bruno: Agent;
  let incident: Incident;
  /** O agente criado para o incidente, na sala do gateway. */
  let novo: Agent;

  const inc = () => store.incidents.get(incident.id)!;
  const replies = (agentId: string) => inc().messages.filter((m) => m.kind === 'agente' && m.agentId === agentId);
  const waitReplies = (agentId: string, n: number) =>
    waitFor(() => replies(agentId).length >= n, 10_000, `${n} resposta(s) de ${agentId} no chat (tem ${replies(agentId).length})`);

  beforeAll(async () => {
    floor = (await api<Floor>('POST', '/api/floors', { name: 'Incidentes' })).data;
    gateway = (await api<Room>('POST', '/api/rooms', { path: tempDir('gateway'), name: 'gateway', floorId: floor.id })).data;
    filas = (await api<Room>('POST', '/api/rooms', { path: tempDir('filas'), name: 'filas', floorId: floor.id })).data;
    bruno = await hire(filas, { name: 'Bruno' });
    await waitStatus(bruno.id, 'idle');
  });

  it('a planta reserva a coluna do elevador: sala de projeto não vai para lá', async () => {
    expect((await api('POST', '/api/rooms', { path: tempDir('x'), floorId: floor.id, pos: { x: 0, y: 1 } })).status).toBe(400);
    expect(gateway.pos!.x).not.toBe(0);
  });

  it('abre o incidente: um agente novo no projeto escolhido e um que já trabalhava, cada um com o convite', async () => {
    const { status, data } = await api<Incident>('POST', '/api/incidents', {
      floorId: floor.id,
      slot: 0,
      title: '503 na API',
      description: 'Pedidos falhando desde 10h',
      roomIds: [gateway.id],
      agentIds: [bruno.id],
    });
    expect(status, JSON.stringify(data)).toBe(200);
    incident = data;
    expect(incident.participants).toHaveLength(2);
    novo = store.agents.get(incident.participants[0])!;
    ws.send({ t: 'attach', id: novo.id });
    expect(novo).toMatchObject({ roomId: gateway.id, incidentId: incident.id, forIncident: true });
    expect(store.agents.get(bruno.id)).toMatchObject({ incidentId: incident.id });
    expect(store.agents.get(bruno.id)?.forIncident).toBeUndefined();

    // O convite é digitado no terminal de cada um; as respostas vão para o chat da sala.
    await waitOutput(bruno.id, '[Sala de guerra] Você é Bruno (projeto filas)');
    await waitOutput(novo.id, `Você é ${novo.name} (projeto gateway)`);
    await waitReplies(bruno.id, 1);
    await waitReplies(novo.id, 1);
    expect(replies(bruno.id)[0].text).toContain('feito: [Sala de guerra] Você é Bruno');

    // O registro tem o briefing e a linha do tempo.
    const md = fs.readFileSync(incident.file, 'utf8');
    expect(path.dirname(incident.file)).toBe(path.join(process.env.AI_OFFICE_DATA!, 'incidentes'));
    expect(md).toContain('# Incidente: 503 na API');
    expect(md).toContain('Pedidos falhando desde 10h');
    expect(md).toContain('Modo investigação');
    expect(md).toContain('feito: [Sala de guerra]');
  });

  it('não abre um segundo incidente na mesma sala, nem chama quem já está numa', async () => {
    const again = await api('POST', '/api/incidents', { floorId: floor.id, slot: 0, title: 'outro', roomIds: [filas.id] });
    expect(again.status).toBe(400);
    expect((await api('PATCH', `/api/floors/${floor.id}`, { warRooms: 2 })).status).toBe(200);
    const busy = await api<{ error: string }>('POST', '/api/incidents', { floorId: floor.id, slot: 1, title: 'outro', agentIds: [bruno.id] });
    expect(busy.status).toBe(400);
    expect(busy.data.error).toContain('Bruno já está numa sala de guerra');
    // Sala de guerra que não existe, ninguém chamado, título vazio, projeto de outro andar.
    expect((await api('POST', '/api/incidents', { floorId: floor.id, slot: 5, title: 'x', roomIds: [filas.id] })).status).toBe(400);
    expect((await api('POST', '/api/incidents', { floorId: floor.id, slot: 1, title: 'x' })).status).toBe(400);
    expect((await api('POST', '/api/incidents', { floorId: floor.id, slot: 1, title: ' ', roomIds: [filas.id] })).status).toBe(400);
    const outro = (await api<Room>('POST', '/api/rooms', { path: tempDir('fora') })).data;
    expect((await api('POST', '/api/incidents', { floorId: floor.id, slot: 1, title: 'x', roomIds: [outro.id] })).status).toBe(400);
    // Só sobe até o limite, nunca abaixo de 1; a segunda (vazia) pode ser tirada.
    expect((await api('PATCH', `/api/floors/${floor.id}`, { warRooms: 0 })).status).toBe(400);
    expect((await api('PATCH', `/api/floors/${floor.id}`, { warRooms: 99 })).status).toBe(400);
    expect((await api<Floor>('PATCH', `/api/floors/${floor.id}`, { warRooms: 1 })).data.warRooms).toBe(1);
  });

  it('a sala de guerra com incidente aberto não pode ser tirada do andar', async () => {
    await api('PATCH', `/api/floors/${floor.id}`, { warRooms: 2 });
    const second = await api<Incident>('POST', '/api/incidents', { floorId: floor.id, slot: 1, title: 'lentidão', roomIds: [filas.id] });
    expect(second.status).toBe(200);
    const blocked = await api<{ error: string }>('PATCH', `/api/floors/${floor.id}`, { warRooms: 1 });
    expect(blocked.status).toBe(400);
    expect(blocked.data.error).toContain('Encerre o incidente');
    expect((await api('POST', `/api/incidents/${second.data.id}/close`, {})).status).toBe(200);
    expect((await api<Floor>('PATCH', `/api/floors/${floor.id}`, { warRooms: 1 })).data.warRooms).toBe(1);
  });

  it('@projeto manda só para aquele projeto; @ de quem não está na sala é recusado', async () => {
    const { status } = await api('POST', `/api/incidents/${incident.id}/messages`, { text: '@filas a fila encheu?' });
    expect(status).toBe(200);
    await waitOutput(bruno.id, 'Mensagem do usuário só para você: @filas a fila encheu?');
    await waitReplies(bruno.id, 2);
    expect(ws.out(novo.id)).not.toContain('a fila encheu?');
    expect(inc().messages.find((m) => m.kind === 'voce')?.to).toEqual([bruno.id]);

    const unknown = await api<{ error: string }>('POST', `/api/incidents/${incident.id}/messages`, { text: '@carlos olha isso' });
    expect(unknown.status).toBe(400);
    expect(unknown.data.error).toContain('@carlos');
  });

  it('repassar a resposta de um agente leva o texto para os outros, e só quando você pede', async () => {
    const reply = replies(bruno.id).at(-1)!;
    const before = replies(novo.id).length;
    const { status } = await api('POST', `/api/incidents/${incident.id}/messages/${reply.id}/share`);
    expect(status).toBe(200);
    await waitOutput(novo.id, '[Sala de guerra] Bruno (projeto filas) disse: feito:');
    await waitReplies(novo.id, before + 1);
    // A resposta de quem recebeu o repasse não volta sozinha para o Bruno.
    await new Promise((r) => setTimeout(r, 600));
    expect(ws.out(bruno.id)).not.toContain(`${novo.name} (projeto gateway) disse`);
    // Mensagem sua não é "resposta de agente": não dá para repassar.
    const mine = inc().messages.find((m) => m.kind === 'voce')!;
    expect((await api('POST', `/api/incidents/${incident.id}/messages/${mine.id}/share`)).status).toBe(400);
  });

  it('mensagens seguidas esperam o agente terminar a anterior, e todas chegam na ordem', async () => {
    const before = replies(bruno.id).length;
    await api('POST', `/api/incidents/${incident.id}/messages`, { text: 'primeira pergunta' });
    await api('POST', `/api/incidents/${incident.id}/messages`, { text: 'segunda pergunta' });
    await waitReplies(bruno.id, before + 2);
    const out = ws.out(bruno.id);
    expect(out.indexOf('segunda pergunta')).toBeGreaterThan(out.indexOf('primeira pergunta'));
    expect(replies(bruno.id).slice(-2).map((m) => m.text)).toEqual([
      expect.stringContaining('primeira pergunta'),
      expect.stringContaining('segunda pergunta'),
    ]);
  });

  it('a resposta vem do campo do hook quando o Claude manda; transcript fora do ~/.claude é ignorado', async () => {
    const n = inc().messages.length;
    await api('POST', '/api/hook', { event: 'Stop', agentId: bruno.id, payload: { transcript_path: '/etc/passwd' } });
    expect(inc().messages.length).toBe(n);
    await api('POST', '/api/hook', { event: 'Stop', agentId: bruno.id, payload: { last_assistant_message: 'Achei: timeout de 5s' } });
    expect(inc().messages.at(-1)).toMatchObject({ kind: 'agente', agentId: bruno.id, text: 'Achei: timeout de 5s' });
  });

  it('chamar mais gente, e quem é demitido sai da sala', async () => {
    const extra = await hire(filas, { name: 'Carla' });
    await waitStatus(extra.id, 'idle');
    expect((await api('POST', `/api/incidents/${incident.id}/participants`, { agentIds: [extra.id] })).status).toBe(200);
    expect(inc().participants).toContain(extra.id);
    await waitOutput(extra.id, '[Sala de guerra] Você é Carla');
    await api('DELETE', `/api/agents/${extra.id}`);
    expect(inc().participants).not.toContain(extra.id);
    expect(inc().messages.at(-1)?.text).toBe('Carla saiu da sala');
  });

  it('encerrar: o registro vira post-mortem, o agente do incidente vai embora e o outro volta para a mesa', async () => {
    const { status } = await api('POST', `/api/incidents/${incident.id}/close`, { resolution: 'Aumentamos os consumidores' });
    expect(status).toBe(200);
    expect(store.incidents.has(incident.id)).toBe(false);
    expect(store.agents.has(novo.id)).toBe(false);
    expect(store.agents.get(bruno.id)?.incidentId).toBeUndefined();
    const md = fs.readFileSync(incident.file, 'utf8');
    expect(md).toContain('## Post-mortem');
    expect(md).toContain('Aumentamos os consumidores');
    expect(ws.messages.some((m) => m.t === 'incidentRemoved' && m.id === incident.id)).toBe(true);
    // Depois de encerrado, nada mais vai para o chat.
    expect((await api('POST', `/api/incidents/${incident.id}/messages`, { text: 'oi' })).status).toBe(400);
  });
});
