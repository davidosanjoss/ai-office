#!/usr/bin/env node
// Hook do Claude Code: repassa o evento para o servidor do AI Office.
// Nunca bloqueia nem falha a sessão: qualquer erro termina com código 0.

const [, , eventName] = process.argv;
const url = process.env.AI_OFFICE_URL;
const agentId = process.env.AI_OFFICE_AGENT_ID;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  if (!url) return;
  let payload = {};
  try {
    payload = JSON.parse(input || '{}');
  } catch {}
  try {
    await fetch(`${url}/api/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: eventName, agentId, payload }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {}
});
