import { fileURLToPath } from 'node:url';
import type { Agent } from '../shared/types.ts';
import type { UsageRecord } from '../shared/usage.ts';
import { codexMemory } from './memory.ts';

const hookScript = fileURLToPath(new URL('../hooks/office-hook.mjs', import.meta.url));
const lifecycle = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop'];

export function codexArgs(agent: Agent, resume: boolean, model: string | undefined, instructionsFile: string): string[] {
  const args = resume ? ['resume'] : [];
  args.push('--no-daemon', '--no-alt-screen');
  if (model) args.push('--model', model);
  const config = (key: string, value: unknown) => args.push('-c', `${key}=${JSON.stringify(value)}`);
  config('developer_instructions', `Leia as instruções da sua sala em ${instructionsFile}.`);
  const command = process.platform === 'win32'
    ? `"${process.execPath}" "${hookScript}"`
    : [process.execPath, hookScript].map((part) => "'" + part.replaceAll("'", "'\\''") + "'").join(' ');
  for (const event of lifecycle) {
    // As chaves do TOML são fixas. JSON serve para escapar o valor da string.
    args.push('-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(`${command} ${event}`)},timeout=5}]}]`);
  }
  const memory = codexMemory();
  if (memory) {
    config('mcp_servers.ai-office-memory.command', memory.file);
    config('mcp_servers.ai-office-memory.args', memory.args);
    for (const [key, value] of Object.entries(memory.env)) config(`mcp_servers.ai-office-memory.env.${key}`, value);
  }
  if (resume) args.push(agent.sessionId);
  return args;
}

export interface CodexUsageState {
  session?: string;
  cwd?: string;
  model?: string;
  totals?: string;
}

export function codexUsageLine(line: string, state: CodexUsageState): UsageRecord | undefined {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const p = event?.payload;
  if (!p) return;
  if (event.type === 'session_meta') {
    state.session = p.id;
    state.cwd = p.cwd;
    return;
  }
  if (event.type === 'turn_context') {
    state.model = p.model;
    return;
  }
  if (event.type !== 'event_msg' || p.type !== 'token_count' || !p.info?.last_token_usage) return;
  const total = p.info.total_token_usage;
  const snapshot = total && [total.input_tokens, total.output_tokens, total.reasoning_output_tokens, total.cached_input_tokens].join(':');
  if (!snapshot || !state.session || snapshot === state.totals) return;
  const ts = Date.parse(event.timestamp);
  if (!Number.isFinite(ts)) return;
  state.totals = snapshot;
  const u = p.info.last_token_usage;
  const cacheRead = Math.min(u.cached_input_tokens ?? 0, u.input_tokens ?? 0);
  return {
    source: 'codex', id: `${state.session}:${snapshot}`, session: state.session, ts,
    cwd: state.cwd ?? '', model: state.model ?? 'desconhecido',
    input: (u.input_tokens ?? 0) - cacheRead,
    output: (u.output_tokens ?? 0) + (p.info.last_usage_includes_reasoning === false ? u.reasoning_output_tokens ?? 0 : 0),
    cacheRead, cacheWrite5m: 0, cacheWrite1h: 0,
  };
}
