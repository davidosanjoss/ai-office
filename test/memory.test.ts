// ai-memory: indicador, instalação e remoção pelo servidor real, com Docker e comando
// `ai-memory` falsos e um /healthz que só responde quando o container falso está rodando.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_IMAGE, MEMORY_VERSION, imageVersion, sameImage, windowsSteps } from '../shared/memory.ts';
import { memoryView } from '../web/logic.ts';
import type { MemoryStatus } from '../shared/types.ts';
import { buildApp } from '../server/app.ts';
import { backupDir, defaultDataDir, resetMemoryJob } from '../server/memory.ts';
import { isWindows } from '../server/platform.ts';
import { PORT, WsClient, api, waitFor } from './helpers.ts';

const tmp = process.env.AI_OFFICE_TMP!;
const data = process.env.AI_OFFICE_MEMORY_DATA!;
const bin = process.env.AI_OFFICE_MEMORY_BIN!;
const releaseDir = process.env.AI_OFFICE_MEMORY_RELEASE!;
const claudeJson = process.env.AI_OFFICE_CLAUDE_JSON!;
const settings = path.join(process.env.AI_OFFICE_CLAUDE_DIR!, 'settings.json');

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const dockerCalls = (): string[][] => lines(path.join(tmp, 'docker-calls.jsonl'));
const memoryCalls = (): { args: string[]; image: string; dataDir: string }[] => lines(path.join(tmp, 'ai-memory-calls.jsonl'));
const dockerState = () => {
  const f = path.join(tmp, 'docker-state.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { containers: {} };
};

/** Publica o wrapper falso como se fosse a release, com o checksum (certo ou não). */
function publishWrapper(sha?: string) {
  fs.mkdirSync(releaseDir, { recursive: true });
  const body = fs.readFileSync(path.resolve('test/fixtures/fake-ai-memory.mjs'));
  fs.writeFileSync(path.join(releaseDir, 'ai-memory-wrapper'), body);
  const sum = sha ?? createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(path.join(releaseDir, 'ai-memory-wrapper.sha256'), `${sum}  ai-memory-wrapper\n`);
}

const status = async () => (await api<MemoryStatus>('GET', '/api/memory')).data;
const waitJob = () => waitFor(async () => ((await status()).job?.done ? status() : undefined), 15_000, 'a instalação terminar');

let app: FastifyInstance;
let health: http.Server;
let ws: WsClient;

beforeAll(async () => {
  // /healthz do ai-memory falso: no ar só enquanto o container falso está rodando.
  health = http.createServer((req, res) => {
    res.statusCode = req.url === '/healthz' && dockerState().containers['ai-memory']?.running ? 200 : 503;
    res.end();
  });
  await new Promise<void>((r) => health.listen(0, '127.0.0.1', r));
  process.env.AI_OFFICE_MEMORY_URL = `http://127.0.0.1:${(health.address() as AddressInfo).port}`;
  app = await buildApp({ port: PORT });
  await app.listen({ host: '127.0.0.1', port: PORT });
  ws = await WsClient.connect();
});

afterAll(async () => {
  ws?.close();
  await app?.close();
  health?.close();
});

beforeEach(() => {
  resetMemoryJob();
  delete process.env.FAKE_DOCKER_DOWN;
  process.env.AI_OFFICE_DOCKER_BIN = path.resolve('test/fixtures/fake-docker.mjs');
  for (const f of ['docker-state.json', 'docker-calls.jsonl', 'ai-memory-calls.jsonl']) fs.rmSync(path.join(tmp, f), { force: true });
  for (const p of [data, bin, releaseDir, claudeJson, settings]) fs.rmSync(p, { recursive: true, force: true });
});

describe('pasta padrão do ai-memory', () => {
  it('em cada sistema, fora de qualquer repositório', () => {
    expect(defaultDataDir('linux', {}, '/home/ana')).toBe('/home/ana/.local/share/ai-memory');
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/dados' }, '/home/ana')).toBe('/dados/ai-memory');
    expect(defaultDataDir('darwin', {}, '/Users/ana')).toBe('/Users/ana/Library/Application Support/ai-memory');
    expect(defaultDataDir('win32', { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' }, 'C:\\Users\\ana')).toBe('C:\\Users\\ana\\AppData\\Local\\ai-memory');
  });

  it('o passo a passo do Windows usa a versão fixa, nunca a "latest"', () => {
    const steps = windowsSteps();
    expect(steps).toContain(MEMORY_IMAGE);
    expect(steps).not.toContain('latest');
    expect(steps).toContain('127.0.0.1:49374:49374');
  });
});

describe('versão do servidor', () => {
  it('lê a versão pela tag da imagem, com ou sem o "docker.io/"', () => {
    expect(imageVersion('docker.io/akitaonrails/ai-memory:3.2.8')).toBe('3.2.8');
    expect(imageVersion('akitaonrails/ai-memory:3.4.5')).toBe('3.4.5');
    expect(imageVersion('outra/imagem:1.0')).toBeUndefined();
    expect(sameImage('akitaonrails/ai-memory:3.4.5', 'docker.io/akitaonrails/ai-memory:3.4.5')).toBe(true);
    expect(sameImage('akitaonrails/ai-memory:latest', 'docker.io/akitaonrails/ai-memory:3.4.5')).toBe(false);
    expect(sameImage(undefined, MEMORY_IMAGE)).toBe(false);
  });

  it('backup ao lado da pasta dos dados, sem apagar um de antes', () => {
    const dir = path.join(tmp, 'dados-backup');
    fs.mkdirSync(dir, { recursive: true });
    const when = new Date('2026-11-11T10:00:00Z');
    const first = backupDir(dir, '3.2.8', when);
    expect(first).toBe(`${dir}.antes-3.2.8-2026-11-11`);
    fs.mkdirSync(first);
    expect(backupDir(dir, '3.2.8', when)).toBe(`${first}-2`);
    fs.rmSync(first, { recursive: true });
  });
});

describe('indicador', () => {
  it('sem nada instalado: desligada, e o escritório só lê as configurações do Claude', async () => {
    fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'outro-hook' }] }] } }));
    expect(await status()).toMatchObject({ running: false, hooks: false, mcp: false, dataDir: data, docker: true, autoInstall: !isWindows });
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.Stop[0].hooks[0].command).toBe('outro-hook');
  });

  it('reconhece um ai-memory instalado de outro jeito (hooks e MCP já no Claude)', async () => {
    fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: '/x/ai-memory hook --event stop' }] }] } }));
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'ai-memory': { command: 'ai-memory' } } }));
    expect(await status()).toMatchObject({ hooks: true, mcp: true });
  });
});

describe.skipIf(!isWindows)('Windows', () => {
  it('não instala sozinho: o diálogo mostra o passo a passo', async () => {
    const res = await api('POST', '/api/memory/install');
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/passo a passo/);
  });
});

describe.skipIf(isWindows)('instalar e desinstalar', () => {
  it('instala: imagem fixa, token, servidor só na máquina, wrapper conferido e Claude ligado', async () => {
    publishWrapper();
    const res = await api('POST', '/api/memory/install');
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const st = await waitJob();
    expect(st.job?.error, JSON.stringify(st.job)).toBeUndefined();
    expect(st.job).toMatchObject({ kind: 'instalar', done: true });
    expect(st).toMatchObject({ running: true, hooks: true, mcp: true });

    const calls = dockerCalls();
    expect(calls).toContainEqual(['pull', MEMORY_IMAGE]);
    // init cria o token antes de o servidor subir.
    expect(fs.readFileSync(path.join(data, 'auth-tokens', 'default'), 'utf8')).toBe('token-falso');
    const runD = calls.find((c) => c[0] === 'run' && c.includes('-d'))!;
    expect(runD).toEqual(expect.arrayContaining(['--name', 'ai-memory', '--restart', 'unless-stopped', '-p', '127.0.0.1:49374:49374', '-v', `${data}:/data`, MEMORY_IMAGE]));
    expect(runD).toContain('--user');
    expect(calls.findIndex((c) => c.at(-1) === 'init')).toBeLessThan(calls.indexOf(runD));

    expect(fs.existsSync(bin)).toBe(true);
    expect(memoryCalls().map((c) => c.args[0])).toEqual(['install-mcp', 'install-hooks']);
    expect(memoryCalls().every((c) => c.image === MEMORY_IMAGE && c.dataDir === data)).toBe(true);
    // O progresso chega pelo WebSocket.
    const steps = ws.messages.filter((m) => m.t === 'memory').map((m) => (m as { memory: MemoryStatus }).memory.job?.step);
    expect(steps).toEqual(expect.arrayContaining([expect.stringMatching(/Baixando a imagem/), expect.stringMatching(/Ligando ao Claude Code/)]));
  });

  it('instalar de novo não recria nada: reaproveita token, container e wrapper', async () => {
    publishWrapper();
    await api('POST', '/api/memory/install');
    await waitJob();
    resetMemoryJob();
    fs.rmSync(path.join(tmp, 'docker-calls.jsonl'));
    fs.rmSync(releaseDir, { recursive: true });
    await api('POST', '/api/memory/install');
    const st = await waitJob();
    expect(st.job?.error).toBeUndefined();
    expect(dockerCalls().some((c) => c[0] === 'run')).toBe(false);
  });

  it('container parado é ligado de novo, sem criar outro', async () => {
    publishWrapper();
    await api('POST', '/api/memory/install');
    await waitJob();
    const f = path.join(tmp, 'docker-state.json');
    const st0 = dockerState();
    st0.containers['ai-memory'].running = false;
    fs.writeFileSync(f, JSON.stringify(st0));
    resetMemoryJob();
    await api('POST', '/api/memory/install');
    const st = await waitJob();
    expect(st.job?.error).toBeUndefined();
    expect(dockerCalls()).toContainEqual(['start', 'ai-memory']);
    expect(st.running).toBe(true);
  });

  it('regressão: cada passo da instalação chega pelo WebSocket, mesmo com o estado demorando a montar', async () => {
    publishWrapper();
    // Montar o estado demora (consulta ao Docker lenta): antes, os passos rápidos se perdiam.
    process.env.FAKE_DOCKER_SLOW_INSPECT = '300';
    const before = ws.messages.length;
    await api('POST', '/api/memory/install');
    await waitJob().finally(() => delete process.env.FAKE_DOCKER_SLOW_INSPECT);
    // Os avisos chegam depois do fim do job: espera o último.
    await waitFor(() => ws.messages.slice(before).some((m) => m.t === 'memory' && (m as { memory: MemoryStatus }).memory.job?.done), 5000, 'o aviso final');
    const steps = ws.messages.slice(before).filter((m) => m.t === 'memory').map((m) => (m as { memory: MemoryStatus }).memory.job?.step);
    for (const s of [/Conferindo o Docker/, /Baixando a imagem/, /Preparando a pasta/, /Subindo o servidor/, /Ligando ao Claude Code/]) {
      expect(steps.some((x) => s.test(x ?? '')), `${s} em ${JSON.stringify(steps)}`).toBe(true);
    }
  });

  it('servidor de outra versão: o indicador pede para atualizar, e o Instalar faz backup e troca o container', async () => {
    publishWrapper();
    await api('POST', '/api/memory/install');
    await waitJob();
    // Como se o container tivesse sido criado com a versão anterior.
    const f = path.join(tmp, 'docker-state.json');
    const st0 = dockerState();
    st0.containers['ai-memory'].image = 'docker.io/akitaonrails/ai-memory:3.2.8';
    fs.writeFileSync(f, JSON.stringify(st0));
    fs.writeFileSync(path.join(data, 'db-falso.sqlite'), 'dados de antes');
    const antes = await status();
    expect(antes).toMatchObject({ serverVersion: '3.2.8', outdated: true });
    const view = memoryView(antes);
    expect(view).toMatchObject({ label: 'Memória: atualizar', tone: 'warn', canInstall: true });
    expect(view.problems.join(' ')).toContain('3.2.8');

    resetMemoryJob();
    fs.rmSync(path.join(tmp, 'docker-calls.jsonl'));
    await api('POST', '/api/memory/install');
    const st = await waitJob();
    expect(st.job?.error, JSON.stringify(st.job)).toBeUndefined();
    const calls = dockerCalls();
    // Para o servidor, guarda a cópia, tira o container velho e sobe um com a imagem fixada.
    const iStop = calls.findIndex((c) => c[0] === 'stop');
    const iRm = calls.findIndex((c) => c[0] === 'rm');
    const iRun = calls.findIndex((c) => c[0] === 'run' && c.includes('-d'));
    expect(iStop).toBeGreaterThanOrEqual(0);
    expect(iStop).toBeLessThan(iRm);
    expect(iRm).toBeLessThan(iRun);
    expect(calls[iRun].at(-1)).toBe(MEMORY_IMAGE);
    const backup = fs.readdirSync(path.dirname(data)).find((d) => d.startsWith(`${path.basename(data)}.antes-3.2.8-`));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(path.join(path.dirname(data), backup!, 'db-falso.sqlite'), 'utf8')).toBe('dados de antes');
    expect(st).toMatchObject({ serverVersion: MEMORY_VERSION, outdated: false });
    expect(memoryView(st).label).toBe('Memória: ligada');
    fs.rmSync(path.join(path.dirname(data), backup!), { recursive: true });
  });

  it('o MCP fica fixo na mesma versão do servidor (sem isso o wrapper usa a "latest")', async () => {
    publishWrapper();
    fs.writeFileSync(claudeJson, JSON.stringify({ outraCoisa: { manter: true }, mcpServers: { outro: { command: 'x' } } }));
    await api('POST', '/api/memory/install');
    await waitJob();
    const cfg = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(cfg.mcpServers['ai-memory'].env).toEqual({ AI_MEMORY_IMAGE: MEMORY_IMAGE, AI_MEMORY_DATA_DIR: data });
    expect(cfg.mcpServers.outro).toEqual({ command: 'x' });
    expect(cfg.outraCoisa).toEqual({ manter: true });
  });

  it('checksum errado: não grava o wrapper e não mexe no Claude', async () => {
    publishWrapper('0'.repeat(64));
    await api('POST', '/api/memory/install');
    const st = await waitJob();
    expect(st.job?.error).toMatch(/checksum/);
    expect(fs.existsSync(bin)).toBe(false);
    expect(st).toMatchObject({ hooks: false, mcp: false });
  });

  it('Docker parado ou ausente: erro claro, sem tentar mais nada', async () => {
    process.env.FAKE_DOCKER_DOWN = '1';
    await api('POST', '/api/memory/install');
    expect((await waitJob()).job?.error).toMatch(/O Docker não respondeu/);

    resetMemoryJob();
    process.env.AI_OFFICE_DOCKER_BIN = '';
    expect((await status()).docker).toBe(false);
    await api('POST', '/api/memory/install');
    expect((await waitJob()).job?.error).toMatch(/O Docker não está instalado/);
    expect(memoryCalls()).toEqual([]);
  });

  it('uma instalação por vez', async () => {
    publishWrapper();
    process.env.FAKE_DOCKER_DOWN = '0';
    const first = api('POST', '/api/memory/install');
    const second = await api('POST', '/api/memory/install');
    expect((await first).status).toBe(200);
    expect(second.status).toBe(400);
    expect(second.data.error).toMatch(/em andamento/);
    await waitJob();
  });

  it('desinstalar tira hooks, MCP e container, e os dados ficam na pasta', async () => {
    publishWrapper();
    await api('POST', '/api/memory/install');
    await waitJob();
    resetMemoryJob();
    await api('POST', '/api/memory/uninstall');
    const st = await waitJob();
    expect(st.job?.error).toBeUndefined();
    expect(st.job?.kind).toBe('desinstalar');
    expect(st).toMatchObject({ running: false, hooks: false, mcp: false });
    expect(dockerCalls()).toContainEqual(['rm', '-f', 'ai-memory']);
    expect(fs.existsSync(path.join(data, 'auth-tokens', 'default'))).toBe(true);
  });
});
