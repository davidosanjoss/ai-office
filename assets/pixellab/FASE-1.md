# PixelLab: fase 1 (aprovada, cerca de 9 gerações)

Objetivo: testar o estilo do escritório parecido com a referência (prédio visto de cima, estilo RPG)
antes de gerar o resto. Tudo em **vista "low top-down"**, contorno escuro e sombreamento simples, para
combinar entre si.

Salve cada resultado em `assets/pixellab/fase-1/` com o nome indicado. Os objetos de mapa somem do
PixelLab depois de 8 horas: baixe logo após gerar. Anote o saldo antes e depois para medirmos o custo.

## 1. Personagem base (1 geração)

`create_character`
- description: `friendly office worker, casual blue hoodie, short brown hair, jeans, sneakers`
- n_directions: `4`
- size: `48`
- view: `low top-down`
- outline: `single color black outline`, shading: `basic shading`, detail: `medium detail`

Salvar: `personagem/{south,east,north,west}.png`, e anotar o `character_id`.

## 2 a 4. Animações do personagem (3 gerações)

`animate_character` com o `character_id` acima:

| # | Animação | Parâmetro | Salvar em |
|---|---|---|---|
| 2 | parado, respirando | template `breathing-idle` | `personagem/anim/parado/{direção}/frame_N.png` |
| 3 | digitando sentado | ação: `sitting at a desk typing on a keyboard` | `personagem/anim/digitando/...` |
| 4 | levantando a mão | ação: `raising one hand up high to ask a question, waving` | `personagem/anim/mao/...` |

## 5. Piso (1 geração)

`create_topdown_tileset`
- lower: `green grass lawn`
- upper: `light wooden office floor planks`
- tile size: `32`

Salvar: `piso/tileset.png` e o JSON/metadata do Wang tileset em `piso/tileset.json`.

## 6 a 9. Objetos (4 gerações)

`create_map_object`, todos com view `low top-down`, fundo transparente:

| # | Descrição | Tamanho | Salvar |
|---|---|---|---|
| 6 | `office desk with a computer monitor and keyboard, wooden top` | 64×48 | `objetos/mesa.png` |
| 7 | `black office swivel chair` | 32×32 | `objetos/cadeira.png` |
| 8 | `potted green plant in a terracotta pot` | 32×32 | `objetos/planta.png` |
| 9 | `round leafy green tree` | 64×64 | `objetos/arvore.png` |

## Depois

Com os arquivos em `assets/pixellab/fase-1/`, o AI Office troca a arte desenhada por código pelos
sprites (o que faltar continua com a arte antiga) e você decide sobre a fase 2.
