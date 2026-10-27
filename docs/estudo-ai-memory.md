# Estudo: ai-memory no AI Office

Issue: [#11](https://github.com/davidosanjoss/ai-office/issues/11). Projeto estudado: [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory) (Rust, licença MIT), lido na documentação da `main` em 27/10/2026: `README.md`, `docs/ARCHITECTURE.md`, `docs/agent-messaging.md`, `docs/frontend-api.md`, `docs/external-lifecycle.md`, `docs/managed-workstreams.md`, `docs/windows.md`, `docs/support-matrix.md`, `docs/install.md`, `DATA_HANDLING.md` e `docker/docker-compose.yml`.

## Resumo e recomendação

**Integrar, não copiar.** O ai-memory resolve sozinho a parte difícil (capturar, guardar, consolidar, buscar e passar o bastão entre sessões e entre IAs diferentes). Reescrever isso no escritório seria muito trabalho para um resultado pior. O AI Office fica com o que já faz bem: mostrar, organizar e conduzir os agentes.

O encaixe é bom porque os dois já falam a mesma língua:

- **Hooks.** O escritório injeta os hooks dele com `--settings`, e o ai-memory instala os dele nas configurações do Claude Code. O Claude roda os dois. Sessões abertas pelo escritório passam a ser lembradas **sem mudar nada no nosso código**.
- **Dados locais e só no `127.0.0.1`**, como o escritório. Sem telemetria.
- **Mensagens entre projetos**, numa fila em que cada mensagem é recebida uma única vez e o corpo é tratado como entrada não confiável. É o mesmo problema da sala de guerra ([#10](https://github.com/davidosanjoss/ai-office/issues/10)), resolvido do jeito assíncrono.
- **Mais de 20 IAs suportadas** (Codex, Gemini CLI, Cursor, OpenCode…), o caminho para salas com outras IAs.

Proposta em quatro fases (detalhes no fim): **(1)** rodar o ai-memory em Docker ao lado do escritório, com os dados numa pasta fora do repositório; **(2)** o escritório mostrar a memória de cada sala, só lendo; **(3)** a sala de guerra usar a memória para o briefing e o post-mortem; **(4)** salas com outras IAs.

## O que o ai-memory é por dentro

```
captura ──▶ consolidação ──▶ busca ──▶ handoff
 hooks        fim da sessão     busca +    próximo agente,
 em silêncio  vira página .md   resumo     qualquer IA
```

**Captura.** Os hooks de cada IA (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd…) mandam eventos para o servidor. O servidor **limpa os dados sensíveis** antes de guardar (é o único caminho de texto externo para dentro) e nunca trava o agente: se estiver lento, recusa em vez de enfileirar.

**Consolidação.** No fim de cada sessão, o servidor escreve uma página `sessions/<id>.md` com o resumo, **por regras, sem LLM**, e abre um *handoff* para a próxima sessão. Com uma LLM configurada (opcional), ele também reescreve páginas e junta duplicadas.

**Armazenamento** (`<data_dir>`, um diretório só):

| Pasta | O que tem |
|---|---|
| `wiki/` | A fonte da verdade: páginas markdown num repositório git, editáveis à mão (até no Obsidian) |
| `db/memory.sqlite` | Índice derivado: busca, sessões, observações, handoffs, mensagens. Dá para reconstruir a partir do `wiki/` |
| `raw/`, `logs/`, `models/` | Transcrições dos `run`, logs e o modelo local de embeddings (~87 MB, baixado na primeira vez) |

**Busca e resumo.** Uma sessão nova recebe um resumo curto do projeto. As 24 ferramentas MCP (`memory_query`, `memory_briefing`, `memory_read_page`…) servem para buscar o resto.

**Handoff.** Passagem de bastão tipada, com dono, aceita uma única vez: "parei aqui, isto falhou, isto está aberto". Vale entre IAs diferentes.

**Mensagens entre projetos** (`memory_message_send` / `list` / `pop` / `cancel`):

- uma caixa de entrada por projeto, com no máximo 256 mensagens pendentes;
- cada mensagem é recebida uma única vez;
- o destinatário precisa existir;
- o corpo chega cercado como **entrada não confiável**, com a origem visível e segredos removidos;
- na abertura da sessão, o agente só vê "📬 N mensagens", nunca o texto. Ninguém consegue injetar instruções por ali.

**API para interfaces** (`/api/v1`): **só leitura por construção**. Lista projetos, páginas, busca, resumo, sessões e handoffs. Escrever só pelo MCP ou pelo `/admin`.

**`ai-memory run <ia>`:** um lançador opcional que mantém uma mesma "linha de trabalho" ao trocar de IA no meio da tarefa (sai do Claude e entra no Codex com o histórico).

## Integrar ou copiar, por capacidade

| Capacidade | Decisão | Por quê |
|---|---|---|
| Captura por hooks e limpeza de dados sensíveis | **Integrar** | Já funciona com o Claude Code e com mais de 20 IAs. Copiar seria refazer a parte mais delicada (privacidade). |
| Memória em markdown + git, consolidação, busca | **Integrar** | É o coração do projeto, com benchmarks publicados. |
| Handoff entre sessões e IAs | **Integrar** | Encaixa no "agente volta para a sala dele com o que aprendeu" da sala de guerra. |
| Mensagens entre projetos | **Integrar** | Mesmo problema da sala de guerra (assíncrono). Usar para pedidos entre salas fora de um incidente. |
| Mostrar memória, handoffs e caixa de entrada na interface | **Fazer no escritório**, lendo a `/api/v1` | A interface é nossa: o badge "📬 N" na sala, o resumo do projeto, o histórico de incidentes. |
| Sala de guerra (conversa síncrona em grupo) | **Fazer no escritório** | O ai-memory é assíncrono por desenho. A conversa ao vivo, o repasse e o mapa são nossos. A memória entra no briefing e no encerramento. |
| Abrir outras IAs | **Copiar a ideia, integrar o `run`** | O escritório abre o PTY; para outra IA, o comando vira `ai-memory run <ia>`, e o estado ao vivo (digitando, mão levantada) continua vindo dos hooks de cada IA. |

## Docker e onde ficam os dados

O compose oficial (`docker/docker-compose.yml`) já é quase o que queremos: escuta só em `127.0.0.1:49374`, roda como usuário 1000 e reinicia sozinho. Ele compila a imagem do código-fonte, mas há uma imagem pronta no Docker Hub (`akitaonrails/ai-memory:<versão>`), que é a que a documentação de Windows usa. As duas trocas são usar essa imagem com a versão fixa e trocar o **volume nomeado** por uma **pasta montada fora deste repositório**, para os dados ficarem visíveis, com backup simples e longe do git:

```yaml
# docker-compose.yml do AI Office (proposta, fase 1)
services:
  ai-memory:
    image: akitaonrails/ai-memory:<versão>   # imagem pronta; versão fixa, atualizada de propósito
    restart: unless-stopped
    user: "1000:1000"
    ports:
      - "127.0.0.1:49374:49374"     # só a própria máquina, como o escritório
    volumes:
      - ${AI_OFFICE_MEMORIA:-~/.ai-office/memoria}:/data
    env_file:
      - path: ${AI_OFFICE_MEMORIA_ENV:-~/.ai-office/memoria.env}   # chave de LLM opcional, fora do repo
        required: false
```

**Regras para dados pessoais e da empresa:**

1. **Nada de dado no repositório.** Memória em `~/.ai-office/memoria`, configuração (incluindo chave de LLM, se houver) em `~/.ai-office/memoria.env`, e o estado do escritório já está em `~/.ai-office/state.json`. Tudo isso fica na pasta da pessoa, nunca dentro deste projeto.
2. **Barreira no CI** (vira issue): um passo que falha se aparecer no git qualquer `state.json`, `*.sqlite`, `memoria/` ou `.env` com conteúdo. O `.gitignore` sozinho não basta, porque `git add -f` passa por cima dele.
3. **Projetos que não devem ser lembrados:** o ai-memory tem um arquivo de marcação por repositório (`.ai-memory.toml`) com política de captura. Para um projeto sensível da empresa, dá para desligar a captura ou limitar o que entra. O escritório pode oferecer isso ao criar a sala.
4. **Sem criptografia em repouso** no ai-memory (ele usa as permissões do sistema). A pasta `~/.ai-office/memoria` fica só para o seu usuário.

**Windows (os seus amigos):** o caminho recomendado pelo ai-memory é o **Docker Desktop**, o "Scenario B" de `docs/windows.md`. O servidor fica no container, e o `ai-memory.exe` no Windows instala hooks e MCP para o Claude nativo. A pasta montada vira `%USERPROFILE%\.ai-office\memoria`. Rodar o ai-memory nativo no Windows ainda está marcado como **experimental** na tabela de suporte deles, então o Docker é a escolha segura. Um cuidado da documentação: no Windows nativo, manter o servidor no ar exige um *service wrapper*; uma tarefa agendada é encerrada no reboot. Com o Docker Desktop, o `restart: unless-stopped` resolve.

## Riscos e custos

- **Mais um serviço rodando.** É um container a mais (servidor Rust e SQLite, leve), mas é mais uma coisa para instalar e atualizar.
- **Atualizações do ai-memory.** As migrações do banco só andam para frente: antes de trocar a versão da imagem, fazer backup (`ai-memory backup`, documentado em `docs/install.md`).
- **Hooks globais.** O `install-hooks` do ai-memory vale para **todas** as sessões do Claude na máquina, não só as do escritório. É o que se quer para a memória, mas precisa estar claro na instalação, junto com a política por projeto (regra 3 acima).
- **Download na primeira vez:** o modelo de embeddings (~87 MB) vem do Hugging Face. Dá para desligar (`embedding_provider = "none"`, só busca por texto) ou pré-baixar.
- **LLM é opcional.** Captura, busca, handoffs e mensagens funcionam **sem chave de API**. A LLM só entra se você configurar, e aí o conteúdo vai para o provedor escolhido.
- **Ritmo do projeto.** Ele é muito ativo: há changelogs grandes e uma migração 2.0 → 3.0 documentada. Convém fixar uma versão no compose e atualizar de propósito.

## Proposta em fases

### Fase 1: ai-memory ao lado do escritório

- `docker-compose.yml` no repositório (o de cima), mais um `npm run memoria:up` que sobe o container e roda `install-hooks` / `install-mcp` para o Claude Code.
- A barreira no CI contra dados no git.
- O escritório **detecta** se o ai-memory está no ar (`GET /api/v1` respondendo) e mostra um indicador discreto no topo. Sem ai-memory, tudo segue funcionando como hoje.

### Fase 2: a memória aparece no escritório (só leitura)

- **Na sala:** o badge "📬 N" quando o projeto tem mensagens pendentes e o resumo do projeto (`/api/v1` briefing) na barra lateral.
- **Na lista do escritório:** handoffs abertos ("parou aqui") ao lado de quem saiu do escritório, o que ajuda a decidir quem retomar.

### Fase 3: sala de guerra com memória ([#10](https://github.com/davidosanjoss/ai-office/issues/10))

- **Briefing de entrada:** a descrição do incidente, mais o resumo de cada projeto participante vindo do ai-memory.
- **Durante:** o escritório conduz a conversa ao vivo (é síncrona e fica no nosso código).
- **Encerramento:**
  - cada agente grava uma página `incidentes/<data>-<título>.md` no projeto dele (`memory_write_page`), com o que se descobriu ali;
  - cada agente abre um *handoff* para a próxima sessão daquele projeto;
  - o post-mortem completo fica em `~/.ai-office/incidentes/`.

  Assim, quem voltar a esses projetos (mesmo outra IA) já sabe do incidente.
- **Pedidos entre salas fora de um incidente** usam as mensagens do ai-memory: "pede para o projeto de filas expor tal métrica".

### Fase 4: salas com outras IAs

- Ao contratar um agente, escolher a IA: Claude, Codex, Gemini…
- O PTY do escritório roda `ai-memory run <ia>` em vez do binário direto, e a continuidade entre IAs vem de graça.
- O estado ao vivo (digitando, mão levantada) depende dos hooks de cada IA. A tabela de suporte do ai-memory (`docs/support-matrix.md`) diz, IA por IA, quais eventos cada uma entrega; é por ela que se decide quais IAs entram primeiro.

## Pontos em aberto (decidir antes da fase 1)

1. **Indicador sem ai-memory.** O escritório funciona igual sem ele. Então só mostra o indicador quando ele existe, ou também oferece instalar?
2. **Política padrão para projetos da empresa.** Capturar tudo, ou perguntar ao criar a sala de um andar marcado como "empresa"?

## Issues sugeridas a partir deste estudo

- **Fase 1:** compose do ai-memory com dados em `~/.ai-office/memoria`, `npm run memoria:up` e indicador no topo.
- **Barreira no CI** contra dados pessoais no git.
- **Fase 2:** badge de caixa de entrada e resumo do projeto na sala.
- **Fase 3** vira parte da [#10](https://github.com/davidosanjoss/ai-office/issues/10) (sala de guerra).
- **Fase 4:** contratar agente escolhendo a IA.
