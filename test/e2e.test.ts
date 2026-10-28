// Ponta a ponta: a interface compilada num Chrome/Chromium/Edge headless, clicando e digitando
// como você faria, com o servidor real e o Claude falso. Pula se não houver navegador
// (defina CHROME_PATH para escolher um).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Agent } from '../shared/types.ts';
import { killAll } from '../server/agents.ts';
import { buildApp } from '../server/app.ts';
import { which } from '../server/platform.ts';
import { store } from '../server/store.ts';
import { cellRect } from '../web/office.ts';
import { BASE, PORT, api, makeRepo, tempDir, waitFor } from './helpers.ts';

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'brave-browser', 'brave']) {
    const bin = which(name);
    if (bin) return bin;
  }
  const fixed = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return fixed.find((p) => fs.existsSync(p));
}

const chrome = findChrome();

describe.skipIf(!chrome)('interface (navegador headless)', () => {
  let app: FastifyInstance;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    app = await buildApp({ port: PORT });
    await app.listen({ host: '127.0.0.1', port: PORT });
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--window-size=1400,900'] });
    page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
  });

  afterAll(async () => {
    await browser?.close();
    killAll();
    await app?.close();
  });

  const agents = () => [...store.agents.values()];
  const byName = (name: string) => agents().find((a) => a.name === name);
  const status = (id: string) => store.agents.get(id)?.status;
  const waitStatus = (id: string, s: Agent['status'], timeout = 8000) =>
    waitFor(() => status(id) === s, timeout, `agente ficar "${s}" (está "${status(id)}")`);

  /** Texto do terminal visível agora. */
  const screen = () => page.$eval('.term:not([hidden]) .xterm-rows', (el) => el.textContent ?? '').catch(() => '');
  const waitScreen = (text: string, timeout = 8000) =>
    waitFor(async () => (await screen()).includes(text), timeout, `"${text}" no terminal`);

  async function typeInTerminal(text: string) {
    await page.focus('.term:not([hidden]) textarea');
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  }

  /** Câmera atual do mapa (o canvas a expõe em data-cam: "x,y,zoom"). */
  async function camera() {
    const [x, y, z] = (await page.$eval('#office canvas', (c) => (c as HTMLCanvasElement).dataset.cam ?? '0,0,1')).split(',').map(Number);
    return { x, y, z };
  }

  /** Ponto do mundo → ponto da tela. */
  async function worldToPage(wx: number, wy: number) {
    const box = (await (await page.$('#office canvas'))!.boundingBox())!;
    const c = await camera();
    return { x: box.x + box.width / 2 + (wx - c.x) * c.z, y: box.y + box.height / 2 + (wy - c.y) * c.z };
  }

  async function clickWorld(wx: number, wy: number) {
    const p = await worldToPage(wx, wy);
    await page.mouse.click(p.x, p.y);
  }

  /**
   * Arrasta o mapa até o ponto do mundo ficar perto do meio da tela. Sempre arrasta a partir do
   * centro do mapa, em passos que cabem na tela: o ponto pode começar fora da área visível.
   */
  async function revealWorld(wx: number, wy: number) {
    const box = (await (await page.$('#office canvas'))!.boundingBox())!;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const maxX = box.width / 2 - 20;
    const maxY = box.height / 2 - 20;
    for (let i = 0; i < 20; i++) {
      const p = await worldToPage(wx, wy);
      const dx = center.x - p.x;
      const dy = center.y - p.y;
      if (Math.abs(dx) < 30 && Math.abs(dy) < 30) return;
      const step = { x: Math.max(-maxX, Math.min(maxX, dx)), y: Math.max(-maxY, Math.min(maxY, dy)) };
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      await page.mouse.move(center.x + step.x, center.y + step.y, { steps: 5 });
      await page.mouse.up();
    }
    throw new Error(`não consegui levar o ponto (${wx}, ${wy}) para o meio do mapa`);
  }

  async function hireViaTab(name: string): Promise<Agent> {
    const before = new Set(agents().map((a) => a.id));
    await page.click('#tabs .tab.add[title="Contratar agente"]');
    await page.waitForSelector('#dlg-agent[open]');
    await page.type('#dlg-agent input[name=name]', name);
    await page.keyboard.press('Enter');
    const a = await waitFor(() => agents().find((x) => !before.has(x.id)), 5000, 'agente novo');
    await waitScreen('FAKE CLAUDE');
    return a;
  }

  it('regressão: o painel de git carrega ao abrir a página', async () => {
    const repo = makeRepo('e2e-repo');
    await api('POST', '/api/rooms', { path: repo });
    await page.goto(BASE);
    await page.waitForFunction(() => document.querySelector('#git')?.textContent?.includes('main'), { timeout: 5000 });
  });

  it('regressão: Enter no diálogo cria a sala (antes acionava "Cancelar")', async () => {
    const dir = tempDir('e2e-sala');
    await page.click('#btn-add-room');
    await page.waitForSelector('#dlg-room[open]');
    await page.type('#dlg-room input[name=path]', dir);
    await page.keyboard.press('Enter');
    await waitFor(() => [...store.rooms.values()].some((r) => r.path === dir), 5000, 'sala criada');
    await page.waitForFunction(() => !document.querySelector('#dlg-room[open]'));
  });

  it('contratar pelo "+" abre o terminal do agente', async () => {
    const a = await hireViaTab('Ana');
    await waitStatus(a.id, 'idle');
    const tabs = await page.$$eval('#tabs .tab', (els) => els.map((e) => e.textContent));
    expect(tabs.some((t) => t?.includes('Ana'))).toBe(true);
  });

  it('regressão: as respostas automáticas do terminal não marcam como visto quem terminou', async () => {
    const a = byName('Ana')!;
    await typeInTerminal('prompt oi');
    await waitStatus(a.id, 'done');
    // O Claude falso consulta o terminal (ESC [ c) depois de terminar; o xterm responde sozinho.
    // Antes, essa resposta contava como digitação e o agente saía da fila sem você ler.
    await new Promise((r) => setTimeout(r, 2000));
    expect(status(a.id)).toBe('done');
    await page.waitForFunction(() => document.querySelector('#btn-inbox:not([hidden])'));
  });

  it('regressão: abrir um agente encerrado mostra a última saída dele, e retomar volta ao terminal', async () => {
    const a = byName('Ana')!;
    await typeInTerminal('/exit');
    await waitStatus(a.id, 'exited');
    await page.waitForSelector('#exited:not([hidden])');

    // Sai da aba e volta: antes, o terminal de quem encerrou ficava escondido e o erro sumia.
    await page.click('#tabs .tab.add[title^="Novo terminal"]');
    const shell = await waitFor(() => agents().find((x) => x.kind === 'shell'), 5000, 'terminal');
    await page.waitForFunction(() => document.querySelector('#tabs .tab.active')?.textContent?.includes('Terminal'));
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#tabs .tab')].find((t) => t.textContent?.includes('Ana'))?.click());
    await page.waitForFunction(() => document.querySelector('#tabs .tab.active')?.textContent?.includes('Ana'));
    await page.waitForSelector('#exited:not([hidden])');
    await waitScreen('feito: oi');
    await api('DELETE', `/api/agents/${shell.id}`);
    await page.waitForFunction(() => ![...document.querySelectorAll('#tabs .tab')].some((t) => t.textContent?.includes('Terminal')));

    await page.click('#btn-resume');
    await waitScreen('mode=resume');
    await waitStatus(a.id, 'idle');
    await page.waitForSelector('#exited[hidden]');
  });

  it('regressão: retomar quem nunca conversou começa uma conversa nova em vez de travar', async () => {
    const b = await hireViaTab('Bruno');
    await waitStatus(b.id, 'idle');
    await typeInTerminal('/exit');
    await waitStatus(b.id, 'exited');
    await page.click('#btn-resume');
    await waitStatus(b.id, 'idle');
    // Só a parte visível do terminal: no Windows o ConPTY limpa a tela quando o processo novo
    // começa, então a sessão antiga não aparece aqui (a contagem das duas está no teste do servidor).
    await waitScreen('mode=new');
    expect(await screen()).not.toContain('No conversation found');
  });

  it('terminal comum: abre, roda comando e `exit` fecha a aba', async () => {
    const before = new Set(agents().map((a) => a.id));
    await page.click('#tabs .tab.add[title^="Novo terminal"]');
    const sh = await waitFor(() => agents().find((x) => !before.has(x.id) && x.kind === 'shell'), 5000, 'terminal novo');
    await page.waitForFunction(() => document.querySelector('#tabs .tab.active')?.textContent?.includes('Terminal'));
    await typeInTerminal(process.platform === 'win32' ? 'echo ola-terminal' : 'echo ola-$((1+1))');
    await waitScreen(process.platform === 'win32' ? 'ola-terminal' : 'ola-2');
    await typeInTerminal('exit');
    await waitFor(() => !store.agents.has(sh.id), 5000, 'aba fechar');
    await page.waitForFunction(() => ![...document.querySelectorAll('#tabs .tab')].some((t) => t.textContent?.includes('Terminal')));
  });

  it('regressão: Ctrl+Shift+V cola uma vez só (o navegador já colava, e o escritório colava de novo)', async () => {
    // Com permissão de ler a área de transferência, como num navegador em que você já permitiu.
    await browser.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    const before = new Set(agents().map((a) => a.id));
    await page.click('#tabs .tab.add[title^="Novo terminal"]');
    const sh = await waitFor(() => agents().find((x) => !before.has(x.id) && x.kind === 'shell'), 5000, 'terminal novo');
    await page.waitForFunction(() => document.querySelector('#tabs .tab.active')?.textContent?.includes('Terminal'));
    const cmd = process.platform === 'win32' ? 'echo colado' : 'echo col$((2+3))';
    const out = process.platform === 'win32' ? 'colado' : 'col5';
    await page.bringToFront();
    await page.evaluate((text) => navigator.clipboard.writeText(text), cmd);
    await page.focus('.term:not([hidden]) textarea');
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyV');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 300));
    await page.keyboard.press('Enter');
    await waitScreen(out);
    // Colado duas vezes, a linha vira "echo col5echo col5" e a saída, "col5echo col5".
    expect(await screen()).not.toContain(`${out}echo`);
    await typeInTerminal('exit');
    await waitFor(() => !store.agents.has(sh.id), 5000, 'aba fechar');
  });

  it('Alt+1 troca para a primeira aba da sala', async () => {
    await page.keyboard.down('Alt');
    await page.keyboard.press('Digit1');
    await page.keyboard.up('Alt');
    await page.waitForFunction(() => document.querySelector('#tabs .tab.active')?.textContent?.includes('Ana'));
  });

  it('regressão: atualizar um agente não recria as abas (o clique no "+" ou no 📁 caía num botão trocado)', async () => {
    // Mudança de status redesenha a aba de verdade (a cor da bolinha): espera os agentes assentarem.
    const ids = await page.$$eval('#tabs .tab[data-id]', (els) => els.map((el) => (el as HTMLElement).dataset.id!));
    await waitFor(() => ids.every((i) => !['starting', 'working'].includes(status(i) ?? '')), 8000, 'os agentes das abas pararem');
    await new Promise((r) => setTimeout(r, 300));
    const tab = (await page.$('#tabs .tab[data-id]'))!;
    const id = await tab.evaluate((el) => (el as HTMLElement).dataset.id!);
    const activity = `atividade ${Date.now()}`;
    store.patchAgent(id, { activity });
    await page.waitForFunction((t) => document.querySelector(`#tabs .tab[title="${t}"]`), {}, activity);
    expect(await tab.evaluate((el) => el.isConnected)).toBe(true);
  });

  it('clicar num arquivo alterado abre as linhas modificadas; Esc volta', async () => {
    const room = [...store.rooms.values()].find((r) => r.path.includes('e2e-repo'))!;
    fs.writeFileSync(path.join(room.path, 'README.md'), '# teste\nlinha nova do e2e\n');
    fs.writeFileSync(path.join(room.path, 'extra.ts'), 'export const x = 1;\n');

    // Clica na parede da sala do repositório no mapa, como você faria.
    const r = cellRect(room.pos!);
    await revealWorld(r.x + r.w / 2, r.y + 20);
    await clickWorld(r.x + 40, r.y + 20);
    await page.waitForFunction((n) => document.querySelector('.room-title')?.textContent === n, {}, room.name);
    await page.waitForSelector('#git button.file[data-path="README.md"]', { timeout: 8000 });

    await page.click('#git button.file[data-path="README.md"]');
    await page.waitForSelector('#diff-view:not([hidden]) .dl.add');
    const added = await page.$$eval('#diff-view .dl.add .code', (els) => els.map((e) => e.textContent));
    expect(added).toContain('+ linha nova do e2e');
    expect(await page.$eval('#diff-path', (e) => e.textContent)).toBe('README.md');
    // Números de linha do arquivo novo.
    expect(await page.$$eval('#diff-view .dl.add .no:nth-child(2)', (els) => els.map((e) => e.textContent))).toEqual(['2']);

    await page.click('#diff-next');
    await page.waitForFunction(() => document.querySelector('#diff-path')?.textContent === 'extra.ts');
    await page.waitForSelector('#diff-view .dl.add');

    await page.keyboard.press('Escape');
    await page.waitForSelector('#diff-view[hidden]');
    expect(await page.$eval('#terminals', (e) => getComputedStyle(e).display)).not.toBe('none');
  });

  it('regressão: atualizar o painel de git sem mudança não recria os botões (o clique que caía no meio se perdia)', async () => {
    await page.waitForSelector('#git .branch');
    const branch = (await page.$('#git .branch'))!;
    const refreshed = page.waitForResponse((r) => r.url().endsWith('/git'));
    await page.click('#btn-git-refresh');
    await refreshed;
    await new Promise((r) => setTimeout(r, 100));
    expect(await branch.evaluate((b) => b.isConnected)).toBe(true);
  });

  it('regressão: as seções do painel de git recolhem e continuam como você deixou quando a lista muda', async () => {
    const room = [...store.rooms.values()].find((r) => r.path.includes('e2e-repo'))!;
    const isOpen = (sec: string) => page.$eval(`#git details[data-sec="${sec}"]`, (d) => (d as HTMLDetailsElement).open);
    await page.click('#git details[data-sec="working"] > summary');
    await page.click('#git details[data-sec="commits"] > summary');
    expect([await isOpen('working'), await isOpen('commits')]).toEqual([false, true]);

    // Um arquivo novo muda a lista: antes, o painel redesenhado fechava os "Últimos commits".
    fs.writeFileSync(path.join(room.path, 'secoes.txt'), 'x\n');
    await page.click('#btn-git-refresh');
    await page.waitForSelector('#git button.file[data-path="secoes.txt"]');
    expect([await isOpen('working'), await isOpen('commits')]).toEqual([false, true]);
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('gitSections')))!)).toEqual({ working: false, commits: true });

    // Volta como estava (pelo DOM: com a lista aberta, o resumo pode ficar fora da área visível).
    await page.$eval('#git details[data-sec="working"] > summary', (el) => (el as HTMLElement).click());
    await page.$eval('#git details[data-sec="commits"] > summary', (el) => (el as HTMLElement).click());
    fs.rmSync(path.join(room.path, 'secoes.txt'));
    await page.click('#btn-git-refresh');
    await page.waitForFunction(() => !document.querySelector('#git button.file[data-path="secoes.txt"]'));
  });

  it('worktree: o painel de git traz o trabalho do agente para a main e encerra o worktree', async () => {
    const room = [...store.rooms.values()].find((r) => r.path.includes('e2e-repo'))!;
    const before = new Set(agents().map((a) => a.id));
    await page.click('#tabs .tab.add[title="Contratar agente"]');
    await page.waitForSelector('#dlg-agent[open]');
    await page.type('#dlg-agent input[name=name]', 'Wanda');
    await page.click('#dlg-agent input[name=worktree]');
    await page.keyboard.press('Enter');
    const a = await waitFor(() => agents().find((x) => !before.has(x.id)), 8000, 'agente com worktree');
    await waitScreen('FAKE CLAUDE');

    const git = (...args: string[]) => execFileSync('git', ['-C', a.cwd, ...args], { stdio: 'pipe' });
    fs.writeFileSync(path.join(a.cwd, 'wt-e2e.ts'), 'export const w = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Trabalho da Wanda');
    await page.click('#btn-git-refresh');
    await page.waitForSelector('#git button[data-wt=merge]:not([disabled])', { timeout: 8000 });
    expect(await page.$eval('#git .worktree h4', (e) => e.textContent)).toContain('1 commit a mais que main');

    await page.click('#git button[data-wt=merge]');
    await page.waitForSelector('#dlg-confirm[open]');
    await page.click('#dlg-confirm button[value=ok]');
    await page.waitForFunction(() => document.querySelector('#git .worktree h4')?.textContent?.includes('Tudo já está em main'), { timeout: 8000 });
    // O git do Windows (core.autocrlf) grava o arquivo que chega pelo merge com \r\n.
    expect(fs.readFileSync(path.join(room.path, 'wt-e2e.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('export const w = 1;\n');

    await page.click('#git button[data-wt=remove]');
    await page.waitForSelector('#dlg-worktree-end[open]');
    expect(await page.$eval('#dlg-worktree-end input[name=deleteBranch]', (e) => (e as HTMLInputElement).disabled)).toBe(false);
    await page.click('#dlg-worktree-end input[name=deleteBranch]');
    await page.click('#dlg-worktree-end button[value=ok]');
    await waitFor(() => !store.agents.has(a.id), 8000, 'agente sair');
    await page.waitForSelector('#dlg-worktree-end:not([open])');
    expect(fs.existsSync(a.cwd)).toBe(false);
    expect(execFileSync('git', ['-C', room.path, 'branch', '--list', a.worktreeBranch!]).toString()).toBe('');
  });

  it.skipIf(process.platform === 'win32')('memória: o indicador mostra desligada, e instalar pelo diálogo liga', async () => {
    // ai-memory falso: /healthz responde quando o container do Docker falso está rodando.
    const tmp = process.env.AI_OFFICE_TMP!;
    const running = () => {
      const f = path.join(tmp, 'docker-state.json');
      return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).containers['ai-memory']?.running;
    };
    const health = http.createServer((req, res) => {
      res.statusCode = req.url === '/healthz' && running() ? 200 : 503;
      res.end();
    });
    await new Promise<void>((r) => health.listen(0, '127.0.0.1', r));
    process.env.AI_OFFICE_MEMORY_URL = `http://127.0.0.1:${(health.address() as AddressInfo).port}`;
    const release = process.env.AI_OFFICE_MEMORY_RELEASE!;
    fs.mkdirSync(release, { recursive: true });
    const body = fs.readFileSync(path.resolve('test/fixtures/fake-ai-memory.mjs'));
    fs.writeFileSync(path.join(release, 'ai-memory-wrapper'), body);
    fs.writeFileSync(path.join(release, 'ai-memory-wrapper.sha256'), createHash('sha256').update(body).digest('hex'));
    try {
      await page.click('#btn-memory');
      await page.waitForSelector('#dlg-memory[open]');
      await page.waitForFunction(() => document.querySelector('#btn-memory')?.textContent === 'Memória: desligada');
      expect(await page.$$eval('#mem-checks li.ok', (els) => els.length)).toBe(0);
      expect(await page.$eval('#mem-plan', (e) => (e as HTMLElement).hidden)).toBe(false);

      await page.click('#mem-install');
      await page.waitForFunction(() => document.querySelector('#btn-memory')?.textContent === 'Memória: ligada', { timeout: 15000 });
      await page.waitForFunction(() => document.querySelectorAll('#mem-checks li.ok').length === 3);
      expect(await page.$eval('#mem-step', (e) => e.textContent)).toContain('Pronto');
      expect(await page.$eval('#mem-install', (e) => (e as HTMLElement).hidden)).toBe(true);
      await page.click('#dlg-memory button[value=cancel]');
    } finally {
      health.close();
    }
  });

  it('arrastar o mapa move a câmera e não conta como clique', async () => {
    const before = await camera();
    const box = (await (await page.$('#office canvas'))!.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 120, cy - 60, { steps: 6 });
    await page.mouse.up();
    const after = await camera();
    expect(after.x - before.x).toBeCloseTo(120 / before.z, 0);
    expect(after.y - before.y).toBeCloseTo(60 / before.z, 0);
    // Soltar o mouse sobre um "+" no fim de um arraste não abre o diálogo de sala.
    expect(await page.$('#dlg-room[open]')).toBeNull();
  });

  it('a rodinha do mouse muda o zoom', async () => {
    const before = await camera();
    const box = (await (await page.$('#office canvas'))!.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel({ deltaY: before.z >= 3 ? 200 : -200 });
    await page.waitForFunction((z) => !(document.querySelector('#office canvas') as HTMLCanvasElement).dataset.cam?.endsWith(`,${z}`), {}, before.z);
  });

  it('o "+" ao lado de uma sala cria a sala nova naquela vaga', async () => {
    const dir = tempDir('e2e-vaga');
    const { freeCells } = await import('../shared/building.ts');
    const cell = freeCells([...store.rooms.values()]).find((c) => c.y >= 1)!;
    const r = cellRect(cell);
    await revealWorld(r.x + r.w / 2, r.y + r.h / 2);
    await clickWorld(r.x + r.w / 2, r.y + r.h / 2);
    await page.waitForSelector('#dlg-room[open]');
    expect(await page.$eval('#dlg-room-where', (e) => e.textContent)).toContain('vaga que você clicou');
    await page.type('#dlg-room input[name=path]', dir);
    await page.keyboard.press('Enter');
    const created = await waitFor(() => [...store.rooms.values()].find((x) => x.path === dir), 5000, 'sala criada');
    expect(created.pos).toEqual(cell);
  });

  it('regressão: atualizar um agente não recria os botões do elevador (o clique caía num botão trocado)', async () => {
    const before = await page.$('#elevator .floor.add');
    const a = agents().find((x) => x.kind !== 'shell')!;
    // Qualquer mudança de agente que não mexe no painel: antes, o painel inteiro era recriado.
    store.patchAgent(a.id, { activity: `atividade ${Date.now()}` });
    await new Promise((r) => setTimeout(r, 300));
    expect(await before!.evaluate((el) => el.isConnected)).toBe(true);
  });

  it('andares: cria pelo elevador, sobe e desce com Alt+PageUp/PageDown, e o térreo não tem vagas', async () => {
    const current = () => page.$eval('#elevator .floor.current', (b) => (b as HTMLElement).dataset.floor ?? '');
    await page.click('#elevator .floor.add');
    await page.waitForSelector('#dlg-floor[open]');
    await page.type('#dlg-floor input[name=name]', 'Freelance');
    await page.keyboard.press('Enter');
    const freela = await waitFor(() => [...store.floors.values()].find((f) => f.name === 'Freelance'), 5000, 'andar criado');
    // Criar o andar já leva até ele.
    await waitFor(async () => (await current()) === freela.id, 5000, 'elevador no andar novo');

    const geral = [...store.floors.values()].sort((a, b) => a.order - b.order)[0];
    await page.keyboard.down('Alt');
    await page.keyboard.press('PageDown');
    await page.keyboard.up('Alt');
    await waitFor(async () => (await current()) === geral.id, 5000, 'desceu para o primeiro andar');

    await page.keyboard.down('Alt');
    await page.keyboard.press('PageDown');
    await page.keyboard.up('Alt');
    await waitFor(async () => (await current()) === 'terreo', 5000, 'desceu para o térreo');

    // Clicar no botão do andar também leva até ele.
    await page.click(`#elevator .floor[data-floor="${geral.id}"]`);
    await waitFor(async () => (await current()) === geral.id, 5000, 'voltou pelo botão');
  });

  it('padrões do andar: o ✎ do elevador desliga a co-autoria e grava as instruções', async () => {
    const geral = [...store.floors.values()].sort((a, b) => a.order - b.order)[0];
    await page.goto(BASE);
    await page.click(`#elevator .floor[data-floor="${geral.id}"]`);
    await page.click('#elevator .floor.edit');
    await page.waitForSelector('#dlg-floor[open]');
    expect(await page.$eval('#dlg-floor input[name=coAuthor]', (i) => (i as HTMLInputElement).checked)).toBe(true);
    await page.click('#dlg-floor input[name=coAuthor]');
    await page.type('#dlg-floor textarea[name=instructions]', 'Commits resumidos');
    await page.click('#dlg-floor button[value=ok]');
    await waitFor(() => store.floors.get(geral.id)?.defaults?.instructions === 'Commits resumidos', 5000, 'padrões salvos');
    expect(store.floors.get(geral.id)!.defaults).toEqual({ coAuthor: false, instructions: 'Commits resumidos' });

    // Reabrir mostra o que foi salvo; desfaz para não afetar os outros testes.
    await page.click('#elevator .floor.edit');
    await page.waitForSelector('#dlg-floor[open]');
    expect(await page.$eval('#dlg-floor input[name=coAuthor]', (i) => (i as HTMLInputElement).checked)).toBe(false);
    expect(await page.$eval('#dlg-floor textarea[name=instructions]', (t) => (t as HTMLTextAreaElement).value)).toBe('Commits resumidos');
    await page.click('#dlg-floor input[name=coAuthor]');
    await page.$eval('#dlg-floor textarea[name=instructions]', (t) => ((t as HTMLTextAreaElement).value = ''));
    await page.click('#dlg-floor button[value=ok]');
    await waitFor(() => !store.floors.get(geral.id)?.defaults, 5000, 'padrões limpos');
  });

  it('regressão: voltar a um andar com outro zoom desenha o céu na tela toda (sobrava uma borda verde)', async () => {
    const current = () => page.$eval('#elevator .floor.current', (b) => (b as HTMLElement).dataset.floor ?? '');
    const go = async (id: string) => {
      await page.click(`#elevator .floor[data-floor="${id}"]`);
      await waitFor(async () => (await current()) === id, 5000, `andar ${id}`);
    };
    const geral = [...store.floors.values()].sort((a, b) => a.order - b.order)[0];
    await page.goto(BASE);
    await page.waitForSelector(`#elevator .floor[data-floor="${geral.id}"]`);
    // Andar afastado ao máximo, térreo aproximado ao máximo: o canvas interno fica pequeno.
    await go(geral.id);
    for (let i = 0; i < 6; i++) await page.click('#map-zoom-out');
    await go('terreo');
    for (let i = 0; i < 6; i++) await page.click('#map-zoom-in');
    await go(geral.id);
    expect((await camera()).z).toBe(0.5);
    // O canto da tela é céu, não o verde de reserva que aparece fora do desenho.
    const corner = await page.$eval('#office canvas', (c) => [...(c as HTMLCanvasElement).getContext('2d')!.getImageData(2, 2, 1, 1).data.slice(0, 3)]);
    expect(corner).not.toEqual([0x2f, 0x6b, 0x33]);
  });

  it('lista do escritório: mostra os agentes por andar, busca sem acento e clicar abre o terminal', async () => {
    const ana = byName('Ana')!;
    await page.waitForSelector(`#dir-tree .dir-agent[data-agent="${ana.id}"]`);
    // Busca: só sobra o caminho até quem bate.
    await page.type('#dir-search', 'ANA');
    await page.waitForFunction(() => [...document.querySelectorAll('#dir-tree .dir-agent b')].every((b) => b.textContent === 'Ana'));
    await page.click(`#dir-tree .dir-agent[data-agent="${ana.id}"]`);
    await page.waitForFunction(() => document.querySelector('#tabs .tab.active')?.textContent?.includes('Ana'));
    // Limpa a busca.
    await page.click('#dir-search', { count: 3 });
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => document.querySelectorAll('#dir-tree .dir-agent').length > 1);
  });

  it('contadores do topo batem com o escritório', async () => {
    const salas = await page.$eval('#counters .counter.salas b', (b) => b.textContent);
    expect(Number(salas)).toBe(store.rooms.size);
    const agentes = await page.$eval('#counters .counter.agentes b', (b) => b.textContent);
    expect(Number(agentes)).toBe(agents().filter((a) => a.kind !== 'shell').length);
  });

  it('a atividade flutua sobre o mapa e dá para recolher', async () => {
    await page.click('#activity-toggle');
    await page.waitForSelector('#activity-float.collapsed');
    await page.click('#activity-toggle');
    await page.waitForSelector('#activity-float:not(.collapsed)');
  });

  it('o ⇥ esconde o painel da direita, o terminal ocupa o espaço, e a escolha vale depois de recarregar', async () => {
    const width = () => page.$eval('.terminal-pane', (e) => e.getBoundingClientRect().width);
    const before = await width();
    await page.click('#btn-sidebar');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#sidebar')!).display === 'none');
    expect(await width()).toBeGreaterThan(before + 200);
    await page.reload();
    await page.waitForSelector('#office canvas');
    expect(await page.$eval('#sidebar', (e) => getComputedStyle(e).display)).toBe('none');
    expect(await page.$eval('#btn-sidebar', (e) => e.getAttribute('title'))).toBe('Mostrar o painel da direita');
    await page.click('#btn-sidebar');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#sidebar')!).display !== 'none');
  });

  it('sala de guerra: abre um incidente pelo mapa, conversa pelo chat e encerrar devolve o agente à mesa', async () => {
    const roomId = byName('Ana')!.roomId;
    const floorId = store.rooms.get(roomId)!.floorId!;
    const { data: zeca } = await api<Agent>('POST', '/api/agents', { roomId, name: 'Zeca' });
    await waitStatus(zeca.id, 'idle');
    await page.click(`#elevator .floor[data-floor="${floorId}"]`);

    // A sala de guerra fica em cima do elevador e começa livre (luz apagada).
    const r = cellRect({ x: 0, y: 1 });
    await revealWorld(r.x + r.w / 2, r.y + r.h / 2);
    // Na parte de cima: embaixo do mapa fica o painel de atividade.
    await clickWorld(r.x + 40, r.y + 60);
    await page.waitForSelector('#war-panel:not([hidden])');
    expect(await page.$eval('#war-title', (e) => e.textContent)).toContain('livre');
    expect(await page.$eval('#git-panel', (e) => (e as HTMLElement).hidden)).toBe(true);

    await page.click('#war-open');
    await page.waitForSelector('#dlg-incident[open]');
    await page.type('#dlg-incident input[name=title]', '503 na API');
    await page.click(`#incident-who input[name=agent][value="${zeca.id}"]`);
    await page.click('#incident-submit');
    const incident = await waitFor(() => [...store.incidents.values()].find((i) => i.title === '503 na API'), 5000, 'incidente aberto');
    expect(incident.participants).toEqual([zeca.id]);

    // As abas são os participantes e o terminal comum da sala de guerra, que já abre sozinho.
    await page.waitForFunction(() => document.querySelector('#tabs .tab.active')?.textContent?.includes('Zeca'));
    await page.waitForFunction(() => [...document.querySelectorAll('#tabs .tab')].some((t) => t.textContent?.includes('Terminal 1')));
    // A resposta ao convite vira um card com quem respondeu e o botão, sem o texto (ele está no terminal).
    await page.waitForSelector('#war-chat .msg.agente', { timeout: 10_000 });
    const card = await page.$eval('#war-chat .msg.agente', (li) => ({ text: li.textContent ?? '', body: !!li.querySelector('.msg-text'), open: li.querySelector('.msg-open')?.textContent }));
    expect(card.open).toContain('Zeca');
    expect(card.body).toBe(false);
    expect(card.text).not.toContain('feito:');

    // Digitar @ sugere quem está na sala; Tab completa.
    await page.focus('#war-input');
    await page.keyboard.type('@ze');
    await page.waitForSelector('#war-mentions:not([hidden]) li.active');
    expect(await page.$eval('#war-mentions li.active b', (e) => e.textContent)).toBe('@zeca');
    await page.keyboard.press('Tab');
    expect(await page.$eval('#war-input', (e) => (e as HTMLTextAreaElement).value)).toBe('@zeca ');
    expect(await page.$eval('#war-mentions', (e) => (e as HTMLElement).hidden)).toBe(true);

    // Enter envia; a mensagem aparece no chat e chega no terminal do agente.
    await page.keyboard.type('olha o timeout');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('#war-chat .msg.voce')].some((li) => li.textContent?.includes('olha o timeout')));
    expect(await page.$eval('#war-input', (e) => (e as HTMLTextAreaElement).value)).toBe('');
    await waitScreen('só para você: @zeca olha o timeout', 10_000);

    // @ de quem não está na sala: avisa e não manda.
    await page.type('#war-input', '@ninguem oi');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#war-error:not([hidden])');
    expect(await page.$eval('#war-error', (e) => e.textContent)).toContain('@ninguem');
    await page.$eval('#war-input', (e) => ((e as HTMLTextAreaElement).value = ''));

    await page.click('#war-close');
    await page.waitForSelector('#dlg-close-incident[open]');
    await page.type('#dlg-close-incident textarea[name=resolution]', 'Timeout ajustado');
    await page.click('#dlg-close-incident button[value=ok]');
    await waitFor(() => !store.incidents.has(incident.id), 5000, 'incidente encerrado');
    expect(store.agents.get(zeca.id)?.incidentId).toBeUndefined();
    await page.waitForSelector('#war-open:not([hidden])');
    expect(fs.readFileSync(incident.file, 'utf8')).toContain('Timeout ajustado');
  });

  it('regressão: o piso de madeira é só madeira (a metadata do PixelLab vinha com os cantos trocados)', async () => {
    const grassPixels = await page.evaluate(async () => {
      const img = new Image();
      img.src = 'sprites/madeira.png';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let green = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 20 && d[i + 1] > d[i + 2]) green++;
      return green;
    });
    expect(grassPixels).toBe(0);
  });

  describe('explorador de arquivos', () => {
    let repo = '';
    const gitIn = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { stdio: 'pipe' });
    /** Texto do editor visível (o Monaco só desenha as linhas na tela). */
    const editorText = () => page.$eval('#files-editor .view-lines', (el) => (el as HTMLElement).innerText.replace(/\u00a0/g, ' ')).catch(() => '');
    const node = (p: string) => `#files-tree .node[data-path="${p}"]`;

    beforeAll(async () => {
      repo = makeRepo('e2e-explorador');
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 1;\n');
      gitIn('add', '-A');
      gitIn('commit', '-q', '-m', 'adiciona app');
      gitIn('checkout', '-q', '-b', 'feat/y');
      fs.writeFileSync(path.join(repo, 'README.md'), '# teste\nda branch feat/y\n');
      gitIn('commit', '-q', '-am', 'muda o readme na branch');
      gitIn('checkout', '-q', 'main');
      const { data: room } = await api('POST', '/api/rooms', { path: repo });
      await page.waitForFunction((n) => document.body.textContent?.includes(n), {}, room.name);
      const r = cellRect(store.rooms.get(room.id)!.pos!);
      await revealWorld(r.x + r.w / 2, r.y + 20);
      await clickWorld(r.x + 40, r.y + 20);
      await page.waitForFunction((n) => document.querySelector('.room-title')?.textContent === n, {}, room.name);
      await page.waitForFunction(() => document.querySelector('#git .branch')?.textContent?.includes('main'));
    });

    it('o 📁 abre o explorador numa aba da sala; um arquivo da árvore abre, edita e salva com Ctrl+S', async () => {
      await page.click('#tabs .tab.add[title="Arquivos e histórico da sala"]');
      await page.waitForSelector(`#files-view:not([hidden]) ${node('src')}`);
      await page.waitForSelector('#tabs .tab.files.active');
      expect(await page.$eval('#terminals', (e) => getComputedStyle(e).display)).toBe('none');
      await page.click(node('src'));
      await (await page.waitForSelector(node('src/app.ts')))!.click();
      await waitFor(async () => (await editorText()).includes('export const a = 1;'), 15000, 'o arquivo no editor');

      await page.click('#files-editor .view-lines');
      await page.keyboard.down('Control');
      await page.keyboard.press('End');
      await page.keyboard.up('Control');
      await page.keyboard.type('// editado');
      await page.waitForFunction(() => document.querySelector('#files-path')?.textContent?.endsWith('●'));
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await waitFor(() => fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8').includes('// editado'), 5000, 'salvar no disco');
      await page.waitForFunction(() => document.querySelector('#files-path')?.textContent === 'src/app.ts');
      // A árvore marca o arquivo alterado, e a pasta dele.
      await page.waitForSelector(`${node('src/app.ts')}.mk-M`);
      await page.waitForSelector(`${node('src')}.mk-dir`);
    });

    it('não salva por cima do que mudou no disco; "Recarregar do disco" traz a versão nova', async () => {
      fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 2; // do agente\n');
      await page.click('#files-editor .view-lines');
      await page.keyboard.type('x');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyS');
      await page.keyboard.up('Control');
      await page.waitForFunction(() => document.querySelector('#files-msg')?.textContent?.includes('mudou no disco'));
      expect(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const a = 2; // do agente\n');
      await page.click('#files-msg button[data-act="reload"]');
      await waitFor(async () => (await editorText()).includes('do agente'), 5000, 'a versão do disco no editor');
    });

    it('desfazer: a edição não salva, o arquivo lado a lado com o commit e o arquivo inteiro de volta ao commit', async () => {
      const disk = () => fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8');
      // Desfazer edição: volta ao que está no disco.
      await page.click('#files-editor .view-lines');
      await page.keyboard.type('zzz');
      await page.waitForSelector('#files-undo:not([hidden])');
      await page.click('#files-undo');
      await waitFor(async () => !(await editorText()).includes('zzz'), 5000, 'a edição desfeita');
      await page.waitForFunction(() => document.querySelector('#files-path')?.textContent === 'src/app.ts');
      await page.waitForSelector('#files-undo', { hidden: true });

      // Ver alterações: o último commit à esquerda, o arquivo à direita.
      await page.click('#files-changes-btn');
      await page.waitForSelector('#files-changes:not([hidden]) .monaco-diff-editor');
      await page.waitForFunction(() =>
        document.querySelector('#files-changes .editor.original .view-lines')?.textContent?.replace(/\u00a0/g, ' ').includes('export const a = 1;'),
      );
      await page.click('#files-changes-btn');
      await page.waitForSelector('#files-editor:not([hidden])');

      // Desfazer alterações: o arquivo volta ao commit e é salvo; Ctrl+Z traz o texto de antes.
      await page.click('#files-restore');
      await page.waitForSelector('#dlg-confirm[open]');
      await page.click('#dlg-confirm button[value=ok]');
      await waitFor(() => disk() === 'export const a = 1;\n', 5000, 'o arquivo de volta ao commit');
      await page.waitForSelector(`${node('src/app.ts')}:not(.mk-M)`);
      await page.waitForSelector('#files-restore', { hidden: true });
      await page.click('#files-editor .view-lines');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await waitFor(async () => (await editorText()).includes('do agente'), 5000, 'o Ctrl+Z trazendo o texto de antes');
      expect(disk()).toBe('export const a = 1;\n');
      await page.click('#files-undo');
      await page.waitForSelector('#files-undo', { hidden: true });
    });

    it('cria e apaga arquivo pela árvore', async () => {
      await page.click(node('src'));
      await page.click('#files-new-file');
      await page.waitForSelector('#dlg-file-name[open]');
      await page.type('#dlg-file-name input[name=name]', 'novo.ts');
      await page.keyboard.press('Enter');
      // O arquivo novo já abre no editor.
      await page.waitForSelector(`${node('src/novo.ts')}.open`);
      expect(fs.existsSync(path.join(repo, 'src', 'novo.ts'))).toBe(true);

      await page.click(node('src/novo.ts'));
      await page.click('#files-delete');
      await page.waitForSelector('#dlg-confirm[open]');
      await page.click('#dlg-confirm button[value=ok]');
      await waitFor(() => !fs.existsSync(path.join(repo, 'src', 'novo.ts')), 5000, 'apagar o arquivo');
      await page.waitForFunction((sel) => !document.querySelector(sel), {}, node('src/novo.ts'));
    });

    it('mostra os arquivos de outra branch, só leitura, sem trocar a branch da pasta', async () => {
      await page.select('#files-ref', 'feat/y');
      // Na branch, a árvore é só leitura: os botões de criar ficam desligados.
      await page.waitForSelector('#files-new-file[disabled]');
      await page.click(node('README.md'));
      await waitFor(async () => (await editorText()).includes('da branch feat/y'), 5000, 'o README da feat/y');
      expect(await page.$eval('#files-note', (e) => e.textContent)).toContain('só leitura');
      expect(await page.$eval('#files-save', (e) => (e as HTMLElement).hidden)).toBe(true);
      expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# teste\n');
      await page.select('#files-ref', '');
      await page.waitForSelector('#files-new-file:not([disabled])');
    });

    it('histórico: commits da branch, o que um commit mudou e a comparação com outra branch', async () => {
      await page.click('#files-modes button[data-mode="history"]');
      await page.waitForSelector('#hist-pane:not([hidden]) .commit-row');
      const subjects = await page.$$eval('#hist-list .commit-row .subj', (els) => els.map((e) => e.textContent));
      expect(subjects).toEqual(['adiciona app', 'primeiro commit']);

      await page.click('#hist-list .commit-row');
      await (await page.waitForSelector('#hist-list button.file[data-path="src/app.ts"]'))!.click();
      await page.waitForSelector('#files-diff:not([hidden]) .monaco-diff-editor');
      expect(await page.$eval('#files-note', (e) => e.textContent)).toMatch(/^commit /);

      await page.select('#hist-compare', 'feat/y');
      await page.waitForFunction(() => document.querySelector('#hist-list')?.textContent?.includes('1 commit que'));
      await page.click('#hist-list button.file[data-path="README.md"]');
      await page.waitForFunction(() => document.querySelector('#files-note')?.textContent === 'main → feat/y');
      await page.waitForFunction(() => document.querySelector('#files-diff .editor.modified .view-lines')?.textContent?.replace(/\u00a0/g, ' ').includes('da branch feat/y'));

    });

    it('modo Git: o painel de git da lateral entra no explorador, e o diff abre na área principal', async () => {
      fs.writeFileSync(path.join(repo, 'README.md'), '# teste\nmudou no modo git\n');
      await page.click('#files-modes button[data-mode="git"]');
      await page.waitForSelector('#git-pane:not([hidden]) #git .branch');
      expect(await page.$eval('#git-panel', (e) => (e as HTMLElement).hidden)).toBe(true);
      await page.click(`#git-pane button.file[data-path="README.md"]`);
      await page.waitForSelector('#git-main #diff-view:not([hidden]) .dl.add');
      expect(await page.$$eval('#diff-view .dl.add .code', (els) => els.map((e) => e.textContent))).toContain('+ mudou no modo git');
      // Esc fecha só o diff: o explorador continua, no modo Git.
      await page.keyboard.press('Escape');
      await page.waitForSelector('#diff-view[hidden]');
      expect(await page.$eval('#files-view', (e) => (e as HTMLElement).hidden)).toBe(false);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#git-main .git-empty')!).display !== 'none');

      // O × da aba fecha o explorador; o painel de git e o diff voltam para os lugares de antes.
      await page.click('#tabs .tab.files .close');
      await page.waitForSelector('#files-view[hidden]');
      expect(await page.$('#tabs .tab.files')).toBeNull();
      expect(await page.$eval('#git-panel', (e) => (e as HTMLElement).hidden)).toBe(false);
      expect(await page.$('#git-panel #git')).not.toBeNull();
      expect(await page.$eval('#diff-view', (e) => e.parentElement?.classList.contains('terminal-pane'))).toBe(true);
      fs.writeFileSync(path.join(repo, 'README.md'), '# teste\n');
    });
  });

  it('a página não tem erros de JavaScript', async () => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.reload();
    await page.waitForSelector('#office canvas');
    await new Promise((r) => setTimeout(r, 500));
    expect(errors).toEqual([]);
  });
});
