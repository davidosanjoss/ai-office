import path from 'node:path';
import { isAgyConversationId, readAgyPrompt, rememberAgySession } from './antigravity.ts';
import { onSessionStart, onStop } from './incidents.ts';
import { agentMovedOn } from './permissions.ts';
import { onPostToolUse } from './live.ts';
import { store } from './store.ts';
import { sessionStartOutput, stopDecision } from './context.ts';
import { writeInput } from './agents.ts';
import { FRESH_PROMPT } from '../shared/context.ts';

interface HookBody {
  event: string;
  agentId?: string;
  payload: Record<string, any>;
}

/** Último prompt registrado por agente Antigravity (PreInvocation dispara antes de cada chamada ao modelo no turno). */
const lastAgyPrompt = new Map<string, string>();

/**
 * Transforma um evento de hook do Claude Code / Codex / Antigravity em estado do personagem.
 * Devolve a saída do hook, quando o escritório decide algo (Stop: gravar a memória; SessionStart:
 * o dossiê da sessão nova ou o contexto da sala no Antigravity).
 */
export function handleHook({ event, agentId, payload }: HookBody): object | undefined {
  const agent = agentId ? store.agents.get(agentId) : findBySession(payload.session_id ?? payload.conversationId);
  if (!agent) return undefined;
  const id = agent.id;
  if (agent.kind === 'codex') {
    if (event === 'SessionStart' && typeof payload.session_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.session_id)) {
      store.patchAgent(id, { sessionId: payload.session_id, status: 'idle', activity: 'Pronto para trabalhar' });
      return;
    }
    if (event === 'PermissionRequest') {
      store.patchAgent(id, { status: 'waiting', activity: 'Aguardando aprovação no terminal', attentionAt: Date.now() });
      return;
    }
  }
  if (agent.kind === 'antigravity') {
    const convId = isAgyConversationId(payload.conversationId) ? payload.conversationId : undefined;
    if (convId) rememberAgySession(convId, typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : agent.cwd);
    if (['PostToolUse', 'PreInvocation', 'Stop'].includes(event)) agentMovedOn(id);
    switch (event) {
      case 'SessionStart': {
        store.patchAgent(id, { ...(convId ? { sessionId: convId } : {}), status: 'idle', activity: 'Pronto para trabalhar' });
        onSessionStart(id);
        const prompt = readAgyPrompt(id);
        return prompt ? { injectSteps: [{ systemMessage: { systemMessage: prompt } }] } : {};
      }
      case 'PreInvocation': {
        const prompt = String(payload.lastUserInput ?? '').trim();
        store.patchAgent(id, {
          ...(convId && !agent.sessionId ? { sessionId: convId } : {}),
          status: 'working',
          activity: 'Pensando…',
          attentionAt: undefined,
        });
        if (prompt && lastAgyPrompt.get(id) !== prompt) {
          lastAgyPrompt.set(id, prompt);
          store.log(id, `Pedido: ${truncate(prompt, 120)}`, 'prompt');
        }
        return {};
      }
      case 'PreToolUse': {
        const toolName = String(payload.toolCall?.name ?? payload.tool_name ?? '');
        const toolInput = (payload.toolCall?.args ?? payload.tool_input ?? {}) as Record<string, any>;
        const text = describeTool(toolName, toolInput);
        const isTask = toolName === 'invoke_subagent' || toolName === 'Task' || toolName === 'Agent';
        store.patchAgent(id, {
          ...(convId && !agent.sessionId ? { sessionId: convId } : {}),
          status: 'working',
          activity: text,
          attentionAt: undefined,
          subagents: agent.subagents + (isTask ? 1 : 0),
          ...(isTask ? { helpers: [...(agent.helpers ?? []), String(toolInput.Role ?? toolInput.description ?? toolInput.TypeName ?? 'ajudante').slice(0, 80)].slice(-10) } : {}),
        });
        store.log(id, text, 'tool');
        return {};
      }
      case 'PostToolUse':
        if (agent.status === 'waiting') store.patchAgent(id, { status: 'working', attentionAt: undefined });
        return {};
      case 'Stop':
        lastAgyPrompt.delete(id);
        store.patchAgent(id, { status: 'done', activity: 'Terminou!', subagents: 0, attentionAt: Date.now() });
        store.log(id, 'Terminou o pedido', 'done');
        onStop(id, payload);
        return {};
      default:
        return {};
    }
  }
  // O agente seguiu adiante (a ferramenta rodou, chegou outro pedido, terminou): o que estava
  // esperando resposta no escritório foi respondido no terminal.
  if (['PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd'].includes(event)) agentMovedOn(id);

  switch (event) {
    case 'SessionStart': {
      store.patchAgent(id, { status: 'idle', activity: 'Pronto para trabalhar' });
      onSessionStart(id);
      const output = sessionStartOutput(id, payload.session_id);
      // Sessão nova com resumo: o escritório digita a primeira mensagem, e ela começa contando o que sabe.
      if (output) setTimeout(() => {
        writeInput(id, FRESH_PROMPT);
        setTimeout(() => writeInput(id, '\r'), 200);
      }, FRESH_PROMPT_DELAY_MS);
      return output;
    }

    case 'UserPromptSubmit': {
      const prompt = String(payload.prompt ?? '').trim();
      store.patchAgent(id, { status: 'working', activity: 'Pensando…', attentionAt: undefined });
      if (prompt) store.log(id, `Pedido: ${truncate(prompt, 120)}`, 'prompt');
      break;
    }

    case 'PreToolUse': {
      const text = describeTool(payload.tool_name, payload.tool_input ?? {});
      const isTask = payload.tool_name === 'Task' || payload.tool_name === 'Agent';
      const input = payload.tool_input ?? {};
      store.patchAgent(id, {
        status: 'working',
        activity: text,
        attentionAt: undefined,
        subagents: agent.subagents + (isTask ? 1 : 0),
        // Ajudantes: a descrição de cada um, para os detalhes (os 10 mais recentes).
        ...(isTask ? { helpers: [...(agent.helpers ?? []), String(input.description ?? input.subagent_type ?? 'ajudante').slice(0, 80)].slice(-10) } : {}),
        ...todosFrom(payload.tool_name, input, agent.todos),
      });
      store.log(id, text, 'tool');
      break;
    }

    case 'PostToolUse':
      onPostToolUse(agent, payload);
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

    case 'Stop': {
      // Contexto grande com o cache quente: antes de parar, o agente grava o que importa.
      const output = agent.kind === 'codex' ? undefined : stopDecision(agent, payload);
      if (output) return output;
      store.patchAgent(id, { status: 'done', activity: 'Terminou!', subagents: 0, attentionAt: Date.now() });
      store.log(id, 'Terminou o pedido', 'done');
      // Na sala de guerra, a resposta vai para o chat e a próxima mensagem da fila é digitada.
      onStop(id, payload);
      break;
    }

    case 'SubagentStop':
      store.patchAgent(id, { subagents: Math.max(0, agent.subagents - 1), helpers: (agent.helpers ?? []).slice(1) });
      break;
  }
  return undefined;
}

/** Espera o terminal da sessão nova ficar pronto antes de digitar a primeira mensagem. */
const FRESH_PROMPT_DELAY_MS = 1500;

type Todo = NonNullable<import('../shared/types.ts').Agent['todos']>[number];
const TODO_STATUS = new Set(['pending', 'in_progress', 'completed']);

/**
 * Lista de tarefas do agente: o TodoWrite manda a lista inteira; as ferramentas de tarefas mais
 * novas (TaskCreate / TaskUpdate) criam uma de cada vez e mudam o estado pelo título.
 */
export function todosFrom(tool: string, input: Record<string, any>, current: Todo[] = []): { todos?: Todo[] } {
  const clean = (t: any): Todo | undefined => {
    const content = String(t?.content ?? t?.subject ?? '').trim();
    if (!content) return undefined;
    const status = TODO_STATUS.has(t?.status) ? t.status : 'pending';
    return { content: content.slice(0, 200), status, ...(t?.activeForm ? { activeForm: String(t.activeForm).slice(0, 200) } : {}) };
  };
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) return { todos: input.todos.map(clean).filter((t: Todo | undefined): t is Todo => !!t).slice(0, 50) };
  if (tool === 'TaskCreate') {
    const t = clean(input);
    return t ? { todos: [...current, t].slice(-50) } : {};
  }
  if (tool === 'TaskUpdate' && input.subject && TODO_STATUS.has(input.status)) {
    return { todos: current.map((t) => (t.content === String(input.subject).trim() ? { ...t, status: input.status } : t)) };
  }
  return {};
}

function findBySession(sessionId: unknown) {
  if (typeof sessionId !== 'string') return undefined;
  return [...store.agents.values()].find((a) => a.sessionId === sessionId);
}

export function describeTool(tool: string, input: Record<string, any>): string {
  const file = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (tool) {
    case 'Read':
    case 'read_file':
    case 'view_file':
    case 'view_file_outline':
    case 'view_code_item':
      return `Lendo ${file(input.file_path ?? input.Path ?? input.AbsolutePath)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return `Editando ${file(input.file_path ?? input.Path ?? input.TargetFile)}`;
    case 'Write':
    case 'write_file':
    case 'write_to_file':
      return `Escrevendo ${file(input.file_path ?? input.Path ?? input.TargetFile)}`;
    case 'NotebookEdit':
      return `Editando ${file(input.notebook_path)}`;
    case 'Bash':
    case 'run_command':
      return `Rodando: ${truncate(input.description || input.toolSummary || input.command || input.CommandLine || '', 60)}`;
    case 'Grep':
    case 'grep_search':
      return `Buscando "${truncate(input.pattern ?? input.Query ?? '', 40)}"`;
    case 'Glob':
    case 'find_by_name':
    case 'list_dir':
      return `Procurando ${truncate(input.pattern ?? input.Pattern ?? file(input.DirectoryPath) ?? '', 40)}`;
    case 'WebFetch':
    case 'read_url_content':
      return `Lendo ${truncate(input.url ?? input.Url ?? 'página web', 50)}`;
    case 'WebSearch':
    case 'search_web':
      return `Pesquisando "${truncate(input.query ?? '', 40)}"`;
    case 'Task':
    case 'Agent':
    case 'invoke_subagent':
      return `Chamou ajudante: ${truncate(input.description ?? input.Role ?? input.TypeName ?? '', 50)}`;
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
