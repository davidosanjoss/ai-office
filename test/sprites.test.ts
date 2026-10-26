import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEAD_Y, seatTop } from '../web/office.ts';
import { HOODIE_HUES, hslToRgb, rgbToHsl } from '../web/sprites.ts';

const DIR = path.resolve('web/public/sprites');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

describe('pacote de sprites', () => {
  it('todo arquivo citado no manifest existe', () => {
    const files = [
      ...Object.values<any>(manifest.objetos),
      ...Object.values<any>(manifest.pisos),
      ...Object.values<any>(manifest.animacoes),
    ].map((e) => e.arquivo);
    for (const f of files) expect(fs.existsSync(path.join(DIR, f)), f).toBe(true);
  });

  it('o escritório tem tudo o que desenha', () => {
    expect(Object.keys(manifest.objetos)).toEqual(expect.arrayContaining(['mesa', 'cadeira', 'planta', 'arvore']));
    expect(Object.keys(manifest.pisos)).toEqual(expect.arrayContaining(['grama', 'madeira']));
    expect(Object.keys(manifest.animacoes)).toEqual(expect.arrayContaining(['parado', 'digitando', 'mao']));
  });

  it('regressão: toda animação deixa a cabeça na mesma altura (digitando é sentada e afundava atrás da mesa)', () => {
    const heads = Object.values<any>(manifest.animacoes).map((a) => seatTop(a) + a.cabecaY);
    expect(new Set(heads)).toEqual(new Set([HEAD_Y]));
    // Posicionar pelos pés, como antes, deixava a cabeça de quem digita bem mais baixa.
    const byFeet = (a: any) => 86 - a.pesY + a.cabecaY;
    expect(byFeet(manifest.animacoes.digitando) - byFeet(manifest.animacoes.parado)).toBeGreaterThan(4);
  });
});

describe('cor do moletom', () => {
  it('rgb ↔ hsl ida e volta', () => {
    const samples: [number, number, number][] = [
      [78, 110, 190],
      [200, 40, 40],
      [20, 160, 90],
      [128, 128, 128],
    ];
    for (const [r, g, b] of samples) {
      const back = hslToRgb(...rgbToHsl(r, g, b));
      back.forEach((v, i) => expect(Math.abs(v - [r, g, b][i])).toBeLessThanOrEqual(1));
    }
  });

  it('o azul do moletom cai na faixa trocada; o da calça (mais escuro) não', () => {
    const [hHoodie, , lHoodie] = rgbToHsl(77, 106, 179); // moletom
    const [hJeans, , lJeans] = rgbToHsl(31, 52, 122); // calça
    expect(hHoodie).toBeGreaterThanOrEqual(200);
    expect(hHoodie).toBeLessThanOrEqual(235);
    expect(lHoodie).toBeGreaterThan(0.38);
    expect(hJeans).toBeGreaterThanOrEqual(200);
    expect(lJeans).toBeLessThanOrEqual(0.38);
  });

  it('o primeiro tom é o original (sem recolorir)', () => {
    expect(HOODIE_HUES[0]).toBeGreaterThanOrEqual(200);
    expect(HOODIE_HUES[0]).toBeLessThanOrEqual(235);
  });
});
