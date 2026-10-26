// `npm run app`: sobe o servidor (se ainda não estiver rodando) e abre o escritório
// numa janela própria, sem abas nem barra de endereço, usando o modo --app dos
// navegadores baseados em Chromium (Opera, Edge, Chrome, Brave, Vivaldi...).

import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './browser.ts';
import { PORT, isWindows } from './platform.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = `http://localhost:${PORT}`;

async function serverUp() {
  try {
    const res = await fetch(`${URL}/api/projects`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

function openWindow() {
  const browser = findBrowser();
  if (!browser) {
    console.log(`Nenhum navegador baseado em Chromium encontrado. Abra ${URL} no seu navegador.`);
    const opener = isWindows ? ['cmd', '/c', 'start', '', URL] : process.platform === 'darwin' ? ['open', URL] : ['xdg-open', URL];
    spawn(opener[0], opener.slice(1), { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const [file, ...pre] = browser;
  console.log(`Abrindo o escritório com ${path.basename(file)}…`);
  spawn(file, [...pre, `--app=${URL}`], { detached: true, stdio: 'ignore' }).unref();
}

if (await serverUp()) {
  openWindow();
} else {
  // Recompila sempre (leva menos de um segundo) para não abrir uma interface desatualizada.
  console.log('Compilando a interface…');
  // shell: true para achar o npm.cmd no Windows; comando inteiro numa string, sem argumentos soltos.
  spawnSync('npm run build --silent', { cwd: ROOT, stdio: 'inherit', shell: true });
  await import('./index.ts');
  openWindow();
  console.log(`Feche este terminal (ou Ctrl+C) para encerrar o escritório e os agentes. ${os.EOL}`);
}
