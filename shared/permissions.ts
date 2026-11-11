// Pedidos dos agentes respondidos pelo escritório: permissões ("posso rodar npm test?") e as
// perguntas do Claude (AskUserQuestion). O hook PermissionRequest (hooks/office-permission.mjs)
// segura o pedido enquanto o escritório decide; vale o que for respondido primeiro, aqui ou no
// terminal. Usado pelo servidor (que guarda e decide) e pela interface (que mostra o cartão).

/** Uma pergunta do AskUserQuestion. */
export interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** Sugestão de regra do Claude Code (permission_suggestions): o "não perguntar de novo". */
export interface PermissionSuggestion {
  type: string;
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: string;
  destination?: string;
  [k: string]: unknown;
}

export interface PendingRequest {
  id: string;
  agentId: string;
  kind: 'permission' | 'question';
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions: PermissionSuggestion[];
  /** Só nas perguntas. */
  questions?: Question[];
  createdAt: number;
}

/** O que você respondeu no escritório. */
export type RequestAnswer =
  | { behavior: 'allow'; always?: boolean; answers?: Record<string, string> }
  | { behavior: 'deny'; message?: string; interrupt?: boolean };

/** Monta o pedido a partir do que o hook PermissionRequest recebeu. */
export function requestFrom(id: string, agentId: string, payload: Record<string, any>, now: number): PendingRequest {
  const toolName = String(payload.tool_name ?? '?');
  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const suggestions = Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions.filter((s: unknown) => s && typeof s === 'object') : [];
  const questions = toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions) ? (toolInput.questions as Question[]) : undefined;
  return { id, agentId, kind: questions ? 'question' : 'permission', toolName, toolInput, suggestions, ...(questions ? { questions } : {}), createdAt: now };
}

/**
 * A saída do hook para o Claude Code. Permitir uma pergunta devolve a entrada com as respostas
 * (`answers`, uma por texto de pergunta; várias opções juntas por vírgula). "Não perguntar de
 * novo" aplica as regras que o próprio Claude Code sugeriu para o pedido.
 */
export function hookOutput(req: PendingRequest, answer: RequestAnswer): object {
  if (answer.behavior === 'deny') {
    const decision: Record<string, unknown> = { behavior: 'deny' };
    if (answer.message?.trim()) decision.message = answer.message.trim();
    if (answer.interrupt) decision.interrupt = true;
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  const decision: Record<string, unknown> = { behavior: 'allow' };
  if (req.kind === 'question') decision.updatedInput = { ...req.toolInput, answers: answer.answers ?? {} };
  // O plano também precisa da entrada de volta para ser aprovado por um hook.
  else if (req.toolName === 'ExitPlanMode') decision.updatedInput = req.toolInput;
  if (answer.always && req.suggestions.length) decision.updatedPermissions = req.suggestions;
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/** Resumo do pedido numa linha: "Bash: npm test", "Editar src/app.ts", "Pergunta: Qual framework?". */
export function requestSummary(req: PendingRequest): string {
  const i = req.toolInput as Record<string, any>;
  if (req.kind === 'question') return `Pergunta: ${req.questions?.[0]?.question ?? ''}${(req.questions?.length ?? 0) > 1 ? ` (+${req.questions!.length - 1})` : ''}`;
  if (req.toolName === 'Bash' || req.toolName === 'PowerShell') return `${req.toolName}: ${String(i.command ?? '').slice(0, 200)}`;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(req.toolName)) return `${req.toolName === 'Write' ? 'Criar' : 'Editar'} ${String(i.file_path ?? i.notebook_path ?? '')}`;
  if (req.toolName === 'WebFetch') return `Abrir ${String(i.url ?? '')}`;
  if (req.toolName === 'ExitPlanMode') return 'Aprovar o plano';
  return req.toolName;
}

/** Texto da opção "não perguntar de novo": as regras sugeridas, como o terminal mostraria. */
export function alwaysLabel(req: PendingRequest): string | undefined {
  const rules = req.suggestions.flatMap((s) => (s.type === 'addRules' && s.behavior === 'allow' ? (s.rules ?? []) : []));
  if (!rules.length) return req.suggestions.length ? 'Permitir e não perguntar de novo' : undefined;
  return `Permitir e não perguntar de novo (${rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ')})`;
}
