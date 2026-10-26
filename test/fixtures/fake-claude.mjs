#!/usr/bin/env node
// Claude Code falso para os testes. Imita o que o escritório usa do real:
// - aceita --settings, --session-id e --resume;
// - dispara os hooks do --settings de verdade (o mesmo office-hook.mjs da produção);
// - grava o transcript em $AI_OFFICE_CLAUDE_DIR/projects só depois da primeira mensagem;
// - `--resume` de uma sessão sem transcript sai com o mesmo erro do real.
//
// Comandos digitados no terminal:
//   prompt <texto>  simula um pedido: UserPromptSubmit, PreToolUse(Read), PostToolUse, Stop
//   ask             pede permissão (Notification permission_prompt)
//   /exit           encerra com código 0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const resumeId = opt('--resume');
const sessionId = resumeId ?? opt('--session-id');
const settingsFile = opt('--settings');
const projects = path.join(process.env.AI_OFFICE_CLAUDE_DIR ?? '.', 'projects');

function transcriptExists() {
  if (!fs.existsSync(projects)) return false;
  return fs.readdirSync(projects).some((d) => fs.existsSync(path.join(projects, d, `${sessionId}.jsonl`)));
}

if (process.env.FAKE_CLAUDE_FAIL) {
  process.stdout.write(`\x1b[31m${process.env.FAKE_CLAUDE_FAIL}\x1b[0m\r\n`);
  process.exit(2);
}

if (resumeId && !transcriptExists()) {
  process.stdout.write(`No conversation found with session ID: ${resumeId}\r\n`);
  process.exit(1);
}

const settings = settingsFile ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : { hooks: {} };

function hook(event, payload = {}) {
  for (const group of settings.hooks?.[event] ?? []) {
    for (const h of group.hooks) {
      spawnSync(h.command, {
        shell: true,
        input: JSON.stringify({ session_id: sessionId, cwd: process.cwd(), hook_event_name: event, ...payload }),
      });
    }
  }
}

function writeTranscript(text) {
  const dir = path.join(projects, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ type: 'user', sessionId, cwd: process.cwd(), message: text });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), `${line}\n`);
}

const out = (s) => process.stdout.write(s);

out(`FAKE CLAUDE mode=${resumeId ? 'resume' : 'new'} session=${sessionId}\r\n`);
out(`child=${process.env.CLAUDE_CODE_CHILD_SESSION ?? 'none'} hooks=${settingsFile ? 'yes' : 'no'}\r\n`);
// Consulta de atributos do terminal, como o Claude real faz: o xterm responde sozinho.
out('\x1b[c');
hook('SessionStart', { source: resumeId ? 'resume' : 'startup' });
out('> ');

let line = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  // Respostas automáticas do terminal (ESC ...) não são digitação.
  if (data.startsWith('\x1b')) return;
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      out('\r\n');
      run(line.trim());
      line = '';
      out('> ');
    } else if (ch === '\x7f') {
      line = line.slice(0, -1);
    } else {
      line += ch;
      out(ch);
    }
  }
});

function run(cmd) {
  if (cmd === '/exit') {
    hook('SessionEnd', { reason: 'exit' });
    out('tchau\r\n');
    process.exit(0);
  }
  if (cmd === 'ask') {
    hook('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
    return;
  }
  if (cmd.startsWith('prompt ')) {
    const text = cmd.slice(7);
    writeTranscript(text);
    hook('UserPromptSubmit', { prompt: text });
    hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(process.cwd(), 'README.md') } });
    hook('PostToolUse', { tool_name: 'Read' });
    hook('Stop', {});
    out(`feito: ${text}\r\n`);
    out('\x1b[c');
    return;
  }
  if (cmd) out(`não entendi: ${cmd}\r\n`);
}
