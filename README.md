# AI Office

Um escritório em pixel art para gerenciar várias sessões do Claude Code ao mesmo tempo, numa aba só do navegador.

- Um **prédio de escritório** visto de cima: térreo com **recepção** (e secretária) e **copa**, a rua na frente, e **cada projeto é uma sala** encostada no prédio. **Cada agente é um funcionário** sentado numa mesa.
- Em volta do prédio aparecem vagas com **+**: clique numa, escolha o repositório, e a sala nova nasce ali, liberando novas vagas em volta dela.
- **Andares por empresa:** cada andar é um contexto (a sua empresa, projetos pessoais, freelance…), com as próprias salas e a própria copa. O **painel do elevador** no canto do mapa mostra os andares e quantos agentes precisam de você em cada um; o térreo é a entrada, com a recepção. No **✎** do elevador, cada andar tem os **padrões dos agentes**: desligar a co-autoria do Claude nos commits e PRs e dar instruções que valem para todos os agentes do andar (ex.: commits resumidos num andar de cliente). Valem para quem é contratado ou volta ao trabalho depois de salvar.
- **Conversa grande sem pagar a releitura:** quando a conversa de um agente passa de 500 mil tokens, ao terminar um pedido (com o cache ainda valendo) ele grava as decisões, o que foi feito e o que falta em `~/.ai-office/contexto/<agente>.md` (e no ai-memory, se estiver instalado). Na volta, com o cache de 1 h expirado, o escritório mostra o custo de cada caminho e sugere uma **sessão nova com resumo**: ela começa com um dossiê montado sem gastar modelo (o que foi gravado, últimos pedidos, tarefas abertas, última resposta, branch e arquivos alterados) e o caminho do transcript antigo, para buscar um detalhe com grep. Retomar a conversa inteira continua possível. Nos padrões do andar: avisar (padrão), automático ou desligado. A regra fica em `shared/context.ts`.
- **Sala de guerra**, em cima do elevador de cada andar, para problemas que atravessam projetos (ex.: um 503 que passa pelo gateway e pela fila). Clique nela, abra um incidente e escolha quem entra: um agente novo em cada projeto ou agentes que já estão trabalhando, com o contexto que têm. Eles vão andando até a mesa redonda e conversam com você num chat: `@nome` ou `@projeto` fala com um só, e ao digitar `@` aparecem as sugestões de quem está na sala. No chat, a resposta de cada agente vira um card com quem respondeu: você lê no terminal dele (clicando no nome) e decide se clica em **Compartilhar com a sala**. Um terminal comum da sala de guerra já abre junto, na pasta do primeiro projeto que entrou (`>_` ou `Alt+T` abrem mais). Ao encerrar, o registro vira post-mortem. Sem incidente, a luz fica apagada; o **+** em cima dela abre outra.
- **Arraste o mapa** para navegar e use a **rodinha** para o zoom (ou os botões + − ⌖ no canto). Quando o foco automático abre um agente de outra sala, a câmera vai até ela.
- O funcionário mostra o que está fazendo: digita quando trabalha, **levanta a mão** quando precisa de aprovação, **comemora** quando termina, e os subagentes aparecem como ajudantes ao lado da mesa.
- Abas de **terminal comum** (`>_`): o seu shell aberto na pasta do projeto, sem Claude, para git, `npm run dev` etc.
- Cada agente tem o próprio **terminal** (o Claude Code de verdade, com sua conta), em **abas** por sala.
- Quando um agente termina ou pede aprovação, o escritório **abre o terminal de quem terminou primeiro**, assim que você não estiver digitando em outro.
- Barra lateral com **git** (branch, arquivos modificados, commits) e o **feed de atividade**.
- Opção de colocar cada agente num **git worktree** com branch própria, para vários agentes mexerem no mesmo repo sem conflito. Quando ele termina, o painel de git **abre o PR** (push + `gh pr create`, com título e descrição sugeridos pelos commits), **traz o trabalho para a branch da sala** (merge local, que avisa antes se daria conflito) e **encerra o worktree** (a branch só pode ser apagada se o trabalho já estiver na sala ou no GitHub).
- **Memória dos agentes** com o [ai-memory](https://github.com/akitaonrails/ai-memory) (opcional): o indicador no topo mostra se ela está ligada e instala com um clique (veja [Memória dos agentes](#memória-dos-agentes-ai-memory)).

Tudo roda localmente: o servidor escuta só em `127.0.0.1`.

A arte (funcionários, móveis, piso, árvores) foi gerada no [PixelLab](https://www.pixellab.ai); os originais e os IDs ficam em `assets/pixellab/`, e `python3 assets/pixellab/montar-sprites.py` monta o pacote usado pela interface em `web/public/sprites/`.

## Requisitos

- [Node.js](https://nodejs.org) 20 ou mais novo
- [Claude Code](https://docs.claude.com/claude-code) instalado e logado (o comando `claude` precisa funcionar no terminal)
- Git (opcional, para o painel de git e os worktrees)
- [GitHub CLI](https://cli.github.com) (`gh`, opcional, para abrir PRs dos worktrees; rode `gh auth login` uma vez)
- [Docker](https://docs.docker.com/get-docker/) (opcional, para a memória dos agentes)

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

### Celular, tablet e telas grandes

- **Celular e tablet**: a lista de salas (☰) e o painel da direita (⇥) viram gavetas por cima da tela. No celular, a barra de cima e os botões das abas ficam só com ícones, e o elevador mostra só o andar atual (toque nele para ver os outros). Dois dedos no mapa dão zoom.
- **Telas de toque**: com um terminal aberto, aparece uma barra com as teclas que o teclado da tela não tem (Esc, Tab, Shift+Tab, setas, Ctrl+C e Enter).
- **4K e ultrawide**: em telas altas com pouca densidade (um 4K a 100%), a barra, os painéis, os diálogos e a letra dos terminais crescem sozinhos (1,25× a partir de ~1500 px de altura, 1,5× a partir de ~1900 px). Com a escala do sistema em 200%, nada muda: ela já faz isso.

### Atalhos

| Atalho | Ação |
|---|---|
| `Alt+1` … `Alt+9` | Ir para a aba N da sala |
| `Alt+T` | Abrir um terminal comum na sala |
| `Alt+PageUp` / `Alt+PageDown` | Subir / descer um andar |
| `Alt+N` | Ir para o próximo agente que terminou ou pede aprovação |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copiar / colar no terminal |

O botão 🔔 ativa notificações do sistema para quando a aba estiver em segundo plano.

### Memória dos agentes (ai-memory)

Sem memória, cada sessão do Claude começa do zero. O [ai-memory](https://github.com/akitaonrails/ai-memory) guarda o que os agentes fazem em cada projeto (limpando dados sensíveis antes) e entrega um resumo no começo da próxima sessão. Funciona sem chave de API.

Clique em **Memória** no topo. Em Linux e macOS, com o Docker instalado, o botão **Instalar**:

1. baixa a imagem do ai-memory numa **versão fixa** (atualizar é uma decisão, não acontece sozinho);
2. cria a pasta dos dados com um **token**: sem ele, qualquer página aberta no navegador leria a memória;
3. sobe o servidor só para esta máquina (`127.0.0.1:49374`), religando sozinho com o computador;
4. instala o comando `ai-memory` (conferido pelo checksum) e liga **hooks e MCP no Claude Code**.

**Atualizar**: quando o escritório passa a fixar uma versão nova, o indicador mostra **Memória: atualizar**. O botão **Atualizar** para o servidor, guarda uma cópia da pasta dos dados ao lado dela (`ai-memory.antes-<versão>-<data>`; as migrações do banco só andam para frente, e voltar de versão precisa dessa cópia), sobe o container com a imagem nova e fixa a mesma versão no MCP (sem isso, o wrapper usaria a `latest`). O cliente dos hooks do ai-memory se atualiza sozinho e não é controlado pelo escritório.

Os hooks valem para **todas** as sessões do Claude na máquina, não só as do escritório. **Desinstalar** tira hooks, MCP e o container e mantém os dados.

Os dados ficam na pasta padrão do ai-memory, **fora deste repositório**: `~/.local/share/ai-memory` no Linux e `~/Library/Application Support/ai-memory` no macOS. O mesmo existe pelo terminal: `npm run memoria:up`, `npm run memoria:down` e `npm run memoria:status`.

No **Windows**, o escritório mostra se a memória está ligada e, em vez de instalar sozinho, mostra os comandos do PowerShell (com o Docker Desktop) para colar.

Se você usar o comando `ai-memory` direto no terminal (`ai-memory status`, `ai-memory search`…), defina `AI_MEMORY_DATA_DIR` com a pasta dos dados: sem ela, o wrapper do Docker procura um volume que não é o nosso. Para religar hooks e MCP, use o **Instalar** do escritório (ou `npm run memoria:up`), que já passa isso.

### Responder pedidos pelo escritório

Quando um agente pede permissão ("posso rodar `npm test`?") ou faz uma pergunta, aparece um cartão em cima do terminal dele, no computador ou no celular: **Permitir**, **Permitir e não perguntar de novo** (com a regra que o Claude Code sugeriu), **Negar…** (com um motivo, que vai para o agente, e a opção de interrompê-lo) ou **Responder no terminal**. Nas perguntas, você escolhe as opções ou escreve outra resposta. O terminal continua perguntando ao mesmo tempo, e vale o que for respondido primeiro. Funciona por um hook `PermissionRequest` só nas sessões do escritório; sem nenhuma página do escritório aberta, ou sem resposta em 5 minutos, o pedido fica só no terminal.

### Meu dia, relatório e detalhes do agente

- **📊 → Meu dia**: quanto tempo os agentes trabalharam e quanto **esperaram você** (pedindo permissão ou resposta, e terminados sem você ver), por hora e por projeto, e as esperas mais longas. É tempo de agente (dois agentes numa hora contam duas) e só conta o que acontece com o escritório ligado: a linha do tempo fica em `~/.ai-office/dia/`.
- **📊 → Relatório**: o que foi feito em cada projeto no dia escolhido: os seus pedidos (dos transcripts do Claude Code), os commits, os eventos do GitHub, o tempo e os tokens. **Resumir com o Claude** gera um resumo curto com o `claude -p` (modelo Haiku, no seu plano), só quando você pede, e guarda para não gastar de novo.
- **Detalhes do agente** (painel da direita, com o agente selecionado): estado, pedido atual, tarefas com o progresso (do `TodoWrite`), ajudantes, modelo, branch, o que está alterado na pasta dele e os tokens e o custo da sessão.

### Sala viva

- **GitHub**: quando um agente abre ou faz merge de um PR, publica uma release ou vê o CI verde, cai confete na sala com uma faixa ("PR #12 aberto!"); com o CI vermelho, a sala avermelha e as sirenes piscam nos cantos até o CI ficar verde (ou por 10 minutos). Vem dos comandos que o agente rodou (`gh pr create`, `gh pr merge`, `gh release create`, `gh run watch`, `gh pr checks`, `git push`), sem token nem internet. Os PRs abertos pelo painel de worktree também contam.
- **Esperando o shell**: quem termina a vez deixando um comando rodando em segundo plano fica na mesa com a ampulheta, o tempo e a fase da espera (🍿, depois 😒 aos 3 min, 🕸️ aos 10 min e 💤 aos 25 min). Quando o comando acaba, comemora (🎉) ou ganha uma nuvem de chuva (🌧️), conforme o código de saída que o Claude Code grava no transcript.
- **Luzes**: a sala sem ninguém ativo fica com a luz apagada; de noite (19h às 6h), as salas acesas ganham luz quente, e o céu e as janelas seguem a hora.

### Modelos por projeto

No painel da direita, **Modelos** escolhe com que modelo os agentes de cada projeto trabalham:

- **Padrão da conta**: o que o seu Claude Code já usa.
- **Um modelo**: um alias (`opus`, `sonnet`, `haiku`, `fable`, `sonnet[1m]`) ou o nome completo (`claude-opus-5-5`).
- **Raciocínio + execução**: um modelo para o modo de planejamento e outro para executar. Usa o `opusplan` do Claude Code, trocando com `ANTHROPIC_DEFAULT_OPUS_MODEL` e `ANTHROPIC_DEFAULT_SONNET_MODEL` o que cada alias quer dizer.

A escolha vale para quem abre ou retoma a conversa; o painel avisa quem ainda está com os modelos antigos.

### Consumo de tokens

O **📊 Consumo** no topo mostra os tokens e o **equivalente na API** (pelos preços da tabela, que você edita) por sala e projeto, por dia, por modelo e na **janela atual do plano** (5 horas). A linha "Janela do plano" no painel da direita mostra quanto o projeto escolhido gastou nela. A janela é uma estimativa: o limite oficial não aparece nos transcripts.

- **Uso oficial do plano** (Pro, Max, Ultra): as sessões abertas pelo escritório usam uma statusline própria (só nelas, pelo `--settings`), por onde o Claude Code entrega a porcentagem usada da janela de 5 horas e da semana e quando cada uma reinicia. O painel mostra esses números; sem eles (antes da primeira resposta, ou numa conta da API), mostra a estimativa. Se você tem uma statusline sua, ela continua aparecendo nessas sessões: o escritório a roda com o mesmo JSON.
- O Claude Code entra sozinho: o escritório lê os transcripts de `~/.claude/projects` aos poucos (só o que foi acrescentado) e guarda um índice em `~/.ai-office/uso`.
- Outras fontes (Codex, Gemini, um script seu) entram pela rota `POST /api/uso` ou por arquivos `.jsonl` em `~/.ai-office/uso/entrada`, no formato `UsageRecord` de `shared/usage.ts`. A pasta (`cwd`) liga o consumo à sala e ao projeto.

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

## Versões e releases

Cada mudança que entra na `main`, com o CI verde, vira uma **tag e uma release** no GitHub (`vX.Y.Z`), com as notas montadas a partir dos PRs. Os PRs agrupados por tipo: o workflow **Rótulos** marca cada PR pelo prefixo da branch. O salto da versão vem dos PRs que entraram:

| PR | Versão |
|---|---|
| rótulo `versão-maior` | `X+1.0.0` |
| branch `feat/` | `X.Y+1.0` |
| `fix/`, `arte/`, `docs/`, `teste/`, `infra/` | `X.Y.Z+1` |

A versão vem da tag do git, não do `package.json` (a `main` só aceita mudanças por PR). A barra de cima do escritório mostra a versão em uso e leva às notas dela; `v0.15.0+3` quer dizer 3 commits depois da release, e um `*` no fim, mudanças não commitadas na pasta.

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
