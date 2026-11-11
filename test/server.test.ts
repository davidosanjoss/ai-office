// Integração: servidor real (HTTP + WebSocket), processos reais em PTY e o Claude falso,
// com os hooks passando pelo mesmo office-hook.mjs da produção.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, Floor, Incident, Room, WorktreeStatus } from '../shared/types.ts';
import type { UsageSummary } from '../shared/usage.ts';
import { killAll } from '../server/agents.ts';
import { buildApp } from '../server/app.ts';
import { store } from '../server/store.ts';
import { setViewers } from '../server/permissions.ts';
import { BASE, PORT, WsClient, api, makeRepo, tempDir, transcriptLine, waitFor } from './helpers.ts';

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

describe('explorador de arquivos e histórico', () => {
  it('lê e salva na pasta da sala, recusando caminho para fora e versão velha', async () => {
    const room = await newRoom('explorador', true);
    const base = `/api/rooms/${room.id}`;
    expect((await api('GET', `${base}/files/list`)).data.entries).toEqual([{ name: 'README.md', kind: 'file' }]);
    const read = await api('GET', `${base}/files/read?path=README.md`);
    expect(read.data.content).toBe('# teste\n');

    const saved = await api('PUT', `${base}/files/write`, { path: 'README.md', content: 'editado\n', version: read.data.version });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(path.join(room.path, 'README.md'), 'utf8')).toBe('editado\n');
    const stale = await api('PUT', `${base}/files/write`, { path: 'README.md', content: 'x', version: read.data.version });
    expect(stale.status).toBe(409);
    expect(stale.data.error).toMatch(/mudou no disco/);

    expect((await api('GET', `${base}/files/read?path=../fora.txt`)).status).toBe(400);
    expect((await api('GET', `${base}/files/read?path=.git/config`)).status).toBe(400);
    expect((await api('GET', `/api/coisas/${room.id}/files/list`)).status).toBe(404);
    expect((await api('POST', `${base}/files/mkdir`, { path: 'src' })).status).toBe(200);
    expect((await api('POST', `${base}/files/rename`, { from: 'src', to: 'lib' })).status).toBe(200);
    expect((await api('POST', `${base}/files/delete`, { path: 'lib' })).status).toBe(200);
    expect(fs.readdirSync(room.path).sort()).toEqual(['.git', 'README.md']);
  });

  it('salva arquivo maior que o limite padrão do Fastify (1 MB)', async () => {
    const room = await newRoom('explorador-grande');
    const content = 'linha "com aspas"\n'.repeat(80_000);
    const res = await api('PUT', `/api/rooms/${room.id}/files/write`, { path: 'grande.txt', content, create: true });
    expect(res.status).toBe(200);
    expect(fs.statSync(path.join(room.path, 'grande.txt')).size).toBe(Buffer.byteLength(content));
  });

  it('salvar de outro site é bloqueado', async () => {
    const room = await newRoom('explorador-origem');
    const res = await api('PUT', `/api/rooms/${room.id}/files/write`, { path: 'x.txt', content: 'x', create: true }, { origin: 'http://malicioso.example' });
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(room.path, 'x.txt'))).toBe(false);
  });

  it('branches, commits, commit e arquivo numa ref', async () => {
    const room = await newRoom('historico', true);
    const base = `/api/rooms/${room.id}/history`;
    const refs = await api('GET', `${base}/refs`);
    expect(refs.data).toEqual([expect.objectContaining({ name: 'main', kind: 'branch', current: true })]);
    const log = await api('GET', `${base}/log?ref=main`);
    expect(log.data.commits[0].subject).toBe('primeiro commit');
    const commit = await api('GET', `${base}/commit?ref=${log.data.commits[0].hash}`);
    expect(commit.data.files.map((f: { path: string }) => f.path)).toEqual(['README.md']);
    expect((await api('GET', `${base}/show?ref=main&path=README.md`)).data.content).toBe('# teste\n');
    expect((await api('GET', `${base}/compare?from=main&to=main`)).data).toMatchObject({ ahead: 0, behind: 0, files: [] });
    expect((await api('GET', `${base}/log?ref=--all`)).status).toBe(400);
    expect((await api('GET', `${base}/log?ref=nada`)).status).toBe(404);
    const semGit = await newRoom('historico-sem-git');
    expect((await api('GET', `/api/rooms/${semGit.id}/history/refs`)).status).toBe(400);
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

describe('worktree: PR, trazer para a sala e encerrar', () => {
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();
  const commit = (dir: string, file: string, text: string, msg: string) => {
    fs.writeFileSync(path.join(dir, file), text);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', msg);
  };
  // O git do Windows (core.autocrlf) grava os arquivos que chegam pelo merge com \r\n.
  const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const status = async (a: Agent) => (await api<WorktreeStatus>('GET', `/api/agents/${a.id}/worktree`)).data;
  const ghCalls = () => {
    const file = path.join(process.env.AI_OFFICE_TMP!, 'gh-calls.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  async function setup(name: string, withOrigin = false) {
    const room = await newRoom(name, true);
    if (withOrigin) {
      const bare = tempDir(`${name}-origin`);
      git(bare, 'init', '-q', '--bare', '-b', 'main');
      git(room.path, 'remote', 'add', 'origin', bare);
      git(room.path, 'push', '-q', 'origin', 'main');
    }
    const a = await hire(room, { worktree: true });
    await waitStatus(a.id, 'idle');
    return { room, a };
  }

  it('mostra quantos commits o worktree tem a mais e sugere o PR a partir deles', async () => {
    const { a } = await setup('wt-status');
    commit(a.cwd, 'login.ts', 'x\n', 'Tela de login');
    commit(a.cwd, 'logout.ts', 'y\n', 'Botão de sair');
    fs.writeFileSync(path.join(a.cwd, 'rascunho.txt'), 'oi');
    expect(await status(a)).toMatchObject({
      branch: a.worktreeBranch,
      target: 'main',
      ahead: 2,
      behind: 0,
      dirty: 1,
      conflicts: [],
      remote: false,
      pushed: false,
      suggestion: { title: 'Tela de login', body: 'Commits:\n\n- Tela de login\n- Botão de sair' },
    });
  });

  it('traz o trabalho para a branch da sala', async () => {
    const { room, a } = await setup('wt-merge');
    commit(a.cwd, 'novo.ts', 'oi\n', 'Arquivo novo');
    const res = await api('POST', `/api/agents/${a.id}/worktree/merge`);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data).toEqual({ target: 'main' });
    expect(read(path.join(room.path, 'novo.ts'))).toBe('oi\n');
    expect((await status(a)).ahead).toBe(0);
    // Sem nada novo, não há o que trazer.
    expect((await api('POST', `/api/agents/${a.id}/worktree/merge`)).data.error).toMatch(/Nada para trazer/);
  });

  it('com conflito previsto, avisa os arquivos e não mexe na sala', async () => {
    const { room, a } = await setup('wt-conflito');
    commit(a.cwd, 'README.md', 'versão do agente\n', 'Agente mudou o README');
    commit(room.path, 'README.md', 'versão da main\n', 'Main mudou o README');
    const head = git(room.path, 'rev-parse', 'HEAD');
    expect((await status(a)).conflicts).toEqual(['README.md']);
    const res = await api('POST', `/api/agents/${a.id}/worktree/merge`);
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/conflito em: README\.md/);
    expect(git(room.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(room.path, 'status', '--porcelain')).toBe('');
  });

  it('abre o PR: sobe a branch e chama o gh com a base certa', async () => {
    const { room, a } = await setup('wt-pr', true);
    commit(a.cwd, 'api.ts', 'x\n', 'Nova rota');
    const before = ghCalls().length;
    const res = await api('POST', `/api/agents/${a.id}/worktree/pr`, { title: 'Nova rota', body: 'Descrição' });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.url).toBe('https://github.com/teste/repo/pull/7');
    const call = ghCalls()[before];
    expect(call.args).toEqual(['pr', 'create', '--head', a.worktreeBranch, '--title', 'Nova rota', '--body', 'Descrição', '--base', 'main']);
    expect(git(room.path, 'ls-remote', '--heads', 'origin', a.worktreeBranch!)).toContain(a.worktreeBranch);
    expect(agentState(a.id)?.worktreePr).toBe(res.data.url);
    expect(await status(a)).toMatchObject({ pushed: true, pr: res.data.url });

    // Com o PR aberto, o botão só sobe os commits novos.
    commit(a.cwd, 'api.ts', 'y\n', 'Ajuste');
    const again = await api('POST', `/api/agents/${a.id}/worktree/pr`, {});
    expect(again.data.url).toBe(res.data.url);
    expect(ghCalls().length).toBe(before + 1);
    expect((await status(a)).pushed).toBe(true);
  });

  it('PR que já existia: devolve o endereço dele', async () => {
    const { a } = await setup('wt-pr-existe', true);
    commit(a.cwd, 'a.ts', 'x\n', 'algo');
    const res = await api('POST', `/api/agents/${a.id}/worktree/pr`, { title: 'JA-EXISTE', body: '' });
    expect(res.data.url).toBe('https://github.com/teste/repo/pull/3');
  });

  it('erros claros: sem origin e gh sem login', async () => {
    const { a } = await setup('wt-pr-sem-origin');
    expect((await api('POST', `/api/agents/${a.id}/worktree/pr`, { title: 't' })).data.error).toMatch(/origin/);
    const { a: b } = await setup('wt-pr-sem-login', true);
    const res = await api('POST', `/api/agents/${b.id}/worktree/pr`, { title: 'SEM-LOGIN' });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/A branch subiu, mas o PR não foi aberto.*gh auth login/);
  });

  it('agente sem worktree não tem essas ações', async () => {
    const room = await newRoom('wt-nenhum', true);
    const a = await hire(room);
    expect((await api('GET', `/api/agents/${a.id}/worktree`)).status).toBe(400);
  });

  it('encerrar: recusa com arquivo não commitado e não apaga branch com trabalho que só existe nela', async () => {
    const { room, a } = await setup('wt-encerrar-recusa');
    fs.writeFileSync(path.join(a.cwd, 'rascunho.txt'), 'oi');
    let res = await api('POST', `/api/agents/${a.id}/worktree/remove`, {});
    expect(res.data.error).toMatch(/não commitado/);
    git(a.cwd, 'add', '.');
    git(a.cwd, 'commit', '-q', '-m', 'rascunho');
    res = await api('POST', `/api/agents/${a.id}/worktree/remove`, { deleteBranch: true });
    expect(res.data.error).toMatch(/não foi apagada/);
    // Nada foi tocado: o agente continua trabalhando, com a pasta e a branch.
    expect(agentState(a.id)?.status).not.toBe('exited');
    expect(fs.existsSync(a.cwd)).toBe(true);
    expect(git(room.path, 'branch', '--list', a.worktreeBranch!)).toContain(a.worktreeBranch);
  });

  it('encerrar: o agente sai, a pasta some e a branch fica, a não ser que você peça', async () => {
    const { room, a } = await setup('wt-encerrar');
    commit(a.cwd, 'x.ts', 'x\n', 'trabalho');
    const res = await api('POST', `/api/agents/${a.id}/worktree/remove`, {});
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(store.agents.has(a.id)).toBe(false);
    expect(fs.existsSync(a.cwd)).toBe(false);
    expect(git(room.path, 'branch', '--list', a.worktreeBranch!)).toContain(a.worktreeBranch);

    // Trabalho já trazido para a sala: a branch pode ir junto.
    const b = await hire(room, { worktree: true });
    await waitStatus(b.id, 'idle');
    commit(b.cwd, 'y.ts', 'y\n', 'mais trabalho');
    await api('POST', `/api/agents/${b.id}/worktree/merge`);
    expect((await api('POST', `/api/agents/${b.id}/worktree/remove`, { deleteBranch: true })).status).toBe(200);
    expect(git(room.path, 'branch', '--list', b.worktreeBranch!)).toBe('');
    expect(read(path.join(room.path, 'y.ts'))).toBe('y\n');
  });
});

describe('sala com vários projetos', () => {
  /** Raiz com dois repositórios e um documento solto, como ~/ampm/saff. */
  function sistema() {
    const root = tempDir('saff');
    for (const name of ['ms-arquivos', 'ms-sales']) fs.renameSync(makeRepo(name), path.join(root, name));
    fs.writeFileSync(path.join(root, 'ms-sales', 'README.md'), '# sales\n\nMonta as vendas a partir dos arquivos validados.\n');
    fs.writeFileSync(path.join(root, 'plano.md'), '# plano\n');
    return root;
  }

  it('a sala é a raiz: cada repositório dentro dela vira um projeto, com o rascunho da ficha', async () => {
    const root = sistema();
    const { data: room } = await api<Room>('POST', '/api/rooms', { path: root });
    expect(room.path).toBe(root);
    expect(room.projects!.map((p) => p.name)).toEqual(['ms-arquivos', 'ms-sales']);
    expect(room.projects![1].summary).toBe('Monta as vendas a partir dos arquivos validados.');
  });

  it('o agente trabalha na pasta do projeto escolhido e recebe a raiz e o contexto da sala', async () => {
    const root = sistema();
    const { data: room } = await api<Room>('POST', '/api/rooms', { path: root });
    await api('PATCH', `/api/rooms/${room.id}`, { brief: 'arquivos depois sales' });
    const sales = room.projects![1];
    const a = await hire(room, { projectId: sales.id });
    expect(a).toMatchObject({ projectId: sales.id, cwd: sales.path });
    await waitOutput(a.id, `add-dir=${root}`);
    await waitOutput(a.id, 'Você trabalha no projeto **ms-sales**');
    await waitOutput(a.id, 'arquivos depois sales');
    await waitOutput(a.id, '- plano.md');
    await waitStatus(a.id, 'idle');
    // O quadro de quem está fazendo o quê acompanha os agentes da sala.
    const now = path.join(process.env.AI_OFFICE_DATA!, 'salas', room.id, 'agora.md');
    await waitFor(() => fs.existsSync(now) && fs.readFileSync(now, 'utf8').includes(`**${a.name}** (ms-sales)`), 4000, 'quadro da sala');
  });

  it('o worktree sai do repositório do projeto do agente', async () => {
    const root = sistema();
    const { data: room } = await api<Room>('POST', '/api/rooms', { path: root });
    const arquivos = room.projects![0];
    const a = await hire(room, { projectId: arquivos.id, worktree: true });
    // O worktree compartilha o .git do projeto. Compara as pastas de verdade: no Windows o git escreve o
    // caminho com "/" e o nome longo, e a pasta temporária vem com barra invertida e o nome curto (RUNNER~1).
    const common = execFileSync('git', ['-C', a.cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
    expect(fs.realpathSync.native(path.resolve(a.cwd, common))).toBe(fs.realpathSync.native(path.join(arquivos.path, '.git')));
    const { data: st } = await api<WorktreeStatus>('GET', `/api/agents/${a.id}/worktree`);
    expect(st).toMatchObject({ branch: a.worktreeBranch, target: 'main' });
    const { data: git } = await api<{ isRepo: boolean; branch: string }>('GET', `/api/projects/${arquivos.id}/git`);
    expect(git).toMatchObject({ isRepo: true, branch: 'main' });
  });

  it('adiciona, edita e tira projetos, só de dentro da raiz e sem ninguém trabalhando neles', async () => {
    const root = sistema();
    const { data: room } = await api<Room>('POST', '/api/rooms', { path: root });
    fs.renameSync(makeRepo('ms-motor'), path.join(root, 'ms-motor'));
    const fora = await api('POST', `/api/rooms/${room.id}/projects`, { path: tempDir('fora') });
    expect(fora.status).toBe(400);
    const { data: com3 } = await api<Room>('POST', `/api/rooms/${room.id}/projects`, { path: 'ms-motor' });
    const motor = com3.projects!.find((p) => p.name === 'ms-motor')!;
    expect(motor.path).toBe(path.join(root, 'ms-motor'));
    expect((await api('POST', `/api/rooms/${room.id}/projects`, { path: 'ms-motor' })).status).toBe(400);

    const { data: editada } = await api<Room>('PATCH', `/api/rooms/${room.id}/projects/${motor.id}`, { summary: 'Calcula o faturamento.' });
    expect(editada.projects!.find((p) => p.id === motor.id)).toMatchObject({ summary: 'Calcula o faturamento.', summaryEdited: true });
    const { data: refeita } = await api<Room>('PATCH', `/api/rooms/${room.id}/projects/${motor.id}`, { redraft: true });
    expect(refeita.projects!.find((p) => p.id === motor.id)?.summaryEdited).toBeUndefined();

    const a = await hire(room, { projectId: motor.id });
    const ocupado = await api<{ error: string }>('DELETE', `/api/rooms/${room.id}/projects/${motor.id}`);
    expect(ocupado.status).toBe(400);
    expect(ocupado.data.error).toContain(a.name);
    await api('DELETE', `/api/agents/${a.id}`);
    const { data: sem } = await api<Room>('DELETE', `/api/rooms/${room.id}/projects/${motor.id}`);
    expect(sem.projects!.map((p) => p.name)).toEqual(['ms-arquivos', 'ms-sales']);
  });

  it('modelos por projeto: o agente abre com eles, e quem retoma pega a escolha nova', async () => {
    const root = sistema();
    const { data: room } = await api<Room>('POST', '/api/rooms', { path: root });
    const sales = room.projects![1];
    const ruim = await api('PATCH', `/api/rooms/${room.id}/projects/${sales.id}`, { models: { mode: 'unico', model: 'opus; rm -rf ~' } });
    expect(ruim.status).toBe(400);
    await api('PATCH', `/api/rooms/${room.id}/projects/${sales.id}`, { models: { mode: 'duplo', reasoning: 'claude-opus-5-5', execution: 'claude-haiku-5-5' } });
    const a = await hire(room, { projectId: sales.id });
    await waitOutput(a.id, 'modelo=opusplan opus=claude-opus-5-5 sonnet=claude-haiku-5-5');
    await waitStatus(a.id, 'idle');
    expect(store.agents.get(a.id)!.models).toBe('claude-opus-5-5 → claude-haiku-5-5');
    // O outro projeto da sala continua no padrão da conta.
    const b = await hire(room, { projectId: room.projects![0].id });
    await waitStatus(b.id, 'idle');
    expect(ws.out(b.id)).not.toContain('modelo=');

    // Trocou para um modelo só: quem retoma já abre com ele.
    const { data: depois } = await api<Room>('PATCH', `/api/rooms/${room.id}/projects/${sales.id}`, { models: { mode: 'unico', model: 'sonnet' } });
    expect(depois.projects![1].models).toEqual({ mode: 'unico', model: 'sonnet' });
    ws.type(a.id, '/exit\r');
    await waitStatus(a.id, 'exited');
    await api('POST', `/api/agents/${a.id}/resume`);
    await waitOutput(a.id, 'modelo=sonnet opus=- sonnet=-');
    await waitFor(() => store.agents.get(a.id)?.models === 'sonnet', 4000, 'modelos do agente');
    // Voltar ao padrão da conta tira a escolha do projeto.
    const { data: padrao } = await api<Room>('PATCH', `/api/rooms/${room.id}/projects/${sales.id}`, { models: null });
    expect(padrao.projects![1].models).toBeUndefined();
  });

  it('consumo: cada resposta vai para a sala e o projeto da pasta, inclusive a de um worktree', async () => {
    const root = sistema();
    const { data: room } = await api<Room>('POST', '/api/rooms', { path: root, name: 'SAFF Uso' });
    const [arquivos, sales] = room.projects!;
    const a = await hire(room, { projectId: sales.id, worktree: true });
    const now = Date.now();
    const at = (min: number) => new Date(now - min * 60_000).toISOString();
    // Worktree de outro escritório na mesma máquina (o de testes): o .git dele aponta o repositório.
    const outro = path.join(tempDir('casa'), '.ai-office-teste', 'worktrees', 'ms-sales', 'ana-1');
    fs.mkdirSync(path.join(outro, 'src'), { recursive: true });
    fs.writeFileSync(path.join(outro, '.git'), `gitdir: ${path.join(sales.path, '.git', 'worktrees', 'ana-1')}\n`);
    const dir = path.join(process.env.AI_OFFICE_CLAUDE_DIR!, 'projects', `-uso-${now}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'uso.jsonl'),
      [
        transcriptLine({ id: `u1-${now}`, ts: at(30), cwd: arquivos.path, output: 1000 }),
        transcriptLine({ id: `u2-${now}`, ts: at(20), cwd: a.cwd, output: 500 }),
        transcriptLine({ id: `u3-${now}`, ts: at(10), cwd: path.join(sales.path, 'src'), output: 250 }),
        transcriptLine({ id: `u4-${now}`, ts: at(5), cwd: root, output: 1 }),
        // Worktree de outro escritório na mesma máquina (o de testes).
        transcriptLine({ id: `u5-${now}`, ts: at(4), cwd: path.join(outro, 'src'), output: 2 }),
      ].join('\n') + '\n',
    );
    const { data: uso } = await api<UsageSummary>('GET', `/api/uso?from=${now - 3600_000}`);
    const out = (label: string) => uso.places.find((p) => p.place.label === label)?.tokens.output;
    expect(out('SAFF Uso · ms-sales')).toBe(752);
    expect(out('SAFF Uso · ms-arquivos')).toBe(1000);
    expect(out('SAFF Uso (raiz)')).toBe(1);
    expect(uso.window!.places.find((p) => p.place.projectId === sales.id)?.tokens.output).toBe(752);
    expect(uso.totals.cost).toBeGreaterThan(0);

    // Outra fonte pela rota, e o preço dela.
    expect((await api('POST', '/api/uso', { source: 'x' })).status).toBe(400);
    await api('POST', '/api/uso', [{ source: 'gemini', id: `g-${now}`, ts: now - 60_000, cwd: sales.path, model: 'gemini-3-pro', input: 1_000_000 }]);
    await api('PUT', '/api/uso/precos', { model: 'gemini-3-pro', price: { input: 2, output: 12, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.2 } });
    expect((await api('PUT', '/api/uso/precos', { model: 'gemini-3-pro', price: { input: -1 } })).status).toBe(400);
    const { data: depois } = await api<UsageSummary>('GET', `/api/uso?from=${now - 3600_000}`);
    const gem = depois.byModel.find((m) => m.model === 'gemini-3-pro')!;
    expect(gem).toMatchObject({ source: 'gemini', cost: 2 });
    expect(depois.places.find((p) => p.place.projectId === sales.id)!.bySource.gemini).toBe(1_000_000);
    const { data: precos } = await api<{ custom: string[]; seen: string[] }>('GET', '/api/uso/precos');
    expect(precos.custom).toContain('gemini-3-pro');
    expect(precos.seen).toContain('claude-opus-5-5');
  });

  it('uso oficial do plano: a statusline da sessão entrega os rate_limits, e a sua statusline continua aparecendo', async () => {
    const resets = Math.floor(Date.now() / 1000) + 3600;
    process.env.FAKE_RATE_LIMITS = JSON.stringify({ five_hour: { used_percentage: 37.2, resets_at: resets }, seven_day: { used_percentage: 12, resets_at: resets + 86400 } });
    // Uma statusline sua: ela é que aparece na sessão, com o mesmo JSON.
    const settings = path.join(process.env.AI_OFFICE_CLAUDE_DIR!, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo minha-statusline' } }));
    try {
      const room = await newRoom('plano');
      const a = await hire(room);
      await waitStatus(a.id, 'idle');
      ws.type(a.id, 'prompt oi\r');
      await waitOutput(a.id, 'statusline=minha-statusline');
      const plan = await waitFor(async () => (await api<UsageSummary>('GET', '/api/uso')).data.plan, 5000, 'o plano chegar');
      expect(plan.fiveHour).toEqual({ usedPct: 37.2, resetsAt: resets * 1000 });
      expect(plan.sevenDay?.usedPct).toBe(12);
      // Sem statusline sua, a linha mostra o plano.
      fs.writeFileSync(settings, '{}');
      const b = await hire(room);
      await waitStatus(b.id, 'idle');
      ws.type(b.id, 'prompt oi\r');
      await waitOutput(b.id, 'statusline=plano: 5h 37% · semana 12%');
    } finally {
      delete process.env.FAKE_RATE_LIMITS;
      fs.rmSync(settings, { force: true });
    }
  });

  it('pedidos pelo escritório: permitir sem perguntar de novo, negar com motivo, responder pergunta e devolver ao terminal', async () => {
    const room = await newRoom('pedidos');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    // A lista de pedidos chega pelo WebSocket (a última mensagem 'requests' é a atual).
    const pending = () => ws.messages.filter((m) => m.t === 'requests').at(-1) as { requests: { id: string; agentId: string; kind: string }[] } | undefined;
    const next = (kind: string) => waitFor(() => pending()?.requests.find((r) => r.agentId === a.id && r.kind === kind), 5000, `pedido ${kind}`);

    ws.type(a.id, 'pedir\r');
    let req = await next('permission');
    await waitStatus(a.id, 'waiting');
    await api('POST', `/api/pedidos/${req.id}/resposta`, { behavior: 'allow', always: true });
    await waitOutput(a.id, 'decisao={"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm test"}]');
    // Responder de novo o mesmo pedido: já foi.
    expect((await api('POST', `/api/pedidos/${req.id}/resposta`, { behavior: 'allow' })).status).toBe(410);

    ws.type(a.id, 'pedir\r');
    req = await next('permission');
    await api('POST', `/api/pedidos/${req.id}/resposta`, { behavior: 'deny', message: 'use o pnpm', interrupt: true });
    await waitOutput(a.id, 'decisao={"behavior":"deny","message":"use o pnpm","interrupt":true}');

    ws.type(a.id, 'perguntar\r');
    req = await next('question');
    await api('POST', `/api/pedidos/${req.id}/resposta`, { behavior: 'allow', answers: { 'Qual banco?': 'SQLite' } });
    await waitOutput(a.id, '"answers":{"Qual banco?":"SQLite"}');

    // "Responder no terminal": o pedido sai do escritório e o hook devolve a vez ao terminal.
    ws.type(a.id, 'pedir\r');
    req = await next('permission');
    await api('DELETE', `/api/pedidos/${req.id}`);
    await waitOutput(a.id, 'decisao=terminal');

    // Sem nenhuma página do escritório aberta, o hook nem espera: segue pelo terminal na hora.
    setViewers(0);
    try {
      const antes = ws.out(a.id).split('decisao=terminal').length;
      ws.type(a.id, 'pedir\r');
      await waitFor(() => ws.out(a.id).split('decisao=terminal').length > antes, 4000, 'o pedido ir direto para o terminal');
    } finally {
      setViewers(1);
    }
  });

  it('sala viva: comando em segundo plano até acabar, e PR, CI vermelho e CI verde na sala', async () => {
    const room = await newRoom('viva');
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    ws.type(a.id, 'fundo bg1\r');
    await waitFor(() => store.agents.get(a.id)?.shells?.some((s) => s.id === 'bg1'), 4000, 'o comando em segundo plano');
    expect(store.agents.get(a.id)!.shells![0].command).toBe('Roda os testes');
    ws.type(a.id, 'fundo-fim bg1 1\r');
    await waitFor(() => store.agents.get(a.id)?.effect?.kind === 'falhou', 6000, 'o fim do comando');
    expect(store.agents.get(a.id)!.shells).toEqual([]);
    expect(store.agents.get(a.id)!.effect!.text).toBe('Roda os testes: falhou (código 1)');

    ws.type(a.id, 'gh pr\r');
    await waitFor(() => store.rooms.get(room.id)?.effect?.text === 'PR #12 aberto!', 4000, 'a festa do PR');
    expect(store.rooms.get(room.id)!.effect!.kind).toBe('festa');
    ws.type(a.id, 'gh ci-falhou\r');
    await waitFor(() => store.rooms.get(room.id)?.effect?.kind === 'alarme', 4000, 'o alarme do CI');
    ws.type(a.id, 'gh ci-ok\r');
    await waitFor(() => store.rooms.get(room.id)?.effect?.text === 'CI verde!', 4000, 'o CI verde');
    expect(store.rooms.get(room.id)!.effect!.kind).toBe('festa');
  });

  it('meu dia, relatório com resumo do Claude e detalhes do agente', async () => {
    const room = await newRoom('meudia', true);
    const a = await hire(room);
    await waitStatus(a.id, 'idle');
    ws.type(a.id, 'prompt fazer o relatório\r');
    await waitStatus(a.id, 'done');
    // O Claude falso trabalha num instante (menos de 1 s não conta); o "terminou, sem você ver" vai contando.
    await new Promise((r) => setTimeout(r, 1200));
    const { data: dia } = await api<{ projects: { place: { key: string; roomId?: string }; doneMs: number; prompts: { text: string }[]; commits: unknown[] }[] }>('GET', '/api/dia');
    const p = dia.projects.find((x) => x.place.roomId === room.id)!;
    expect(p.prompts.map((x) => x.text)).toContain('fazer o relatório');
    expect(p.doneMs).toBeGreaterThan(1000);
    const { data: resumo } = await api<{ text: string }>('POST', '/api/dia/resumo', { key: p.place.key });
    expect(resumo.text).toMatch(/^RESUMO de .* \(modelo haiku\): \d+ itens\.$/);
    // Fica guardado: o painel mostra sem pedir de novo.
    const { data: denovo } = await api<{ summaries: Record<string, string> }>('GET', '/api/dia');
    expect(denovo.summaries[p.place.key]).toBe(resumo.text);

    const { data: det } = await api<{ branch: string; files: number; replies: number }>('GET', `/api/agents/${a.id}/detalhes`);
    expect(det).toMatchObject({ branch: 'main', replies: 0 });
  });

  it('recusa projeto que não é da sala', async () => {
    const { data: room } = await api<Room>('POST', '/api/rooms', { path: sistema() });
    const { status } = await api('POST', '/api/agents', { roomId: room.id, projectId: 'outro' });
    expect(status).toBe(400);
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
    const r1 = await api<Room>('POST', '/api/rooms', { path: tempDir('p1'), floorId: a.id, pos: { x: -1, y: 1 } });
    const r2 = await api<Room>('POST', '/api/rooms', { path: tempDir('p2'), floorId: b.id, pos: { x: -1, y: 1 } });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.data).toMatchObject({ floorId: b.id, pos: { x: -1, y: 1 } });
    // No mesmo andar, a vaga já está ocupada.
    expect((await api('POST', '/api/rooms', { path: tempDir('p3'), floorId: a.id, pos: { x: -1, y: 1 } })).status).toBe(400);
  });

  it('fechar ou mudar de andar uma sala traz as da mesma fileira para o lugar dela', async () => {
    const andar = await novoAndar('Fileira junta');
    const sala = async (name: string, x: number, y: number) =>
      (await api<Room>('POST', '/api/rooms', { path: tempDir(name), floorId: andar.id, pos: { x, y } })).data;
    const a = await sala('a', 1, 1);
    const b = await sala('b', 2, 1);
    const c = await sala('c', 3, 1);
    const presa = await sala('presa', 4, 1);
    await sala('em-cima', 4, 2);
    await api('DELETE', `/api/rooms/${a.id}`);
    expect(store.rooms.get(b.id)!.pos).toEqual({ x: 1, y: 1 });
    expect(store.rooms.get(c.id)!.pos).toEqual({ x: 2, y: 1 });
    // Tem sala encostada em cima: fica onde está.
    expect(store.rooms.get(presa.id)!.pos).toEqual({ x: 4, y: 1 });
    const outro = await novoAndar('Outro andar');
    await api('POST', `/api/rooms/${b.id}/move`, { floorId: outro.id });
    expect(store.rooms.get(c.id)!.pos).toEqual({ x: 1, y: 1 });
  });

  it('a primeira fileira do andar é só do elevador e da copa', async () => {
    const andar = await novoAndar('Fileira');
    expect((await api('POST', '/api/rooms', { path: tempDir('baixo'), floorId: andar.id, pos: { x: 2, y: 0 } })).status).toBe(400);
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

  it('padrões do andar: guarda só o que muda, mantém ao renomear e limpa com {}', async () => {
    const { data: f } = await api<Floor>('POST', '/api/floors', { name: 'Cliente', defaults: { coAuthor: false, instructions: '  Commits resumidos  ' } });
    expect(f.defaults).toEqual({ coAuthor: false, instructions: 'Commits resumidos' });
    expect((await api<Floor>('PATCH', `/api/floors/${f.id}`, { name: 'Cliente X' })).data.defaults).toEqual(f.defaults);
    // Co-autoria ligada e texto vazio são o padrão do Claude Code: nada a guardar.
    expect((await api<Floor>('PATCH', `/api/floors/${f.id}`, { defaults: { coAuthor: true, instructions: ' ' } })).data.defaults).toBeUndefined();
    const longo = await api('PATCH', `/api/floors/${f.id}`, { defaults: { instructions: 'x'.repeat(4001) } });
    expect(longo.status).toBe(400);
    expect((await novoAndar('Sem padrões')).defaults).toBeUndefined();
  });

  it('cada andar abre os agentes com os próprios padrões, e retomar pega os padrões novos', async () => {
    const { data: cliente } = await api<Floor>('POST', '/api/floors', {
      name: 'AMPM',
      defaults: { coAuthor: false, instructions: 'Commits resumidos\nSem corpo' },
    });
    const pessoal = await novoAndar('Pessoal 2');
    const { data: salaCliente } = await api<Room>('POST', '/api/rooms', { path: tempDir('cliente'), floorId: cliente.id });
    const { data: salaPessoal } = await api<Room>('POST', '/api/rooms', { path: tempDir('pessoal'), floorId: pessoal.id });

    const a = await hire(salaCliente);
    await waitOutput(a.id, 'coautoria=nao');
    await waitOutput(a.id, 'instrucoes=Commits resumidos | Sem corpo');
    await waitOutput(a.id, 'hooks=yes');
    await waitStatus(a.id, 'idle');

    const b = await hire(salaPessoal);
    await waitOutput(b.id, 'coautoria=sim');
    await waitStatus(b.id, 'idle');
    // Sem instruções no andar, o prompt acrescentado é só o contexto da sala.
    expect(ws.out(b.id)).toContain('instrucoes=# Sala ');
    expect(ws.out(b.id)).not.toContain('Commits resumidos');

    // Mudou os padrões do Pessoal: quem volta ao trabalho já abre com eles.
    await api('PATCH', `/api/floors/${pessoal.id}`, { defaults: { coAuthor: false } });
    ws.type(b.id, 'prompt oi\r');
    await waitStatus(b.id, 'done');
    ws.type(b.id, '/exit\r');
    await waitStatus(b.id, 'exited');
    await api('POST', `/api/agents/${b.id}/resume`);
    await waitOutput(b.id, 'FAKE CLAUDE mode=resume');
    await waitOutput(b.id, 'coautoria=nao');
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

  it('abre um terminal comum da sala de guerra, na pasta do primeiro projeto, fora do chat', async () => {
    const shells = [...store.agents.values()].filter((a) => a.kind === 'shell' && a.incidentId === incident.id);
    expect(shells).toHaveLength(1);
    expect(shells[0]).toMatchObject({ name: 'Terminal 1', roomId: gateway.id, cwd: gateway.path, forIncident: true });
    expect(inc().participants).not.toContain(shells[0].id);
    // Dá para abrir mais; a numeração é da sala de guerra, não da sala do projeto.
    const { data: second } = await api<Agent>('POST', `/api/incidents/${incident.id}/shells`);
    expect(second).toMatchObject({ kind: 'shell', name: 'Terminal 2', incidentId: incident.id });
    const { data: roomShell } = await api<Agent>('POST', '/api/shells', { roomId: gateway.id });
    expect(roomShell.name).toBe('Terminal 1');
    expect(roomShell.incidentId).toBeUndefined();
    await api('DELETE', `/api/agents/${roomShell.id}`);
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
    const beforeNovo = replies(novo.id).length;
    await api('POST', `/api/incidents/${incident.id}/messages`, { text: 'primeira pergunta' });
    await api('POST', `/api/incidents/${incident.id}/messages`, { text: 'segunda pergunta' });
    await waitReplies(bruno.id, before + 2);
    // As perguntas foram para todos: espera o outro agente também, senão a resposta dele
    // chega durante o próximo teste (aconteceu no CI do Windows).
    await waitReplies(novo.id, beforeNovo + 2);
    const out = ws.out(bruno.id);
    expect(out.indexOf('segunda pergunta')).toBeGreaterThan(out.indexOf('primeira pergunta'));
    expect(replies(bruno.id).slice(-2).map((m) => m.text)).toEqual([
      expect.stringContaining('primeira pergunta'),
      expect.stringContaining('segunda pergunta'),
    ]);
  });

  it('a resposta vem do campo do hook quando o Claude manda; transcript fora do ~/.claude é ignorado', async () => {
    const n = replies(bruno.id).length;
    await api('POST', '/api/hook', { event: 'Stop', agentId: bruno.id, payload: { transcript_path: '/etc/passwd' } });
    // Conta só as respostas do Bruno: outro agente da sala pode responder no meio.
    expect(replies(bruno.id).length).toBe(n);
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
    // Os terminais da sala de guerra fecham junto.
    expect([...store.agents.values()].some((a) => a.incidentId === incident.id)).toBe(false);
    const md = fs.readFileSync(incident.file, 'utf8');
    expect(md).toContain('## Post-mortem');
    expect(md).toContain('Aumentamos os consumidores');
    expect(ws.messages.some((m) => m.t === 'incidentRemoved' && m.id === incident.id)).toBe(true);
    // Depois de encerrado, nada mais vai para o chat.
    expect((await api('POST', `/api/incidents/${incident.id}/messages`, { text: 'oi' })).status).toBe(400);
  });
});
