// Ponta a ponta: a interface compilada num Chrome/Chromium/Edge headless, clicando e digitando
// como você faria, com o servidor real e o Claude falso. Pula se não houver navegador
// (defina CHROME_PATH para escolher um).

import fs from 'node:fs';
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

  it('Alt+1 troca para a primeira aba da sala', async () => {
    await page.keyboard.down('Alt');
    await page.keyboard.press('Digit1');
    await page.keyboard.up('Alt');
    await page.waitForFunction(() => document.querySelector('#tabs .tab.active')?.textContent?.includes('Ana'));
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

  it('a página não tem erros de JavaScript', async () => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.reload();
    await page.waitForSelector('#office canvas');
    await new Promise((r) => setTimeout(r, 500));
    expect(errors).toEqual([]);
  });
});
