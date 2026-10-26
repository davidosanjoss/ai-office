// Sprites do PixelLab (web/public/sprites, montados por assets/pixellab/montar-sprites.py).

export interface Anim {
  img: HTMLImageElement;
  w: number;
  h: number;
  quadros: number;
  /** Linha dos pés dentro do quadro. */
  pesY: number;
  /** Topo da cabeça dentro do quadro: é por ela que o funcionário sentado é posicionado. */
  cabecaY: number;
}

interface Manifest {
  objetos: Record<string, { arquivo: string; w: number; h: number }>;
  pisos: Record<string, { arquivo: string; w: number; h: number }>;
  animacoes: Record<string, { arquivo: string; w: number; h: number; quadros: number; pesY: number; cabecaY: number }>;
}

/** Tons do moletom: cada agente ganha um, para não ficarem todos iguais. */
export const HOODIE_HUES = [215, 0, 135, 280, 30, 175, 330, 55];

export class Sprites {
  objetos = new Map<string, HTMLImageElement>();
  pisos = new Map<string, HTMLImageElement>();
  animacoes = new Map<string, Anim>();
  ready = false;
  private recolored = new Map<string, HTMLCanvasElement>();

  async load(base = 'sprites/'): Promise<void> {
    const manifest = (await (await fetch(`${base}manifest.json`)).json()) as Manifest;
    const img = (file: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error(`sprite não carregou: ${file}`));
        i.src = base + file;
      });
    await Promise.all([
      ...Object.entries(manifest.objetos).map(async ([k, v]) => this.objetos.set(k, await img(v.arquivo))),
      ...Object.entries(manifest.pisos).map(async ([k, v]) => this.pisos.set(k, await img(v.arquivo))),
      ...Object.entries(manifest.animacoes).map(async ([k, v]) => this.animacoes.set(k, { ...v, img: await img(v.arquivo) })),
    ]);
    this.ready = true;
  }

  /**
   * A tira da animação com o moletom (azul no original) trocado para outro tom.
   * Calculado uma vez por animação e tom.
   */
  anim(name: string, hue: number): { anim: Anim; source: CanvasImageSource } | undefined {
    const anim = this.animacoes.get(name);
    if (!anim) return undefined;
    if (hue === HOODIE_HUES[0]) return { anim, source: anim.img };
    const key = `${name}:${hue}`;
    let canvas = this.recolored.get(key);
    if (!canvas) {
      canvas = recolor(anim.img, hue);
      this.recolored.set(key, canvas);
    }
    return { anim, source: canvas };
  }
}

/** Troca o matiz dos pixels azuis saturados (o moletom) por `hue`, mantendo luz e saturação. */
export function recolor(img: HTMLImageElement, hue: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    // Moletom: azul a ~220° com luz ~0,5. A calça tem o mesmo azul, mas escura (~0,3): fica de fora.
    if (h >= 200 && h <= 235 && s > 0.25 && l > 0.38) {
      const [r, g, b] = hslToRgb(hue, s, l);
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
    }
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
