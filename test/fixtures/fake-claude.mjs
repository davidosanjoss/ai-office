#!/usr/bin/env node
// Claude Code falso para os testes. Imita o que o escritório usa do real:
// - aceita --settings, --session-id, --resume, --append-system-prompt-file, --add-dir e --model;
// - dispara os hooks do --settings de verdade (o mesmo office-hook.mjs da produção);
// - grava o transcript em $AI_OFFICE_CLAUDE_DIR/projects só depois da primeira mensagem;
// - `--resume` de uma sessão sem transcript sai com o mesmo erro do real.
//
// Comandos digitados no terminal:
//   prompt <texto>  simula um pedido: UserPromptSubmit, PreToolUse(Read), PostToolUse, Stop e a statusline
//   [Sala de guerra] ...  idem: o escritório digita isso, e o Claude real trata como um pedido
//   ask             pede permissão (Notification permission_prompt)
//   pedir           pede permissão pelo hook PermissionRequest (Bash npm test) e mostra a decisão
//   perguntar       faz uma pergunta (AskUserQuestion) pelo mesmo hook e mostra a resposta
//   fundo <id>      deixa um comando em segundo plano (backgroundTaskId) e termina a vez
//   fundo-fim <id> <código>  grava no transcript o fim desse comando (<task-notification>)
//   gh pr | gh ci-falhou | gh ci-ok  o Bash rodou um comando do GitHub (PR aberto, CI vermelho, CI verde)
//   contexto <tokens> [min]  uma resposta com esse contexto no `usage`, feita há [min] minutos,
//                   e o Stop: mostra se o escritório bloqueou (stop=block) ou deixou parar (stop=ok)
//   /exit           encerra com código 0
// O SessionStart mostra o additionalContext que o escritório devolveu (contexto-inicial=...).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// `claude -p` (o resumo do dia): lê o pedido da entrada e responde uma linha, como o modo sem tela.
if (args.includes('-p')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    const projeto = /Projeto: (.*)/.exec(input)?.[1] ?? '?';
    process.stdout.write(`RESUMO de ${projeto} (modelo ${opt('--model')}): ${(input.match(/^- /gm) ?? []).length} itens.\n`);
  });
} else {
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

/** Roda os hooks do evento, como o real, e devolve a saída JSON do último que respondeu algo. */
function hook(event, payload = {}) {
  let output;
  for (const group of settings.hooks?.[event] ?? []) {
    for (const h of group.hooks) {
      const r = spawnSync(h.command, {
        shell: true,
        encoding: 'utf8',
        input: JSON.stringify({ session_id: sessionId, cwd: process.cwd(), hook_event_name: event, ...payload }),
      });
      if (r.stdout?.trim()) {
        try {
          output = JSON.parse(r.stdout);
        } catch {}
      }
    }
  }
  return output;
}

/**
 * Como o real depois de uma resposta: roda a statusline do --settings com o JSON da sessão. Os
 * rate_limits vêm de FAKE_RATE_LIMITS (JSON), como numa conta Pro; sem ela, não vêm (conta da API).
 */
function statusLine() {
  const cmd = settings.statusLine?.type === 'command' ? settings.statusLine.command : undefined;
  if (!cmd) return;
  const data = { session_id: sessionId, cwd: process.cwd(), model: { display_name: 'Falso' } };
  if (process.env.FAKE_RATE_LIMITS) data.rate_limits = JSON.parse(process.env.FAKE_RATE_LIMITS);
  const r = spawnSync(cmd, { shell: true, input: JSON.stringify(data), encoding: 'utf8' });
  if (r.stdout) out(`statusline=${r.stdout}\r\n`);
}

function transcriptPath() {
  return path.join(projects, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/** Uma linha do transcript no formato do real (JSONL com type e message.content). */
function writeTranscript(type, content) {
  fs.mkdirSync(path.dirname(transcriptPath()), { recursive: true });
  const line = JSON.stringify({ type, sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: type, content } });
  fs.appendFileSync(transcriptPath(), `${line}\n`);
}

const out = (s) => process.stdout.write(s);

out(`FAKE CLAUDE mode=${resumeId ? 'resume' : 'new'} session=${sessionId}\r\n`);
out(`child=${process.env.CLAUDE_CODE_CHILD_SESSION ?? 'none'} hooks=${settingsFile ? 'yes' : 'no'}\r\n`);
// Padrões do andar: o real esconde a co-autoria com attribution.commit vazio e lê as instruções do arquivo.
out(`coautoria=${settings.attribution?.commit === '' ? 'nao' : 'sim'}\r\n`);
// Modelos: o --model e, no modo raciocínio + execução, o que cada alias quer dizer.
const model = opt('--model');
if (model) out(`modelo=${model} opus=${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '-'} sonnet=${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '-'}\r\n`);
const addDirs = args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []));
if (addDirs.length) out(`add-dir=${addDirs.join(',')}\r\n`);
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

const started = hook('SessionStart', { source: resumeId ? 'resume' : 'startup' });
const initial = started?.hookSpecificOutput?.additionalContext;
if (initial) out(`contexto-inicial=${initial.split('\n')[0]} | transcript=${/em (\S+\.jsonl)/.exec(initial)?.[1] ?? '-'}\r\n`);
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
  if (cmd.startsWith('contexto ')) {
    // Uma resposta com o contexto informado no usage, como o real grava, e o fim da vez.
    const [tokens, min = '0'] = cmd.slice(9).trim().split(/\s+/);
    writeTranscript('user', 'continua');
    const ts = new Date(Date.now() - Number(min) * 60_000).toISOString();
    const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: Number(tokens) - 1010, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } };
    fs.appendFileSync(transcriptPath(), JSON.stringify({ type: 'assistant', sessionId, cwd: process.cwd(), timestamp: ts, message: { id: `msg_${Date.now()}`, role: 'assistant', model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'resposta grande' }] } }) + '\n');
    const stop = hook('Stop', { transcript_path: transcriptPath(), stop_hook_active: false });
    if (stop?.decision === 'block') {
      out(`stop=block arquivo=${/no arquivo (\S+\.md)/.exec(stop.reason)?.[1] ?? '-'}\r\n`);
      // Como o real: o motivo vira a próxima vez do agente, e o Stop dela vem com stop_hook_active.
      const again = hook('Stop', { transcript_path: transcriptPath(), stop_hook_active: true });
      out(`stop2=${again?.decision ?? 'ok'}\r\n`);
    } else out('stop=ok\r\n');
    return;
  }
  if (cmd.startsWith('fundo ')) {
    // Comando em segundo plano: o Bash devolve o backgroundTaskId e a vez termina.
    const id = cmd.slice(6).trim();
    writeTranscript('user', 'roda em segundo plano');
    hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Roda os testes', run_in_background: true }, tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id } });
    hook('Stop', { transcript_path: transcriptPath() });
    out(`fundo=${id}\r\n`);
    return;
  }
  if (cmd.startsWith('fundo-fim ')) {
    // O fim do comando, como o real grava no transcript (<task-notification> na fila).
    const [id, code] = cmd.slice(10).trim().split(/\s+/);
    const content = `<task-notification>\n<task-id>${id}</task-id>\n<status>${code === '0' ? 'completed' : 'failed'}</status>\n<summary>Background command "Roda os testes" ${code === '0' ? 'completed' : 'failed'} (exit code ${code})</summary>\n</task-notification>`;
    fs.appendFileSync(transcriptPath(), JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId, content }) + '\n');
    out(`fim=${id}\r\n`);
    return;
  }
  if (cmd.startsWith('gh ')) {
    // Eventos do GitHub: o comando e a saída que o Bash devolveria.
    const ev = cmd.slice(3).trim();
    const calls = {
      pr: ['gh pr create --fill', 'https://github.com/org/app/pull/12\n'],
      'ci-falhou': ['gh run watch 99 --exit-status', "X CI (99) completed with 'failure'\n"],
      'ci-ok': ['gh run watch 99 --exit-status', "✓ CI (99) completed with 'success'\n"],
    }[ev];
    hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: calls[0] }, tool_response: { stdout: calls[1], stderr: '', interrupted: false } });
    out(`gh=${ev}\r\n`);
    return;
  }
  if (cmd === 'pedir' || cmd === 'perguntar') {
    // Como o real ao precisar de permissão: roda os hooks PermissionRequest e espera a decisão
    // deles; sem decisão, o pedido fica no terminal ("decisao=terminal").
    const payload =
      cmd === 'pedir'
        ? {
            tool_name: 'Bash',
            tool_input: { command: 'npm test', description: 'Roda os testes' },
            permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }],
          }
        : {
            tool_name: 'AskUserQuestion',
            tool_input: { questions: [{ question: 'Qual banco?', header: 'Banco', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false }] },
          };
    let decided = '';
    for (const group of settings.hooks?.PermissionRequest ?? []) {
      for (const h of group.hooks) {
        const r = spawnSync(h.command, { shell: true, input: JSON.stringify({ session_id: sessionId, cwd: process.cwd(), hook_event_name: 'PermissionRequest', ...payload }), encoding: 'utf8' });
        if (r.stdout?.trim()) decided = r.stdout.trim();
      }
    }
    out(`decisao=${decided ? JSON.stringify(JSON.parse(decided).hookSpecificOutput.decision) : 'terminal'}\r\n`);
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
    statusLine();
    out(`${reply}\r\n`);
    out('\x1b[c');
    return;
  }
  if (cmd) out(`não entendi: ${cmd}\r\n`);
}
}
