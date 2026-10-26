// Sprites do PixelLab (web/public/sprites, montados por assets/pixellab/montar-sprites.py).

export interface Anim {
  img: HTMLImageElement;
  w: number;
  h: number;
  quadros: number;
  /** Linha dos pés dentro do quadro: é por ela que quem anda é posicionado. */
  pesY: number;
  /** Topo da cabeça dentro do quadro: é por ela que o funcionário sentado é posicionado. */
  cabecaY: number;
}

type AnimMeta = Omit<Anim, 'img'> & { arquivo: string };

export interface Manifest {
  objetos: Record<string, { arquivo: string; w: number; h: number }>;
  pisos: Record<string, { arquivo: string; w: number; h: number }>;
  /** Animações de cada personagem: parado, digitando, mao, comemorando, andar-<direção>. */
  personagens: Record<string, Record<string, AnimMeta>>;
}

/** A secretária da recepção sempre é a mesma personagem. */
export const RECEPCIONISTA = 'funcionaria-8';

/**
 * Personagem de um agente: sempre o mesmo para o mesmo agente (sorteado pelo ID), nunca a
 * recepcionista, que fica no balcão.
 */
export function characterFor(seed: number, names: string[]): string | undefined {
  const pool = names.filter((n) => n !== RECEPCIONISTA);
  const list = pool.length ? pool : names;
  return list.length ? list[seed % list.length] : undefined;
}

export class Sprites {
  objetos = new Map<string, HTMLImageElement>();
  pisos = new Map<string, HTMLImageElement>();
  personagens = new Map<string, Map<string, Anim>>();
  ready = false;

  async load(base = 'sprites/'): Promise<void> {
    const manifest = (await (await fetch(`${base}manifest.json`)).json()) as Manifest;
    const img = (file: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error(`sprite não carregou: ${file}`));
        i.src = base + file;
      });
    const jobs: Promise<unknown>[] = [
      ...Object.entries(manifest.objetos).map(async ([k, v]) => this.objetos.set(k, await img(v.arquivo))),
      ...Object.entries(manifest.pisos).map(async ([k, v]) => this.pisos.set(k, await img(v.arquivo))),
    ];
    for (const [nome, anims] of Object.entries(manifest.personagens)) {
      const map = new Map<string, Anim>();
      this.personagens.set(nome, map);
      for (const [k, v] of Object.entries(anims)) {
        jobs.push(img(v.arquivo).then((i) => map.set(k, { ...v, img: i })));
      }
    }
    await Promise.all(jobs);
    this.ready = true;
  }

  names(): string[] {
    return [...this.personagens.keys()];
  }

  /** Animação de um personagem; cai em "parado" se ele não tiver a pedida. */
  anim(character: string | undefined, name: string): Anim | undefined {
    const anims = character ? this.personagens.get(character) : undefined;
    return anims?.get(name) ?? anims?.get('parado');
  }
}
