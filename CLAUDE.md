# AI Office

Escritório em pixel art (navegador) que gerencia várias sessões do Claude Code em PTYs. Servidor Node/Fastify em `server/`, interface Vite + Canvas + xterm.js em `web/`, tipos em `shared/types.ts`. O README explica a arquitetura.

## Testes

- Rode `npm test` antes de dar qualquer mudança por terminada. A suíte compila a interface e roda unidade, integração e e2e.
- **Todo bug corrigido ganha um teste de regressão**, com o nome começando por `regressão:`, no arquivo do módulo afetado (ou em `test/e2e.test.ts` se o bug só aparece na interface). Antes de considerar o bug resolvido, reintroduza o código antigo e confirme que o teste falha.
- Nunca aponte testes para o `~/.claude` ou `~/.ai-office` reais. Use `test/setup.ts` (pastas temporárias) e o Claude falso em `test/fixtures/fake-claude.mjs`. Se precisar de um comportamento novo do Claude real nos testes, ensine o falso a imitá-lo.
- Regras de decisão da interface ficam em `web/logic.ts` (puras, testadas em `test/web-logic.test.ts`), não espalhadas em `web/main.ts`.

## Fluxo

- A `main` é protegida: toda mudança entra por Pull Request, com o CI verde (Linux e Windows) e 1 aprovação. Trabalhe numa branch `tipo/descricao` (`feat/`, `fix/`, `arte/`, `docs/`, `teste/`, `infra/`) e nunca tente subir direto na `main`.
- O CONTRIBUTING.md descreve o passo a passo para pessoas.

## Cuidados

- O servidor dá acesso a shell: escuta só em `127.0.0.1` e checa Host/Origin em `server/app.ts`. Não afrouxe isso.
- Os amigos do autor usam Windows: caminhos com `path`, comandos via `ptyCommand`, nada de `&`/`&&` em scripts do npm.
