import path from 'node:path';
import { onSessionStart, onStop } from './incidents.ts';
import { store } from './store.ts';

interface HookBody {
  event: string;
  agentId?: string;
  payload: Record<string, any>;
}

/** Transforma um evento de hook do Claude Code em estado do personagem. */
export function handleHook({ event, agentId, payload }: HookBody) {
  const agent = agentId ? store.agents.get(agentId) : findBySession(payload.session_id);
  if (!agent) return;
  const id = agent.id;

  switch (event) {
    case 'SessionStart':
      store.patchAgent(id, { status: 'idle', activity: 'Pronto para trabalhar' });
      onSessionStart(id);
      break;

    case 'UserPromptSubmit': {
      const prompt = String(payload.prompt ?? '').trim();
      store.patchAgent(id, { status: 'working', activity: 'Pensando…', attentionAt: undefined });
      if (prompt) store.log(id, `Pedido: ${truncate(prompt, 120)}`, 'prompt');
      break;
    }

    case 'PreToolUse': {
      const text = describeTool(payload.tool_name, payload.tool_input ?? {});
      const isTask = payload.tool_name === 'Task' || payload.tool_name === 'Agent';
      store.patchAgent(id, {
        status: 'working',
        activity: text,
        attentionAt: undefined,
        subagents: agent.subagents + (isTask ? 1 : 0),
      });
      store.log(id, text, 'tool');
      break;
    }

    case 'PostToolUse':
      // Se estava esperando permissão, a ferramenta rodou: voltou ao trabalho.
      if (agent.status === 'waiting') store.patchAgent(id, { status: 'working', attentionAt: undefined });
      break;

    case 'Notification': {
      const message = String(payload.message ?? '');
      const type = String(payload.notification_type ?? '');
      if (type === 'permission_prompt' || /permission|permissão|approve/i.test(message)) {
        store.patchAgent(id, { status: 'waiting', activity: message || 'Precisa de aprovação', attentionAt: Date.now() });
        store.log(id, `✋ ${message || 'Precisa de aprovação'}`, 'waiting');
      }
      break;
    }

    case 'Stop':
      store.patchAgent(id, { status: 'done', activity: 'Terminou!', subagents: 0, attentionAt: Date.now() });
      store.log(id, 'Terminou o pedido', 'done');
      // Na sala de guerra, a resposta vai para o chat e a próxima mensagem da fila é digitada.
      onStop(id, payload);
      break;

    case 'SubagentStop':
      store.patchAgent(id, { subagents: Math.max(0, agent.subagents - 1) });
      break;
  }
}

function findBySession(sessionId: unknown) {
  if (typeof sessionId !== 'string') return undefined;
  return [...store.agents.values()].find((a) => a.sessionId === sessionId);
}

export function describeTool(tool: string, input: Record<string, any>): string {
  const file = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (tool) {
    case 'Read':
      return `Lendo ${file(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editando ${file(input.file_path)}`;
    case 'Write':
      return `Escrevendo ${file(input.file_path)}`;
    case 'NotebookEdit':
      return `Editando ${file(input.notebook_path)}`;
    case 'Bash':
      return `Rodando: ${truncate(input.description || input.command || '', 60)}`;
    case 'Grep':
      return `Buscando "${truncate(input.pattern ?? '', 40)}"`;
    case 'Glob':
      return `Procurando ${truncate(input.pattern ?? '', 40)}`;
    case 'WebFetch':
      return `Lendo ${truncate(input.url ?? 'página web', 50)}`;
    case 'WebSearch':
      return `Pesquisando "${truncate(input.query ?? '', 40)}"`;
    case 'Task':
    case 'Agent':
      return `Chamou ajudante: ${truncate(input.description ?? '', 50)}`;
    case 'TodoWrite':
      return 'Organizando tarefas';
    default:
      return tool?.startsWith('mcp__') ? `Usando ${tool.split('__').slice(1).join(' › ')}` : `Usando ${tool}`;
  }
}

function truncate(s: string, n: number) {
  const one = s.replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
