# AI Office

Um escritório em pixel art para gerenciar várias sessões do Claude Code ao mesmo tempo, numa aba só do navegador.

- Um **prédio de escritório** visto de cima: térreo com **recepção** (e secretária) e **copa**, a rua na frente, e **cada projeto é uma sala** encostada no prédio. **Cada agente é um funcionário** sentado numa mesa.
- Em volta do prédio aparecem vagas com **+**: clique numa, escolha o repositório, e a sala nova nasce ali, liberando novas vagas em volta dela.
- **Andares por empresa:** cada andar é um contexto (a sua empresa, projetos pessoais, freelance…), com as próprias salas e a própria copa. O **painel do elevador** no canto do mapa mostra os andares e quantos agentes precisam de você em cada um; o térreo é a entrada, com a recepção.
- **Sala de guerra**, em cima do elevador de cada andar, para problemas que atravessam projetos (ex.: um 503 que passa pelo gateway e pela fila). Clique nela, abra um incidente e escolha quem entra: um agente novo em cada projeto ou agentes que já estão trabalhando, com o contexto que têm. Eles vão andando até a mesa redonda e conversam com você num chat (`@nome` ou `@projeto` fala com um só). A resposta de um agente só vai para os outros quando você clica em **Compartilhar com a sala**. Ao encerrar, o registro vira post-mortem. Sem incidente, a luz fica apagada; o **+** em cima dela abre outra.
- **Arraste o mapa** para navegar e use a **rodinha** para o zoom (ou os botões + − ⌖ no canto). Quando o foco automático abre um agente de outra sala, a câmera vai até ela.
- O funcionário mostra o que está fazendo: digita quando trabalha, **levanta a mão** quando precisa de aprovação, **comemora** quando termina, e os subagentes aparecem como ajudantes ao lado da mesa.
- Abas de **terminal comum** (`>_`): o seu shell aberto na pasta do projeto, sem Claude, para git, `npm run dev` etc.
- Cada agente tem o próprio **terminal** (o Claude Code de verdade, com sua conta), em **abas** por sala.
- Quando um agente termina ou pede aprovação, o escritório **abre o terminal de quem terminou primeiro**, assim que você não estiver digitando em outro.
- Barra lateral com **git** (branch, arquivos modificados, commits) e o **feed de atividade**.
- Opção de colocar cada agente num **git worktree** com branch própria, para vários agentes mexerem no mesmo repo sem conflito. Quando ele termina, o painel de git **abre o PR** (push + `gh pr create`, com título e descrição sugeridos pelos commits), **traz o trabalho para a branch da sala** (merge local, que avisa antes se daria conflito) e **encerra o worktree** (a branch só pode ser apagada se o trabalho já estiver na sala ou no GitHub).

Tudo roda localmente: o servidor escuta só em `127.0.0.1`.

A arte (funcionários, móveis, piso, árvores) foi gerada no [PixelLab](https://www.pixellab.ai); os originais e os IDs ficam em `assets/pixellab/`, e `python3 assets/pixellab/montar-sprites.py` monta o pacote usado pela interface em `web/public/sprites/`.

## Requisitos

- [Node.js](https://nodejs.org) 20 ou mais novo
- [Claude Code](https://docs.claude.com/claude-code) instalado e logado (o comando `claude` precisa funcionar no terminal)
- Git (opcional, para o painel de git e os worktrees)
- [GitHub CLI](https://cli.github.com) (`gh`, opcional, para abrir PRs dos worktrees; rode `gh auth login` uma vez)

Funciona em Linux, macOS e Windows. Não precisa de compilador: o terminal usa binários prontos.

## Como usar

```bash
npm install
npm start
```

Abra <http://localhost:7420>.

1. Clique num **+** ao lado do prédio (ou em **+ Sala**, que escolhe uma vaga sozinho) e escolha a pasta do projeto, digitando, pelas sugestões das pastas onde você já usou o Claude Code ou com **📁 Procurar…**.
2. Clique na mesa com **+** (ou no **+** das abas) para contratar um agente.
3. Clique num funcionário ou numa aba para abrir o terminal dele.

Para virar uma janela própria, sem barra de abas (e com os atalhos indo para o terminal), abra como app:

```bash
# Linux
google-chrome --app=http://localhost:7420
# Windows (PowerShell)
start msedge --app=http://localhost:7420
```

Ou, no Chrome/Edge, menu ⋮ → *Transmitir, salvar e compartilhar* → *Instalar página como app*.

### Atalhos

| Atalho | Ação |
|---|---|
| `Alt+1` … `Alt+9` | Ir para a aba N da sala |
| `Alt+T` | Abrir um terminal comum na sala |
| `Alt+PageUp` / `Alt+PageDown` | Subir / descer um andar |
| `Alt+N` | Ir para o próximo agente que terminou ou pede aprovação |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copiar / colar no terminal |

O botão 🔔 ativa notificações do sistema para quando a aba estiver em segundo plano.

## Como funciona

```
navegador (escritório + xterm.js)  ⇄  WebSocket  ⇄  servidor Node (Fastify + node-pty)
                                                         │ abre cada agente como `claude --settings <hooks>`
                                                         ▼
                                     hooks do Claude Code → POST /api/hook → estado do personagem
```

- Cada agente é um processo `claude` num pseudo-terminal controlado pelo servidor. Fechar o navegador não encerra os agentes; encerrar o servidor encerra.
- Os hooks entram só nas sessões abertas pelo escritório, via `--settings`. O seu `~/.claude/settings.json` não é alterado.
- Cada agente recebe um `--session-id` fixo. Se o servidor reiniciar, o agente aparece como "fora do escritório" e o botão **Retomar conversa** roda `claude --resume` com a mesma sessão.
- Os dados do escritório ficam em `~/.ai-office` (`state.json`, os worktrees em `worktrees/` e o registro de cada incidente da sala de guerra em `incidentes/`).
- Na sala de guerra, o escritório digita no terminal de cada agente o convite e as suas mensagens (sempre numa linha só; o briefing completo fica no registro em markdown) e lê a resposta do transcript quando o hook `Stop` chega. Mensagem para quem está ocupado espera ele terminar.

### Configuração

| Variável | Padrão | |
|---|---|---|
| `AI_OFFICE_PORT` | `7420` | Porta do servidor |
| `AI_OFFICE_DATA` | `~/.ai-office` | Onde guardar estado e worktrees |

## Desenvolvimento

Quer ajudar? Veja o [CONTRIBUTING.md](CONTRIBUTING.md): issues, branches, testes e Pull Requests.

```bash
npm run dev:server   # servidor com reload (porta 7420)
npm run dev:web      # frontend com HMR em http://localhost:5173
npm run typecheck
npm test             # compila a interface e roda todos os testes
npm run test:watch   # testes em modo watch
```

### Testes

Os testes nunca tocam no seu `~/.claude` nem no `~/.ai-office`: cada arquivo roda em pastas temporárias e usa um **Claude falso** (`test/fixtures/fake-claude.mjs`). Ele aceita os mesmos argumentos que o real, dispara os hooks de verdade, grava o histórico só depois da primeira mensagem e dá o mesmo erro no `--resume` sem histórico.

| Arquivo | O que cobre |
|---|---|
| `platform`, `agents-unit`, `discover`, `git`, `hooks`, `store`, `picker-browser` | Cada módulo do servidor isolado |
| `web-logic`, `building`, `diff`, `sprites` | Fila de atenção, foco automático, planta do prédio e câmera, leitura de diff, pacote de sprites |
| `server` | Integração: HTTP, WebSocket, processos reais em PTY, hooks pelo script de produção |
| `e2e` | A interface num Chrome/Chromium/Edge headless, clicando e digitando. Pula se não achar navegador (defina `CHROME_PATH`) |

**Regra para bugs:** todo bug corrigido ganha um teste com o nome começando por `regressão:`. O teste precisa falhar com o código antigo; confira isso antes de dar o bug como resolvido. Para listar só esses testes: `npx vitest run -t regressão`.

Estrutura:

- `server/`: servidor (PTYs, hooks, git, descoberta de projetos)
- `web/`: frontend (`office.ts` desenha o escritório, `terminals.ts` cuida dos xterms, `main.ts` amarra tudo)
- `shared/types.ts`: tipos usados nos dois lados
- `hooks/office-hook.mjs`: script que o Claude Code chama em cada evento
