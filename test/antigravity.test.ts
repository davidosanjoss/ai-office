import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  antigravityArgs,
  antigravityLastText,
  antigravitySessionId,
  antigravityUsageLine,
  ensureAgyPlugin,
  setAgyPrompt,
  workspaceFromUris,
} from '../server/antigravity.ts';
import { handleHook } from '../server/hooks.ts';
import { agyHasMemory, agyWiring } from '../server/memory.ts';
import { store } from '../server/store.ts';
import { resetUsage, usageRecords } from '../server/usage.ts';
import { cleanEnv } from '../server/agents.ts';
import { MODEL_GROUPS, modelsForAgent } from '../shared/models.ts';
import { DEFAULT_PRICES, GOOGLE_STANDARD_PRICES, costOf, priceFor } from '../shared/usage.ts';
import type { Agent } from '../shared/types.ts';

const tmp = process.env.AI_OFFICE_TMP!;
const agyDir = process.env.AI_OFFICE_ANTIGRAVITY_DIR!;
const agyConfigDir = process.env.AI_OFFICE_ANTIGRAVITY_CONFIG_DIR!;

describe('Antigravity: modelos e preços', () => {
  it('lista somente modelos Google sem sufixo de esforço no grupo Google · Antigravity', () => {
    const group = MODEL_GROUPS.find((g) => g.label === 'Google · Antigravity');
    expect(group).toBeDefined();
    expect(group!.models.length).toBeGreaterThan(0);
    for (const model of group!.models) {
      expect(model).toMatch(/^gemini-/i);
      expect(model).not.toMatch(/-(?:low|medium|high|xhigh|max)$/i);
    }
  });

  it('filtra modelos compatíveis por tipo de agente', () => {
    expect(modelsForAgent({ mode: 'unico', model: 'gemini-4-neon' }, 'antigravity')).toEqual({ mode: 'unico', model: 'gemini-4-neon' });
    expect(modelsForAgent({ mode: 'unico', model: 'gemini-4-neon-high' }, 'antigravity')).toEqual({ mode: 'unico', model: 'gemini-4-neon-high' });
    expect(modelsForAgent({ mode: 'unico', model: 'gemini-4-neon-high' }, 'claude')).toBeUndefined();
    expect(modelsForAgent({ mode: 'unico', model: 'gemini-4-neon-high' }, 'codex')).toBeUndefined();

    expect(modelsForAgent({ mode: 'unico', model: 'claude-opus-5-5-high' }, 'antigravity')).toEqual({ mode: 'unico', model: 'claude-opus-5-5-high' });
    expect(modelsForAgent({ mode: 'unico', model: 'claude-opus-5-5-high' }, 'claude')).toBeUndefined();
    expect(modelsForAgent({ mode: 'unico', model: 'gpt-oss-120b-medium' }, 'antigravity')).toEqual({ mode: 'unico', model: 'gpt-oss-120b-medium' });
    expect(modelsForAgent({ mode: 'unico', model: 'gpt-oss-120b-medium' }, 'codex')).toBeUndefined();

    expect(modelsForAgent({ mode: 'duplo', reasoning: 'gemini-4-neon-high', execution: 'claude-sonnet-5-5' }, 'antigravity')).toEqual({
      mode: 'unico',
      model: 'gemini-4-neon-high',
    });
    expect(modelsForAgent({ mode: 'duplo', reasoning: 'gemini-4-neon-high', execution: 'claude-sonnet-5-5' }, 'claude')).toEqual({
      mode: 'unico',
      model: 'claude-sonnet-5-5',
    });
  });

  it('preços Google/Antigravity herdam o modelo base ignorando o sufixo de esforço', () => {
    expect(priceFor('gemini-4-neon-high', DEFAULT_PRICES)).toBe(GOOGLE_STANDARD_PRICES['gemini-4-neon']);
    expect(priceFor('gemini-4-hydrogen-xhigh', DEFAULT_PRICES)).toBe(GOOGLE_STANDARD_PRICES['gemini-4-hydrogen']);
    expect(priceFor('gemini-3.8-flash-medium', DEFAULT_PRICES)).toBe(GOOGLE_STANDARD_PRICES['gemini-3.8-flash']);
    expect(priceFor('claude-opus-5-5-high', DEFAULT_PRICES)).toBe(DEFAULT_PRICES['claude-opus-5-5']);

    const cost = costOf(
      {
        source: 'antigravity',
        id: 'c1:1',
        ts: Date.now(),
        cwd: '/p',
        model: 'gemini-4-neon-high',
        input: 1e6,
        output: 1e6,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 1e6,
      },
      priceFor('gemini-4-neon-high', DEFAULT_PRICES)!,
    );
    expect(cost).toBeCloseTo(3 + 15 + 0.15);
  });
});

describe('Antigravity: argumentos, ambiente e plugin', () => {
  it('monta argumentos para sessão nova, retomada, modelo e pastas extras', () => {
    expect(antigravityArgs({ sessionId: '' }, false, 'gemini-4-neon-high', ['/sala'])).toEqual([
      '--model',
      'gemini-4-neon-high',
      '--add-dir',
      '/sala',
    ]);
    expect(antigravityArgs({ sessionId: '11111111-1111-4111-8111-111111111111' }, true, 'gemini-4-argon-high')).toEqual([
      '--conversation',
      '11111111-1111-4111-8111-111111111111',
      '--model',
      'gemini-4-argon-high',
    ]);
  });

  it('cleanEnv remove marcadores de sessão do Antigravity', () => {
    const prev = { ...process.env };
    try {
      process.env.ANTIGRAVITY_AGENT = '1';
      process.env.ANTIGRAVITY_CONVERSATION_ID = 'conv-pai';
      process.env.ANTIGRAVITY_LS_ADDRESS = 'localhost:1234';
      const env = cleanEnv();
      expect(env.ANTIGRAVITY_AGENT).toBeUndefined();
      expect(env.ANTIGRAVITY_CONVERSATION_ID).toBeUndefined();
      expect(env.ANTIGRAVITY_LS_ADDRESS).toBeUndefined();
    } finally {
      process.env = prev;
    }
  });

  it('cria plugin com hooks e só adiciona ponte MCP do ai-memory quando ainda não está ligado no global', () => {
    const cfg = path.join(tmp, `agy-cfg-${Date.now()}`);
    fs.mkdirSync(cfg, { recursive: true });
    // Sem wrapper / token instalados: cria plugin sem mcp_config.json.
    const dir = ensureAgyPlugin(cfg);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'))).toMatchObject({ name: 'ai-office', version: '1.0.0' });
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
    expect(hooks['ai-office'].SessionStart[0].command).toContain('SessionStart antigravity');
    expect(hooks['ai-office'].PreToolUse[0].matcher).toBe('*');
    expect(fs.existsSync(path.join(dir, 'mcp_config.json'))).toBe(false);

    // Com wrapper e token existentes e sem MCP global: grava mcp_config.json com a ponte.
    const memBin = process.env.AI_OFFICE_MEMORY_BIN!;
    const memData = process.env.AI_OFFICE_MEMORY_DATA!;
    fs.mkdirSync(path.dirname(memBin), { recursive: true });
    fs.writeFileSync(memBin, '#!/usr/bin/env node\n');
    fs.mkdirSync(path.join(memData, 'auth-tokens'), { recursive: true });
    fs.writeFileSync(path.join(memData, 'auth-tokens', 'default'), 'tok');
    expect(agyHasMemory(cfg)).toBe(true);
    ensureAgyPlugin(cfg);
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, 'mcp_config.json'), 'utf8'));
    expect(mcp.mcpServers['ai-office-memory'].args).toEqual(expect.arrayContaining(['mcp-bridge', '--no-session-id']));

    // Se o mcp_config.json global já tem ai-memory, o plugin não duplica o servidor MCP.
    fs.writeFileSync(path.join(cfg, 'mcp_config.json'), JSON.stringify({ mcpServers: { 'ai-memory': { serverUrl: 'http://127.0.0.1:49374/mcp' } } }));
    expect(agyWiring(cfg).mcp).toBe(true);
    ensureAgyPlugin(cfg);
    expect(fs.existsSync(path.join(dir, 'mcp_config.json'))).toBe(false);

    fs.rmSync(memBin, { force: true });
    fs.rmSync(memData, { recursive: true, force: true });
  });
});

describe('Antigravity: hooks de ciclo de vida e injeção de contexto', () => {
  beforeEach(() => {
    store.agents.clear();
    store.activity.length = 0;
  });

  it('SessionStart grava conversationId e injeta o contexto da sala; PreInvocation, PreToolUse e Stop atualizam o estado', () => {
    const a: Agent = {
      id: 'agy1',
      kind: 'antigravity',
      roomId: 'r1',
      name: 'Leo',
      cwd: '/proj/app',
      sessionId: '',
      status: 'starting',
      activity: 'Chegando…',
      subagents: 0,
      createdAt: Date.now(),
    };
    store.putAgent(a);
    const promptFile = path.join(tmp, 'prompt-agy1.md');
    fs.writeFileSync(promptFile, '# Sala App\n\n## Memória compartilhada (ai-memory)');
    setAgyPrompt(a.id, promptFile);

    const convId = 'f9109c2a-21ea-4ba0-b01f-7f46a39dac83';
    const startOut = handleHook({ event: 'SessionStart', agentId: a.id, payload: { conversationId: convId, cwd: '/proj/app' } });
    expect(startOut).toEqual({
      injectSteps: [{ systemMessage: { systemMessage: '# Sala App\n\n## Memória compartilhada (ai-memory)' } }],
    });
    expect(store.agents.get(a.id)).toMatchObject({ sessionId: convId, status: 'idle' });

    // PreInvocation registra o pedido só uma vez quando o texto é o mesmo.
    expect(handleHook({ event: 'PreInvocation', agentId: a.id, payload: { conversationId: convId, lastUserInput: 'arrume o teste' } })).toEqual({});
    expect(handleHook({ event: 'PreInvocation', agentId: a.id, payload: { conversationId: convId, lastUserInput: 'arrume o teste' } })).toEqual({});
    expect(store.agents.get(a.id)).toMatchObject({ status: 'working', activity: 'Pensando…' });
    expect(store.activity.filter((e) => e.kind === 'prompt')).toHaveLength(1);

    // PreToolUse usa payload.toolCall (camelCase do Antigravity).
    expect(
      handleHook({
        event: 'PreToolUse',
        agentId: a.id,
        payload: { conversationId: convId, toolCall: { id: 't1', name: 'edit_file', args: { Path: '/proj/app/src/index.ts' } } },
      }),
    ).toEqual({});
    expect(store.agents.get(a.id)).toMatchObject({ status: 'working', activity: 'Editando index.ts' });

    // Stop marca done e zera ajudantes.
    expect(handleHook({ event: 'Stop', agentId: a.id, payload: { conversationId: convId } })).toEqual({});
    expect(store.agents.get(a.id)).toMatchObject({ status: 'done', subagents: 0 });
  });
});

describe('Antigravity: leitura de consumo e transcripts', () => {
  beforeEach(() => {
    resetUsage();
    store.agents.clear();
  });

  it('regressão: a pasta da URI do workspace não some no Windows quando a URI não tem letra de unidade', () => {
    // No Windows, fileURLToPath('file:///tmp/meu-repo') lança erro, e a pasta voltava vazia.
    expect(workspaceFromUris('["file:///tmp/meu-repo"]')).toBe(path.resolve('/tmp/meu-repo'));
    expect(workspaceFromUris(JSON.stringify([pathToFileURL(path.resolve('/tmp/com espaço')).href]))).toBe(path.resolve('/tmp/com espaço'));
    expect(workspaceFromUris('["/sem/uri"]')).toBe('/sem/uri');
    expect(workspaceFromUris('nada')).toBe('');
  });

  it('extrai registro de consumo de PLANNER_RESPONSE e ignora transcript_full.jsonl', async () => {
    const convId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const logsDir = path.join(agyDir, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const file = path.join(logsDir, 'transcript.jsonl');
    const fullFile = path.join(logsDir, 'transcript_full.jsonl');

    expect(antigravitySessionId(file, agyDir)).toBe(convId);
    expect(antigravitySessionId(fullFile, agyDir)).toBeUndefined();

    const line = JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T21:21:50Z',
      model: 'gemini-4-neon-high',
      input_tokens: 3484,
      cache_read_tokens: 7677,
      output_tokens: 297,
      content: 'Tudo pronto!',
    });
    expect(antigravityUsageLine(line, convId, '/proj/app')).toEqual({
      source: 'antigravity',
      id: `${convId}:3`,
      session: convId,
      ts: Date.parse('2026-11-23T21:21:50Z'),
      cwd: '/proj/app',
      model: 'gemini-4-neon-high',
      input: 3484,
      output: 297,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 7677,
    });
    expect(antigravityLastText(`${line}\n`)).toBe('Tudo pronto!');

    // Grava no brain temporário e registra um agente com esse sessionId para associar o cwd.
    fs.writeFileSync(file, `${line}\n`);
    fs.writeFileSync(fullFile, `${line}\n`);
    store.putAgent({
      id: 'agy-u1',
      kind: 'antigravity',
      roomId: 'r1',
      name: 'Ana',
      cwd: '/proj/agy-usage',
      sessionId: convId,
      status: 'idle',
      activity: '',
      subagents: 0,
      createdAt: Date.now(),
    });

    const records = (await usageRecords(true)).filter((r) => r.source === 'antigravity' && r.session === convId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ cwd: '/proj/agy-usage', model: 'gemini-4-neon-high', input: 3484, cacheRead: 7677, output: 297 });
  });
});

// Evita aviso de variável não usada caso o linter cheque.
void agyConfigDir;
