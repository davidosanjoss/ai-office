#!/usr/bin/env node
// Claude Code falso para os testes. Imita o que o escritório usa do real:
// - aceita --settings, --session-id, --resume e --append-system-prompt-file;
// - dispara os hooks do --settings de verdade (o mesmo office-hook.mjs da produção);
// - grava o transcript em $AI_OFFICE_CLAUDE_DIR/projects só depois da primeira mensagem;
// - `--resume` de uma sessão sem transcript sai com o mesmo erro do real.
//
// Comandos digitados no terminal:
//   prompt <texto>  simula um pedido: UserPromptSubmit, PreToolUse(Read), PostToolUse, Stop
//   [Sala de guerra] ...  idem: o escritório digita isso, e o Claude real trata como um pedido
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
const promptFile = opt('--append-system-prompt-file');
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

function transcriptPath() {
  return path.join(projects, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/** Uma linha do transcript no formato do real (JSONL com type e message.content). */
function writeTranscript(type, content) {
  fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true });
  const line = JSON.stringify({ type, sessionId, cwd: process.cwd(), message: { role: type, content } });
  fs.appendFileSync(transcriptPath(), `${line}\n`);
}

const out = (s) => process.stdout.write(s);

out(`FAKE CLAUDE mode=${resumeId ? 'resume' : 'new'} session=${sessionId}\r\n`);
out(`child=${process.env.CLAUDE_CODE_CHILD_SESSION ?? 'none'} hooks=${settingsFile ? 'yes' : 'no'}\r\n`);
// Padrões do andar: o real esconde a co-autoria com attribution.commit vazio e lê as instruções do arquivo.
out(`coautoria=${settings.attribution?.commit === '' ? 'nao' : 'sim'}\r\n`);
if (promptFile) out(`instrucoes=${fs.readFileSync(promptFile, 'utf8').replace(/\r?\n/g, ' | ')}\r\n`);
// Consulta de atributos do terminal, como o Claude real faz: o xterm responde sozinho.
out('\x1b[c');

// Começa a ler o teclado ANTES de avisar que está pronto, como o Claude real. No Windows
// (ConPTY), o que é digitado antes do modo raw ser ligado se perde.
let line = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (raw) => {
  // Respostas automáticas do terminal (ESC [ ... ) não são digitação. Remove só elas: no Windows
  // a resposta e o que foi digitado podem chegar juntos no mesmo pedaço.
  const data = raw.replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, '').replace(/\x1b./g, '');
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

hook('SessionStart', { source: resumeId ? 'resume' : 'startup' });
out('> ');

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
  if (cmd.startsWith('prompt ') || cmd.startsWith('[Sala de guerra]')) {
    const text = cmd.startsWith('prompt ') ? cmd.slice(7) : cmd;
    const reply = `feito: ${text}`;
    writeTranscript('user', text);
    hook('UserPromptSubmit', { prompt: text });
    // Como o real: a ferramenta, o resultado e só depois o texto final da resposta.
    writeTranscript('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]);
    hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(process.cwd(), 'README.md') } });
    writeTranscript('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
    hook('PostToolUse', { tool_name: 'Read' });
    writeTranscript('assistant', [{ type: 'text', text: reply }]);
    hook('Stop', { transcript_path: transcriptPath() });
    out(`${reply}\r\n`);
    out('\x1b[c');
    return;
  }
  if (cmd) out(`não entendi: ${cmd}\r\n`);
}
