#!/usr/bin/env python3
"""Baixa do PixelLab os pacotes dos personagens listados em fase-*/ids.json.

Cada pacote vira assets/pixellab/personagens/<nome>/{rotations,anim/<animação>/<direção>}.
Depois rode montar-sprites.py para gerar os sprites da interface.

Uso: python3 assets/pixellab/baixar-personagens.py
"""

import io
import json
import shutil
import urllib.request
import zipfile
from pathlib import Path

SRC = Path(__file__).resolve().parent
OUT = SRC / "personagens"


def main() -> None:
    ids: dict[str, str] = {}
    for f in sorted(SRC.glob("fase-*/ids.json")):
        ids.update(json.loads(f.read_text()).get("personagens", {}))
    if not ids:
        raise SystemExit("nenhum personagem em fase-*/ids.json")

    for nome, cid in sorted(ids.items()):
        url = f"https://api.pixellab.ai/mcp/characters/{cid}/download"
        data = urllib.request.urlopen(url, timeout=60).read()
        zf = zipfile.ZipFile(io.BytesIO(data))
        dest = OUT / nome
        shutil.rmtree(dest, ignore_errors=True)
        for item in zf.namelist():
            # O pacote vem como <estado>/rotations/... e <estado>/animations/<anim>/<dir>/frame_NNN.png
            parts = Path(item).parts
            if item.endswith("/") or ".." in parts or item.startswith("/") or len(parts) < 3:
                continue
            if parts[1] == "rotations":
                target = dest / "rotations" / Path(*parts[2:])
            elif parts[1] == "animations":
                target = dest / "anim" / Path(*parts[2:])
            else:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(item))
        anims = sorted(p.name for p in (dest / "anim").iterdir()) if (dest / "anim").exists() else []
        print(f"{nome}: {', '.join(anims) or 'sem animações'}")


if __name__ == "__main__":
    main()
