// Roda antes de cada arquivo de teste, antes de importar o código do servidor:
// tudo aponta para pastas temporárias e para o Claude falso, nunca para o seu ~/.claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
process.env.AI_OFFICE_TMP = tmp;
process.env.AI_OFFICE_DATA = path.join(tmp, 'data');
process.env.AI_OFFICE_CLAUDE_DIR = path.join(tmp, 'claude');
process.env.AI_OFFICE_CLAUDE_BIN = path.resolve('test/fixtures/fake-claude.mjs');
process.env.AI_OFFICE_GH_BIN = path.resolve('test/fixtures/fake-gh.mjs');
process.env.AI_OFFICE_PORT = '7431';
// ai-memory: Docker e comando falsos, pastas temporárias e, por padrão, servidor fora do ar
// (porta 1). Nunca o Docker, o ~/.claude.json ou a pasta de dados reais.
process.env.AI_OFFICE_DOCKER_BIN = path.resolve('test/fixtures/fake-docker.mjs');
process.env.AI_OFFICE_MEMORY_DATA = path.join(tmp, 'memoria');
process.env.AI_OFFICE_MEMORY_BIN = path.join(tmp, 'bin', 'ai-memory.mjs');
process.env.AI_OFFICE_MEMORY_RELEASE = path.join(tmp, 'release');
process.env.AI_OFFICE_MEMORY_URL = 'http://127.0.0.1:1';
process.env.AI_OFFICE_CLAUDE_JSON = path.join(tmp, 'claude.json');
// Identidade para os commits de merge que o escritório faz nos repositórios de teste (o CI não tem uma).
for (const k of ['AUTHOR', 'COMMITTER']) {
  process.env[`GIT_${k}_NAME`] = 'Teste';
  process.env[`GIT_${k}_EMAIL`] = 'teste@example.com';
}
process.env.AI_OFFICE_SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
fs.mkdirSync(process.env.AI_OFFICE_CLAUDE_DIR, { recursive: true });
