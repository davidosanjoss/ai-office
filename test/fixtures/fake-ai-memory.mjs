#!/usr/bin/env node
// Comando `ai-memory` falso para os testes: liga e desliga o ai-memory nas configurações do
// Claude Code das pastas temporárias, como o install-mcp / install-hooks / uninstall reais.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
fs.appendFileSync(
  path.join(process.env.AI_OFFICE_TMP, 'ai-memory-calls.jsonl'),
  JSON.stringify({ args, image: process.env.AI_MEMORY_IMAGE, dataDir: process.env.AI_MEMORY_DATA_DIR }) + '\n',
);
const settingsFile = path.join(process.env.AI_OFFICE_CLAUDE_DIR, 'settings.json');
const claudeJson = process.env.AI_OFFICE_CLAUDE_JSON;
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
const write = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

if (args[0] === 'install-mcp') {
  const c = read(claudeJson);
  c.mcpServers = { ...c.mcpServers, 'ai-memory': { type: 'stdio', command: 'ai-memory', args: ['mcp-bridge'] } };
  write(claudeJson, c);
} else if (args[0] === 'install-hooks') {
  const s = read(settingsFile);
  s.hooks = { ...s.hooks, Stop: [{ hooks: [{ type: 'command', command: 'ai-memory hook --event stop --agent claude-code' }] }] };
  write(settingsFile, s);
} else if (args[0] === 'uninstall') {
  const c = read(claudeJson);
  delete c.mcpServers?.['ai-memory'];
  write(claudeJson, c);
  const s = read(settingsFile);
  delete s.hooks?.Stop;
  write(settingsFile, s);
} else {
  process.stderr.write(`fake-ai-memory: comando não esperado: ${args.join(' ')}\n`);
  process.exit(2);
}
console.log(`✓ ${args[0]}`);
