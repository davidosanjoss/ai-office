# Como contribuir

Valeu por ajudar! Este é o caminho de uma ideia até ela entrar no AI Office.

## 1. Escolha ou abra uma issue

- **Bug:** use o modelo "🐛 Bug" e diga o sistema (Linux, Windows, macOS). Muita coisa muda entre eles.
- **Ideia:** use o modelo "💡 Ideia".
- Vai trabalhar numa issue? **Atribua-se a ela** (botão *Assignees*) para ninguém pegar a mesma coisa. As marcadas `bom-primeiro-issue` são um bom começo.

## 2. Prepare o ambiente

```bash
git clone https://github.com/davidosanjoss/ai-office.git
cd ai-office
npm install
npm test          # tudo deve passar antes de você mexer em algo
```

Para desenvolver com recarga automática: `npm run dev:server` num terminal e `npm run dev:web` em outro, e abra http://localhost:5173.

## 3. Trabalhe numa branch

A `main` é protegida: ninguém sobe direto nela, nem o dono do repositório. Crie uma branch:

```bash
git switch -c tipo/descricao-curta
```

Tipos: `feat/` (funcionalidade), `fix/` (bug), `arte/` (sprites e visual), `docs/`, `teste/`, `infra/`.

## 4. Regras do código

As regras completas estão no [`CLAUDE.md`](CLAUDE.md) (o Claude Code lê esse arquivo sozinho, então quem usa o Claude no projeto já segue o mesmo padrão). O essencial:

- **Rode `npm test` antes de abrir o PR.** Ele compila a interface e roda unidade, integração e ponta a ponta.
- **Bug corrigido ganha teste de regressão**, com o nome começando por `regressão:`. Antes de dar o bug como resolvido, volte o código antigo e confirme que o teste falha.
- **Os testes nunca usam o seu `~/.claude` ou `~/.ai-office`.** Use as pastas temporárias de `test/setup.ts` e o Claude falso de `test/fixtures/fake-claude.mjs`.
- **Windows importa:** caminhos sempre com `path`, nada de `&` em scripts do npm, processos via `ptyCommand`.
- **Segurança:** o servidor dá acesso a shell. Ele escuta só em `127.0.0.1` e checa Host e Origin; não afrouxe isso.
- **Arte:** os sprites vêm do PixelLab. Os originais ficam em `assets/pixellab/`, e `python3 assets/pixellab/montar-sprites.py` gera `web/public/sprites/`. Não edite os arquivos gerados à mão.

## 5. Abra o Pull Request

- Preencha o modelo: o que muda, como testar e o checklist.
- Escreva `Fecha #123` na descrição para a issue fechar sozinha no merge.
- O **CI** roda os testes no Linux e no Windows. O merge só libera com o **CI verde** e **1 aprovação** de outra pessoa (o GitHub não deixa ninguém aprovar o próprio PR).
- O dono do repositório pode fazer o merge dos próprios PRs sem aprovação, mas também só por PR e com o CI verde.
- Revisando o PR de alguém? Baixe e teste: `gh pr checkout 123`.
