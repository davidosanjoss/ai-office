#!/usr/bin/env node
// Hook PermissionRequest das sessões do escritório: mostra o pedido (permissão ou pergunta) no
// escritório e espera a sua resposta lá. Enquanto isso, o terminal continua perguntando: vale o
// que for respondido primeiro. Sem escritório aberto, sem resposta em 5 minutos ou com qualquer
// erro, sai sem dizer nada, e o pedido segue pelo terminal como sempre.

const url = process.env.AI_OFFICE_URL;
const agentId = process.env.AI_OFFICE_AGENT_ID;
const LIMIT_MS = Number(process.env.AI_OFFICE_PERMISSION_TIMEOUT ?? 300) * 1000;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', async () => {
  if (!url) return;
  let payload = {};
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    return;
  }
  const end = Date.now() + LIMIT_MS;
  let id;
  try {
    const res = await fetch(`${url}/api/pedidos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, payload }),
      signal: AbortSignal.timeout(2000),
    });
    id = (await res.json()).id;
  } catch {}
  if (!id) return;
  while (Date.now() < end) {
    try {
      const wait = Math.min(25_000, end - Date.now());
      const res = await fetch(`${url}/api/pedidos/${id}/espera?ms=${wait}`, { signal: AbortSignal.timeout(wait + 5000) });
      const data = await res.json();
      if (data.output) {
        process.stdout.write(JSON.stringify(data.output));
        return;
      }
      if (data.gone) return;
    } catch {
      return;
    }
  }
  // Tempo esgotado: o cartão sai do escritório e o pedido fica só no terminal.
  try {
    await fetch(`${url}/api/pedidos/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(2000) });
  } catch {}
});
