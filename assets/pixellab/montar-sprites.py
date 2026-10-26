#!/usr/bin/env python3
"""Monta os sprites do PixelLab (assets/pixellab/) no formato que a interface usa.

Entrada:
  personagens/<nome>/anim/<animação>/<direção>/frame_NNN.png   (pacotes baixados do PixelLab)
  objetos/*.png                                                 (todos os objetos, das duas fases)
  fase-*/piso*/tileset.png                                      (tilesets: grama + outro terreno)

Saída em web/public/sprites/: uma tira horizontal por animação de cada personagem, um PNG por
objeto, um ladrilho por piso e o manifest.json com tamanho dos quadros, pés e cabeça.

Uso: python3 assets/pixellab/montar-sprites.py   (precisa do Pillow)
"""

import colorsys
import json
import os
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets" / "pixellab"
OUT = ROOT / "web" / "public" / "sprites"

# Quais quadros de cada animação entram no loop. As do PixelLab vêm com o começo e o fim
# do movimento (sentar → digitar → levantar; braços subindo → descendo): o loop usa só o meio.
QUADROS = {
    "parado": None,
    "digitando": [3, 4, 5, 6],
    "mao": [2, 3, 4, 5, 6, 7],
    "comemorando": [3, 4, 5, 6, 7, 8],
    "andar": None,
}

# Pisos: (nome, tileset de origem, o que conta como o terreno).
PISOS = [
    ("grama", "fase-1/piso/tileset.png", "grama"),
    ("madeira", "fase-1/piso/tileset.png", "outro"),
    ("corredor", "fase-2/piso-corredor/tileset.png", "outro"),
    ("copa", "fase-2/piso-copa/tileset.png", "outro"),
]


def is_grass(rgb) -> bool:
    h, _, s = colorsys.rgb_to_hls(*(v / 255 for v in rgb))
    return 80 < h * 360 < 160 and s > 0.3


def pure_tile(sheet: Image.Image, want_grass: bool, n: int = 32) -> Image.Image:
    """
    Quadrado n×n só de um terreno, em qualquer posição da folha, escolhendo o que melhor se
    repete lado a lado (borda esquerda parecida com a direita, a de cima com a de baixo).
    Não usamos a metadata do PixelLab: na fase 1 os cantos dela não batiam com a imagem.
    """
    rgb = sheet.convert("RGB")
    W, H = rgb.size
    px = rgb.load()
    ok = [[1 if is_grass(px[x, y]) == want_grass else 0 for x in range(W)] for y in range(H)]
    acc = [[0] * (W + 1) for _ in range(H + 1)]
    for y in range(H):
        for x in range(W):
            acc[y + 1][x + 1] = ok[y][x] + acc[y][x + 1] + acc[y + 1][x] - acc[y][x]

    def seam(x0: int, y0: int) -> int:
        diff = lambda a, b: sum(abs(i - j) for i, j in zip(a, b))
        horiz = sum(diff(px[x0, y0 + i], px[x0 + n - 1, y0 + i]) for i in range(n))
        vert = sum(diff(px[x0 + i, y0], px[x0 + i, y0 + n - 1]) for i in range(n))
        return horiz + vert

    candidates = [
        (seam(x, y), x, y)
        for y in range(H - n + 1)
        for x in range(W - n + 1)
        if acc[y + n][x + n] - acc[y][x + n] - acc[y + n][x] + acc[y][x] == n * n
    ]
    if not candidates:
        raise SystemExit(f"nenhum quadrado {n}x{n} só de {'grama' if want_grass else 'piso'} na folha")
    _, x, y = min(candidates)
    return sheet.crop((x, y, x + n, y + n))


def feet_y(frames: list[Image.Image]) -> int:
    """Última linha com pixel visível em qualquer quadro: onde ficam os pés."""
    return max(f.getbbox()[3] for f in frames if f.getbbox())


def head_y(frames: list[Image.Image]) -> int:
    """Topo da cabeça (mediana dos quadros, para um braço levantado não puxar)."""
    tops = sorted(f.getbbox()[1] for f in frames if f.getbbox())
    return tops[len(tops) // 2]


def strip(frames: list[Image.Image]) -> Image.Image:
    w, h = frames[0].size
    out = Image.new("RGBA", (w * len(frames), h))
    for i, fr in enumerate(frames):
        out.alpha_composite(fr, (i * w, 0))
    return out


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "personagens").mkdir(parents=True)
    manifest: dict = {"objetos": {}, "pisos": {}, "personagens": {}}

    for f in sorted((SRC / "objetos").glob("*.png")):
        img = Image.open(f).convert("RGBA")
        img.save(OUT / f.name)
        manifest["objetos"][f.stem] = {"arquivo": f.name, "w": img.width, "h": img.height}

    for nome, origem, terreno in PISOS:
        t = pure_tile(Image.open(SRC / origem).convert("RGBA"), terreno == "grama")
        t.save(OUT / f"{nome}.png")
        manifest["pisos"][nome] = {"arquivo": f"{nome}.png", "w": t.width, "h": t.height}

    for pasta in sorted((SRC / "personagens").iterdir()):
        if not pasta.is_dir():
            continue
        anims = {}
        for anim, escolha in QUADROS.items():
            base = pasta / "anim" / anim
            if not base.exists():
                continue
            for direcao in sorted(os.listdir(base)):
                arquivos = sorted(os.listdir(base / direcao))
                todos = [Image.open(base / direcao / a).convert("RGBA") for a in arquivos]
                frames = [todos[i] for i in escolha if i < len(todos)] if escolha else todos
                # Só o andar tem direções; as outras são de frente e ficam sem sufixo.
                chave = f"{anim}-{direcao}" if anim == "andar" else anim
                arquivo = f"personagens/{pasta.name}-{chave}.png"
                strip(frames).save(OUT / arquivo)
                anims[chave] = {
                    "arquivo": arquivo,
                    "w": frames[0].width,
                    "h": frames[0].height,
                    "quadros": len(frames),
                    "pesY": feet_y(frames),
                    "cabecaY": head_y(frames),
                }
        manifest["personagens"][pasta.name] = anims

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    total = len(list(OUT.rglob("*.png")))
    print(f"sprites em {OUT.relative_to(ROOT)}: {total} imagens, {len(manifest['personagens'])} personagens")


if __name__ == "__main__":
    main()
