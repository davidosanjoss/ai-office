import { describe, expect, it } from 'vitest';
import { type Area, depth, floorMatrix, pick, planBox, projectRect, screenDir, toPlan, toScreen } from '../web/iso.ts';

describe('projeção isométrica', () => {
  it('direita na planta desce para a direita; para baixo na planta desce para a esquerda', () => {
    expect(toScreen({ x: 10, y: 0 }, 'iso')).toEqual({ x: 10, y: 5 });
    expect(toScreen({ x: 0, y: 10 }, 'iso')).toEqual({ x: -10, y: 5 });
  });

  it('z levanta na tela sem mexer no x', () => {
    expect(toScreen({ x: 10, y: 0 }, 'iso', 20)).toEqual({ x: 10, y: -15 });
  });

  it('a volta da tela para a planta é a inversa', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 344, y: -260 },
      { x: -17.5, y: 92 },
    ]) {
      for (const mode of ['iso', 'topo'] as const) {
        const back = toPlan(toScreen(p, mode), mode);
        expect(back.x).toBeCloseTo(p.x);
        expect(back.y).toBeCloseTo(p.y);
      }
    }
  });

  it('a matriz do canvas faz a mesma conta que toScreen', () => {
    const [a, b, c, d] = floorMatrix('iso');
    const p = { x: 37, y: -12 };
    expect({ x: a * p.x + c * p.y, y: b * p.x + d * p.y }).toEqual(toScreen(p, 'iso'));
  });

  it('a caixa de uma sala na tela é um losango deitado, e as paredes a aumentam para cima', () => {
    const r = { x: 0, y: 0, w: 100, h: 60 };
    expect(projectRect(r, 'iso')).toEqual({ x: -60, y: 0, w: 160, h: 80 });
    expect(projectRect(r, 'iso', 40)).toEqual({ x: -60, y: -40, w: 160, h: 120 });
  });

  it('a caixa da planta que a tela enxerga contém os quatro cantos da tela', () => {
    const view = { x: -50, y: 10, w: 200, h: 120 };
    const box = planBox(view, 'iso');
    for (const c of [
      { x: view.x, y: view.y },
      { x: view.x + view.w, y: view.y + view.h },
    ]) {
      const p = toPlan(c, 'iso');
      expect(p.x).toBeGreaterThanOrEqual(box.x - 1e-9);
      expect(p.y).toBeLessThanOrEqual(box.y + box.h + 1e-9);
    }
  });

  it('quem está mais perto de quem olha é desenhado depois', () => {
    // Na mesma linha da planta, mais para a direita fica mais na frente no isométrico.
    expect(depth({ x: 50, y: 0 }, 'iso')).toBeGreaterThan(depth({ x: 10, y: 0 }, 'iso'));
    expect(depth({ x: 0, y: 30 }, 'iso')).toBeGreaterThan(depth({ x: 0, y: 10 }, 'iso'));
    // Na vista de cima, só o y importa.
    expect(depth({ x: 50, y: 0 }, 'topo')).toBe(depth({ x: 10, y: 0 }, 'topo'));
  });

  it('andar na planta vira uma diagonal na tela', () => {
    expect(screenDir('east', 'iso')).toBe('south-east');
    expect(screenDir('south', 'iso')).toBe('south-west');
    expect(screenDir('north', 'topo')).toBe('north');
  });
});

describe('clique no mapa', () => {
  const sala: Area & { id: string } = { id: 'sala', space: 'plan', x: 0, y: 0, w: 100, h: 100 };
  const pessoa: Area & { id: string } = { id: 'pessoa', space: 'screen', x: 40, y: 10, w: 20, h: 40 };

  it('uma área no chão é testada pela planta, não pela caixa na tela', () => {
    // O canto de cima da caixa da sala na tela fica fora do losango: não é a sala.
    expect(pick([sala], { x: 90, y: 2 }, 'iso')).toBeUndefined();
    expect(pick([sala], toScreen({ x: 50, y: 50 }, 'iso'), 'iso')?.id).toBe('sala');
  });

  it('quem foi desenhado por último (na frente) ganha', () => {
    expect(pick([sala, pessoa], { x: 50, y: 30 }, 'iso')?.id).toBe('pessoa');
    expect(pick([sala, pessoa], { x: 0, y: 50 }, 'iso')?.id).toBe('sala');
  });

  it('na vista de cima, planta e tela são a mesma coisa', () => {
    expect(pick([sala], { x: 90, y: 2 }, 'topo')?.id).toBe('sala');
  });
});
