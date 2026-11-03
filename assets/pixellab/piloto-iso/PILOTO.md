# PixelLab: piloto do mapa isométrico (7 gerações, 243,11 → 236,11)

Objetivo: ver se a arte do PixelLab encaixa num escritório isométrico antes de gerar o pacote todo.

| O quê | Ferramenta | ID | Resultado |
|---|---|---|---|
| funcionario-1 em 8 direções | `create_character` v3, referência = `south` do funcionario-1 original, `east/north/west` dados prontos | `a8f5031c-24f7-410b-a44d-0fff73f6c62a` | Bom: as 4 diagonais saíram no mesmo estilo (1 geração) |
| digitando na diagonal | `animate_character` v3, `south-west`, "sitting on a chair typing quickly on a keyboard" | grupo `0aa6bc07-5bc0-4bd2-bdf2-79d7b594ea43` | Bom, já vem com a cadeira (1 geração) |
| mesa isométrica | `create_map_object` 96×80, `high top-down`, "monitor seen from behind" | `ae988839-3387-4abc-91fe-3a9e68ee464d` | Bom: `objetos/mesa-iso.png` |
| mesa (1ª tentativa) | igual, sem pedir o monitor de costas | `462c900f-6167-4b80-87c4-4fa4747de7a5` | Monitor virado para quem olha: descartada |
| piso de madeira | `create_isometric_tile` thin 32 px, seeds 7420 e 1337 | `89d12a80-…`, `e4d3affb-…` | Saiu rosado, com cara de tijolo, nas duas: descartado |
| grama | `create_isometric_tile` thin 32 px | `ca4d8b36-0e26-4906-a7b9-9c0a45985270` | Folhas para fora e espessura: não repete bem |

Conclusões:

- **Pisos:** os ladrilhos de cima que já temos (`madeira`, `grama`, `corredor`, `copa`) são desenhados
  deitados com a matriz da projeção, que é exatamente como um piso quadrado aparece em isométrico.
  Não precisam de geração nova.
- **Personagens:** rotacionar os que já existem (v3 com referência e as 4 direções prontas) custa 1
  geração cada e mantém a identidade. Cada animação nova numa diagonal custa 1 por direção.
- **Móveis:** `create_map_object` em `high top-down` pedindo "isometric … at a 45 degree angle" sai
  isométrico de verdade; vale descrever para onde o monitor vira.

`python3 assets/pixellab/montar-sprites.py` monta `mesa-iso` e `funcionario-1/digitando-south-west`.
