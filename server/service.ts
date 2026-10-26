// `npm run service:install | service:uninstall | service:status`
// Deixa o escritório sempre ligado: sobe sozinho quando você entra no computador.
//   Linux:   serviço de usuário do systemd (~/.config/systemd/user/ai-office.service)
//   Windows: script na pasta Inicializar (não precisa de administrador)
//   macOS:   LaunchAgent (~/Library/LaunchAgents/dev.ai-office.plist)

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT } from './platform.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface ServiceSpec {
  /** Pasta do projeto. */
  root: string;
  node: string;
  /** PATH com o claude, o git e o node, copiado de quem instalou. */
  pathEnv: string;
  home: string;
}

/** Comando que sobe o servidor: o tsx do projeto rodando server/index.ts. */
function command(s: ServiceSpec, sep = path.sep) {
  const join = (...p: string[]) => p.join(sep);
  return [s.node, join(s.root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(s.root, 'server', 'index.ts')];
}

export function systemdUnit(s: ServiceSpec): string {
  const q = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
  return `[Unit]
Description=AI Office: escritório dos agentes do Claude Code
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
WorkingDirectory=${q(s.root)}
ExecStart=${command(s, '/').map(q).join(' ')}
Environment=PATH=${s.pathEnv.replace(/%/g, '%%')}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
`;
}

/** VBScript que roda o servidor sem abrir janela de console. */
export function windowsStartupScript(s: ServiceSpec): string {
  const cmd = command(s, '\\')
    .map((a) => `""${a}""`)
    .join(' ');
  return `' AI Office: sobe o escritório ao entrar no Windows (npm run service:uninstall remove)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "${s.root}"
sh.Run "${cmd}", 0, False
`;
}

export function launchAgentPlist(s: ServiceSpec): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const args = command(s, '/')
    .map((a) => `    <string>${esc(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.ai-office</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${esc(s.root)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(s.pathEnv)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.posix.join(s.home, '.ai-office', 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.posix.join(s.home, '.ai-office', 'server.log'))}</string>
</dict>
</plist>
`;
}

export function serviceFile(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'ai-office.vbs');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'LaunchAgents', 'dev.ai-office.plist');
  return path.posix.join(env.XDG_CONFIG_HOME ?? path.posix.join(home, '.config'), 'systemd', 'user', 'ai-office.service');
}

async function serverUp() {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/api/projects`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Falhou: ${cmd} ${args.join(' ')}`);
}

async function install() {
  const spec: ServiceSpec = { root: ROOT, node: process.execPath, pathEnv: process.env.PATH ?? '', home: os.homedir() };
  const file = serviceFile(process.platform, spec.home);
  console.log('Compilando a interface…');
  spawnSync('npm run build --silent', { cwd: ROOT, stdio: 'inherit', shell: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (process.platform === 'win32') {
    fs.writeFileSync(file, windowsStartupScript(spec));
    console.log(`Instalado: ${file}`);
    if (!(await serverUp())) run('wscript.exe', [file]);
  } else if (process.platform === 'darwin') {
    fs.writeFileSync(file, launchAgentPlist(spec));
    spawnSync('launchctl', ['unload', file]);
    run('launchctl', ['load', '-w', file]);
    console.log(`Instalado: ${file}`);
  } else {
    fs.writeFileSync(file, systemdUnit(spec));
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', 'ai-office.service']);
    console.log(`Instalado: ${file}`);
    if (await serverUp()) {
      console.log(`\nJá tem um escritório rodando na porta ${PORT} (aberto por "npm start"/"npm run app").`);
      console.log('Ele continua; o serviço assume no próximo login. Para trocar agora, feche o outro e rode:');
      console.log('  systemctl --user start ai-office');
    } else {
      run('systemctl', ['--user', 'start', 'ai-office.service']);
    }
  }
  console.log(`\nPronto: o escritório sobe sozinho ao entrar no computador. Endereço: http://localhost:${PORT}`);
}

function uninstall() {
  const file = serviceFile(process.platform, os.homedir());
  if (process.platform === 'darwin') spawnSync('launchctl', ['unload', file]);
  if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'ai-office.service'], { stdio: 'inherit' });
  }
  if (fs.existsSync(file)) fs.rmSync(file);
  if (process.platform === 'linux') spawnSync('systemctl', ['--user', 'daemon-reload']);
  console.log(`Removido: ${file}`);
  if (process.platform === 'win32') console.log('O servidor atual continua até você sair do Windows (ou encerre o node.exe).');
}

async function status() {
  const file = serviceFile(process.platform, os.homedir());
  console.log(`Instalado: ${fs.existsSync(file) ? `sim (${file})` : 'não'}`);
  console.log(`Rodando:   ${(await serverUp()) ? `sim, http://localhost:${PORT}` : 'não'}`);
  if (process.platform === 'linux' && fs.existsSync(file)) {
    try {
      console.log(`systemd:   ${execFileSync('systemctl', ['--user', 'is-active', 'ai-office.service']).toString().trim()}`);
    } catch {
      console.log('systemd:   inativo');
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === 'install') await install();
  else if (action === 'uninstall') uninstall();
  else await status();
}
