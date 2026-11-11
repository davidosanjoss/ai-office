#!/usr/bin/env node
// Docker falso para os testes do ai-memory: guarda os containers num JSON e anota as chamadas.
// FAKE_DOCKER_DOWN=1 imita o Docker instalado mas parado; FAKE_DOCKER_SLOW_INSPECT=ms deixa a consulta da imagem lenta.
import fs from 'node:fs';
import path from 'node:path';

const tmp = process.env.AI_OFFICE_TMP;
const stateFile = path.join(tmp, 'docker-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { containers: {} };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(tmp, 'docker-calls.jsonl'), JSON.stringify(args) + '\n');
const fail = (msg) => {
  process.stderr.write(msg + '\n');
  process.exit(1);
};

if (process.env.FAKE_DOCKER_DOWN === '1') fail('Cannot connect to the Docker daemon. Is the docker daemon running?');
const [cmd, ...rest] = args;
if (cmd === 'version') console.log('27.0.0');
else if (cmd === 'pull') console.log(`Status: Downloaded newer image for ${rest[0]}`);
else if (cmd === 'container' && rest[0] === 'inspect') {
  const c = state.containers[rest.at(-1)];
  if (!c) fail(`Error: No such container: ${rest.at(-1)}`);
  // FAKE_DOCKER_SLOW_INSPECT=ms: a consulta da imagem demora (como um Docker ocupado).
  if (process.env.FAKE_DOCKER_SLOW_INSPECT && rest.some((a) => a.includes('.Config.Image'))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DOCKER_SLOW_INSPECT));
  }
  // --format '{{.Config.Image}}' ou '{{.State.Running}}'.
  console.log(rest.some((a) => a.includes('.Config.Image')) ? c.image : String(c.running));
} else if (cmd === 'run' && rest.includes('--rm') && rest.at(-1) === 'init') {
  // init: cria o token na pasta montada em /data.
  const host = rest[rest.indexOf('-v') + 1].replace(/:\/data$/, '');
  fs.mkdirSync(path.join(host, 'auth-tokens'), { recursive: true });
  fs.writeFileSync(path.join(host, 'auth-tokens', 'default'), 'token-falso');
  console.log('Generated a root bearer token');
} else if (cmd === 'run' && rest.includes('-d')) {
  const name = rest[rest.indexOf('--name') + 1];
  if (state.containers[name]) fail(`Conflict. The container name "/${name}" is already in use`);
  state.containers[name] = { running: true, image: rest.at(-1), args: rest };
  save();
  console.log('abc123');
} else if (cmd === 'start') {
  state.containers[rest[0]].running = true;
  save();
} else if (cmd === 'stop') {
  if (state.containers[rest[0]]) state.containers[rest[0]].running = false;
  save();
} else if (cmd === 'rm') {
  delete state.containers[rest.at(-1)];
  save();
} else fail(`fake-docker: comando não esperado: ${args.join(' ')}`);
