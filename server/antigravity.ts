import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent } from '../shared/types.ts';
import type { UsageRecord } from '../shared/usage.ts';
import { agyWiring, memoryBridge } from './memory.ts';
import { ANTIGRAVITY_CONFIG_DIR, ANTIGRAVITY_DIR } from './platform.ts';

const hookScript = fileURLToPath(new URL('../hooks/office-hook.mjs', import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prompts de sala pendentes para injetar no SessionStart de cada agente Antigravity. */
const promptFiles = new Map<string, string>();
/** Mapeamento em memória de conversationId → cwd (para consumo antes do SQLite atualizar). */
const knownCwds = new Map<string, string>();

export function setAgyPrompt(agentId: string, file: string) {
  promptFiles.set(agentId, file);
}

export function readAgyPrompt(agentId: string): string | undefined {
  const file = promptFiles.get(agentId);
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function rememberAgySession(conversationId: string, cwd: string) {
  if (conversationId && cwd) knownCwds.set(conversationId, cwd);
}

export function isAgyConversationId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function hookCommand(event: string): string {
  const base =
    process.platform === 'win32'
      ? `"${process.execPath}" "${hookScript}"`
      : [process.execPath, hookScript].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' ');
  return `${base} ${event} antigravity`;
}

export function agyPluginDir(configDir = ANTIGRAVITY_CONFIG_DIR): string {
  return path.join(configDir, 'plugins', 'ai-office');
}

/**
 * Mantém o plugin local do AI Office em ~/.gemini/config/plugins/ai-office:
 * - hooks de ciclo de vida (só enviam eventos quando AI_OFFICE_URL está definida; fora do escritório devolvem `{}`);
 * - ponte MCP do ai-memory quando o ai-memory existe na máquina mas ainda não está ligado no mcp_config.json global.
 */
export function ensureAgyPlugin(configDir = ANTIGRAVITY_CONFIG_DIR): string {
  const dir = agyPluginDir(configDir);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'plugin.json'), { name: 'ai-office', version: '1.0.0' });
  writeJsonAtomic(path.join(dir, 'hooks.json'), {
    'ai-office': {
      SessionStart: [{ type: 'command', command: hookCommand('SessionStart'), timeout: 10 }],
      PreInvocation: [{ type: 'command', command: hookCommand('PreInvocation'), timeout: 5 }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand('PreToolUse'), timeout: 5 }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand('PostToolUse'), timeout: 5 }] }],
      Stop: [{ type: 'command', command: hookCommand('Stop'), timeout: 10 }],
    },
  });
  const mcpFile = path.join(dir, 'mcp_config.json');
  const bridge = !agyWiring(configDir).mcp ? memoryBridge() : undefined;
  if (bridge) {
    const env = Object.fromEntries(
      Object.entries(bridge.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    writeJsonAtomic(mcpFile, {
      mcpServers: {
        'ai-office-memory': {
          command: bridge.file,
          args: bridge.args,
          env,
        },
      },
    });
  } else {
    fs.rmSync(mcpFile, { force: true });
  }
  return dir;
}

export function removeAgyPluginMcp(configDir = ANTIGRAVITY_CONFIG_DIR) {
  fs.rmSync(path.join(agyPluginDir(configDir), 'mcp_config.json'), { force: true });
}

function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.ai-office-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** Argumentos do `agy`: retoma a conversa pelo ID, aplica o modelo do projeto e adiciona pastas da sala. */
export function antigravityArgs(agent: Pick<Agent, 'sessionId'>, resume: boolean, model: string | undefined, addDirs: string[] = []): string[] {
  const args: string[] = [];
  if (resume && agent.sessionId) args.push('--conversation', agent.sessionId);
  if (model) args.push('--model', model);
  for (const dir of addDirs) args.push('--add-dir', dir);
  return args;
}

/** Extrai o ID da conversa de `<agyDir>/brain/<id>/.system_generated/logs/transcript.jsonl`. */
export function antigravitySessionId(file: string, agyDir = ANTIGRAVITY_DIR): string | undefined {
  if (path.basename(file) !== 'transcript.jsonl') return undefined;
  const rel = path.relative(path.join(agyDir, 'brain'), file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const parts = rel.split(path.sep);
  return parts.length >= 2 && parts[0] ? parts[0] : undefined;
}

/**
 * Converte a primeira URI de `workspace_uris` (JSON array como `["file:///home/..."]`) em caminho local.
 */
export function workspaceFromUris(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return '';
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) continue;
      if (item.startsWith('file://')) {
        try {
          return fileURLToPath(item);
        } catch {
          // No Windows, uma URI sem letra de unidade ("file:///tmp/x") não é caminho absoluto para o
          // fileURLToPath: usa o caminho da URI mesmo, resolvido na unidade atual.
          try {
            return path.resolve(decodeURIComponent(new URL(item).pathname));
          } catch {
            continue;
          }
        }
      }
      return item;
    }
  } catch {}
  return '';
}

/**
 * Mapeia conversation_id → pasta de trabalho lendo `conversation_summaries.db` (somente leitura)
 * e completando com sessões registradas em memória / agentes do escritório.
 */
export async function antigravityWorkspaces(agyDir = ANTIGRAVITY_DIR, fallback: Iterable<[string, string]> = []): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dbFile = path.join(agyDir, 'conversation_summaries.db');
  if (fs.existsSync(dbFile)) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const rows = db.prepare('SELECT conversation_id, workspace_uris FROM conversation_summaries').all() as {
          conversation_id?: unknown;
          workspace_uris?: unknown;
        }[];
        for (const row of rows) {
          const id = typeof row.conversation_id === 'string' ? row.conversation_id : '';
          const cwd = workspaceFromUris(row.workspace_uris);
          if (id && cwd) out.set(id, cwd);
        }
      } finally {
        db.close();
      }
    } catch {}
  }
  for (const [id, cwd] of knownCwds) if (id && cwd) out.set(id, cwd);
  for (const [id, cwd] of fallback) if (id && cwd) out.set(id, cwd);
  return out;
}

/** Uma linha do transcript.jsonl do Antigravity → registro de consumo, quando é um PLANNER_RESPONSE com tokens. */
export function antigravityUsageLine(line: string, session: string, cwd: string): UsageRecord | undefined {
  if (!line.includes('"PLANNER_RESPONSE"')) return undefined;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (d?.type !== 'PLANNER_RESPONSE' || typeof d.model !== 'string' || !d.model.trim()) return undefined;
  if (typeof d.step_index !== 'number' || !Number.isFinite(d.step_index)) return undefined;
  const ts = Date.parse(d.created_at);
  if (!Number.isFinite(ts)) return undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const input = n(d.input_tokens);
  const output = n(d.output_tokens);
  const cacheRead = n(d.cache_read_tokens);
  if (input + output + cacheRead === 0) return undefined;
  return {
    source: 'antigravity',
    id: `${session}:${d.step_index}`,
    session,
    ts,
    cwd,
    model: d.model.trim(),
    input,
    output,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead,
  };
}

/** Última resposta textual do agente num transcript.jsonl do Antigravity (para a sala de guerra). */
export function antigravityLastText(jsonl: string): string {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let d: any;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (d?.type === 'USER_INPUT') break;
    if (d?.type !== 'PLANNER_RESPONSE') continue;
    if (typeof d.content === 'string' && d.content.trim()) return d.content.trim();
  }
  return '';
}
