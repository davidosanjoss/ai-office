import { beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '../shared/types.ts';
import { describeTool, handleHook } from '../server/hooks.ts';
import { store } from '../server/store.ts';

let seq = 0;
function agent(patch: Partial<Agent> = {}): Agent {
  const a: Agent = {
    id: `a${++seq}`,
    kind: 'claude',
    roomId: 'r1',
    name: 'Ana',
    cwd: '/tmp',
    sessionId: `s${seq}`,
    status: 'starting',
    activity: '',
    subagents: 0,
    createdAt: Date.now(),
    ...patch,
  };
  store.putAgent(a);
  return a;
}
const get = (id: string) => store.agents.get(id)!;
const hook = (event: string, agentId: string | undefined, payload: Record<string, unknown> = {}) => handleHook({ event, agentId, payload });

beforeEach(() => {
  store.agents.clear();
  store.activity.length = 0;
});

describe('handleHook: estados do personagem', () => {
  it('SessionStart: pronto para trabalhar', () => {
    const a = agent();
    hook('SessionStart', a.id);
    expect(get(a.id).status).toBe('idle');
  });

  it('UserPromptSubmit: trabalhando, registra o pedido e limpa a atenção', () => {
    const a = agent({ status: 'done', attentionAt: 1 });
    hook('UserPromptSubmit', a.id, { prompt: 'corrige   o\nbug' });
    expect(get(a.id)).toMatchObject({ status: 'working', attentionAt: undefined });
    expect(store.activity.at(-1)).toMatchObject({ kind: 'prompt', text: 'Pedido: corrige o bug' });
  });

  it('PreToolUse: mostra a ferramenta na atividade', () => {
    const a = agent();
    hook('PreToolUse', a.id, { tool_name: 'Edit', tool_input: { file_path: '/x/src/app.ts' } });
    expect(get(a.id)).toMatchObject({ status: 'working', activity: 'Editando app.ts' });
  });

  it('Task/Agent chama ajudante; SubagentStop dispensa, sem ficar negativo', () => {
    const a = agent();
    hook('PreToolUse', a.id, { tool_name: 'Task', tool_input: { description: 'rodar testes' } });
    hook('PreToolUse', a.id, { tool_name: 'Agent', tool_input: { description: 'buscar' } });
    expect(get(a.id).subagents).toBe(2);
    hook('SubagentStop', a.id);
    hook('SubagentStop', a.id);
    hook('SubagentStop', a.id);
    expect(get(a.id).subagents).toBe(0);
  });

  it('Notification de permissão: levanta a mão e entra na fila', () => {
    const a = agent({ status: 'working' });
    hook('Notification', a.id, { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
    expect(get(a.id).status).toBe('waiting');
    expect(get(a.id).attentionAt).toBeGreaterThan(0);
  });

  it('Notification de ociosidade não muda nada', () => {
    const a = agent({ status: 'done' });
    hook('Notification', a.id, { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
    expect(get(a.id).status).toBe('done');
  });

  it('PostToolUse depois da aprovação volta a trabalhar', () => {
    const a = agent({ status: 'waiting', attentionAt: 5 });
    hook('PostToolUse', a.id);
    expect(get(a.id)).toMatchObject({ status: 'working', attentionAt: undefined });
  });

  it('Stop: terminou, entra na fila e dispensa ajudantes', () => {
    const a = agent({ status: 'working', subagents: 2 });
    hook('Stop', a.id);
    expect(get(a.id)).toMatchObject({ status: 'done', subagents: 0 });
    expect(get(a.id).attentionAt).toBeGreaterThan(0);
  });

  it('sem AI_OFFICE_AGENT_ID, acha o agente pelo session_id', () => {
    const a = agent();
    hook('SessionStart', undefined, { session_id: a.sessionId });
    expect(get(a.id).status).toBe('idle');
  });

  it('evento de agente desconhecido é ignorado', () => {
    expect(() => hook('Stop', 'fantasma')).not.toThrow();
    expect(() => hook('Stop', undefined, { session_id: 42 })).not.toThrow();
  });
});

describe('describeTool', () => {
  it.each([
    ['Read', { file_path: '/a/b/c.ts' }, 'Lendo c.ts'],
    ['Write', { file_path: 'x.md' }, 'Escrevendo x.md'],
    ['Bash', { command: 'npm test', description: 'Roda os testes' }, 'Rodando: Roda os testes'],
    ['Bash', { command: 'ls' }, 'Rodando: ls'],
    ['Grep', { pattern: 'TODO' }, 'Buscando "TODO"'],
    ['WebSearch', { query: 'vitest' }, 'Pesquisando "vitest"'],
    ['TodoWrite', {}, 'Organizando tarefas'],
    ['mcp__github__create_issue', {}, 'Usando github › create_issue'],
    ['Outra', {}, 'Usando Outra'],
  ])('%s', (tool, input, text) => {
    expect(describeTool(tool, input)).toBe(text);
  });

  it('corta textos longos', () => {
    expect(describeTool('Bash', { command: 'x'.repeat(200) }).length).toBeLessThanOrEqual(70);
  });
});
