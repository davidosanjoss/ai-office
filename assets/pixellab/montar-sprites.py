#!/usr/bin/env python3
"""Monta os sprites do PixelLab (assets/pixellab/fase-*) no formato que a interface usa.

Saída em web/public/sprites/: um PNG por objeto, os ladrilhos de piso, uma tira horizontal por
animação e o manifest.json com o tamanho dos quadros e o ponto dos pés (âncora) de cada uma.

Uso: python3 assets/pixellab/montar-sprites.py   (precisa do Pillow)
"""

import colorsys
import json
import os
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets" / "pixellab" / "fase-1"
OUT = ROOT / "web" / "public" / "sprites"

# Quais quadros de cada animação entram no loop. "digitando" saiu do PixelLab como
# sentar → digitar → levantar; só os quadros do meio são o personagem digitando.
ANIMACOES = {
    "parado": None,
    "digitando": [3, 4, 5, 6],
    "mao": [2, 3, 4, 5, 6, 7],
}


def is_wood(rgb) -> bool:
    h, l, _ = colorsys.rgb_to_hls(*(v / 255 for v in rgb))
    return h * 360 < 60 and l > 0.55


def is_grass(rgb) -> bool:
    h, _, s = colorsys.rgb_to_hls(*(v / 255 for v in rgb))
    return 80 < h * 360 < 160 and s > 0.3


def pure_tile(sheet: Image.Image, terreno, n: int = 32) -> Image.Image:
    """
    Quadrado n×n só do terreno pedido, em qualquer posição da folha, escolhendo o que melhor
    se repete lado a lado (borda esquerda parecida com a direita, a de cima com a de baixo).
    Não usamos a metadata do PixelLab: na fase 1 os cantos dela não batiam com a imagem.
    """
    rgb = sheet.convert("RGB")
    W, H = rgb.size
    px = rgb.load()
    ok = [[1 if terreno(px[x, y]) else 0 for x in range(W)] for y in range(H)]
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
        raise SystemExit(f"nenhum quadrado {n}x{n} só de {terreno.__name__} na folha")
    _, x, y = min(candidates)
    return sheet.crop((x, y, x + n, y + n))


def feet_y(frames: list[Image.Image]) -> int:
    """Última linha com pixel visível em qualquer quadro: onde ficam os pés."""
    return max(f.getbbox()[3] for f in frames if f.getbbox())


def head_y(frames: list[Image.Image]) -> int:
    """Topo da cabeça (mediana dos quadros, para um braço levantado não puxar)."""
    tops = sorted(f.getbbox()[1] for f in frames if f.getbbox())
    return tops[len(tops) // 2]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict = {"objetos": {}, "pisos": {}, "animacoes": {}}

    for f in sorted((SRC / "objetos").glob("*.png")):
        img = Image.open(f).convert("RGBA")
        img.save(OUT / f.name)
        manifest["objetos"][f.stem] = {"arquivo": f.name, "w": img.width, "h": img.height}

    sheet = Image.open(SRC / "piso" / "tileset.png").convert("RGBA")
    for nome, terreno in (("grama", is_grass), ("madeira", is_wood)):
        t = pure_tile(sheet, terreno)
        t.save(OUT / f"{nome}.png")
        manifest["pisos"][nome] = {"arquivo": f"{nome}.png", "w": t.width, "h": t.height}

    base = SRC / "personagem"
    for nome, escolha in ANIMACOES.items():
        pasta = base / "anim" / nome / "south"
        todos = [Image.open(pasta / f).convert("RGBA") for f in sorted(os.listdir(pasta))]
        frames = [todos[i] for i in escolha] if escolha else todos
        w, h = frames[0].size
        strip = Image.new("RGBA", (w * len(frames), h))
        for i, fr in enumerate(frames):
            strip.alpha_composite(fr, (i * w, 0))
        strip.save(OUT / f"funcionario-{nome}.png")
        manifest["animacoes"][nome] = {
            "arquivo": f"funcionario-{nome}.png",
            "w": w,
            "h": h,
            "quadros": len(frames),
            "pesY": feet_y(frames),
            "cabecaY": head_y(frames),
        }

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"sprites em {OUT.relative_to(ROOT)}: {len(list(OUT.glob('*.png')))} imagens")


if __name__ == "__main__":
    main()
