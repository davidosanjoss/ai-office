#!/usr/bin/env node
// Hook do Claude Code: repassa o evento para o servidor do AI Office. Quando o escritório decide
// algo (Stop: gravar a memória com o contexto grande; SessionStart: o resumo da sessão nova), a
// decisão vai para a saída. Nunca falha a sessão: qualquer erro termina com código 0, sem saída.

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
  // Stop e SessionStart esperam a decisão (o servidor lê o fim do transcript); os outros só avisam.
  const decides = eventName === 'Stop' || eventName === 'SessionStart';
  try {
    const res = await fetch(`${url}/api/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: eventName, agentId, payload }),
      signal: AbortSignal.timeout(decides ? 8000 : 1500),
    });
    if (decides) {
      const data = await res.json();
      if (data?.output) process.stdout.write(JSON.stringify(data.output));
    }
  } catch {}
});
