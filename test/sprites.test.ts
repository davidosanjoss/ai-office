import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEAD_Y, seatTop } from '../web/office.ts';
import { RECEPCIONISTA, characterFor, type Manifest } from '../web/sprites.ts';

const DIR = path.resolve('web/public/sprites');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) as Manifest;
const agentes = Object.keys(manifest.personagens).filter((n) => n !== RECEPCIONISTA);

describe('pacote de sprites', () => {
  it('todo arquivo citado no manifest existe', () => {
    const files = [
      ...Object.values(manifest.objetos),
      ...Object.values(manifest.pisos),
      ...Object.values(manifest.personagens).flatMap((a) => Object.values(a)),
    ].map((e) => e.arquivo);
    for (const f of files) expect(fs.existsSync(path.join(DIR, f)), f).toBe(true);
  });

  it('o escritório tem os objetos e pisos que desenha', () => {
    expect(Object.keys(manifest.objetos)).toEqual(
      expect.arrayContaining(['mesa-costas', 'cadeira', 'balcao', 'sofa', 'cafeteira', 'geladeira', 'mesa-copa', 'poste', 'carro', 'arvore']),
    );
    expect(Object.keys(manifest.pisos)).toEqual(expect.arrayContaining(['grama', 'madeira', 'corredor', 'copa']));
  });

  it('todo personagem que vira agente tem as animações da mesa e de andar nas 4 direções', () => {
    expect(agentes.length).toBeGreaterThanOrEqual(7);
    for (const nome of agentes) {
      expect(Object.keys(manifest.personagens[nome]), nome).toEqual(
        expect.arrayContaining(['parado', 'digitando', 'mao', 'comemorando', 'andar-south', 'andar-east', 'andar-north', 'andar-west']),
      );
    }
    expect(manifest.personagens[RECEPCIONISTA]).toHaveProperty('parado');
  });

  it('regressão: toda animação de mesa deixa a cabeça na mesma altura (digitando é sentada e afundava atrás da mesa)', () => {
    for (const nome of agentes) {
      for (const anim of ['parado', 'digitando', 'mao', 'comemorando']) {
        const a = manifest.personagens[nome][anim];
        expect(seatTop(a) + a.cabecaY, `${nome}/${anim}`).toBe(HEAD_Y);
      }
    }
    // Posicionar pelos pés, como antes, deixava a cabeça de quem digita bem mais baixa.
    const p = manifest.personagens['funcionario-1'];
    const byFeet = (a: { pesY: number; cabecaY: number }) => 86 - a.pesY + a.cabecaY;
    expect(byFeet(p.digitando) - byFeet(p.parado)).toBeGreaterThan(4);
  });
});

describe('personagem de cada agente', () => {
  const nomes = Object.keys(manifest.personagens);

  it('é sempre o mesmo para o mesmo agente', () => {
    expect(characterFor(12345, nomes)).toBe(characterFor(12345, nomes));
  });

  it('nunca é a recepcionista, que fica no balcão', () => {
    for (let seed = 0; seed < 50; seed++) expect(characterFor(seed, nomes)).not.toBe(RECEPCIONISTA);
  });

  it('agentes diferentes se espalham pelos personagens', () => {
    const usados = new Set(Array.from({ length: 40 }, (_, i) => characterFor(i, nomes)));
    expect(usados.size).toBe(agentes.length);
  });

  it('sem personagens carregados, nenhum', () => {
    expect(characterFor(1, [])).toBeUndefined();
  });
});
