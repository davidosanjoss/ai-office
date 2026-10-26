import { describe, expect, it } from 'vitest';
import { launchAgentPlist, serviceFile, systemdUnit, windowsStartupScript, type ServiceSpec } from '../server/service.ts';

const linux: ServiceSpec = { root: '/home/ana/ai-office', node: '/usr/bin/node', pathEnv: '/home/ana/.local/bin:/usr/bin', home: '/home/ana' };

describe('serviço do systemd (Linux)', () => {
  const unit = systemdUnit(linux);

  it('roda o servidor com o tsx do projeto', () => {
    expect(unit).toContain('ExecStart=/usr/bin/node /home/ana/ai-office/node_modules/tsx/dist/cli.mjs /home/ana/ai-office/server/index.ts');
    expect(unit).toContain('WorkingDirectory=/home/ana/ai-office');
  });

  it('leva o PATH de quem instalou, para achar o claude e o git', () => {
    expect(unit).toContain('Environment=PATH=/home/ana/.local/bin:/usr/bin');
  });

  it('sobe com a sessão gráfica (o seletor de pastas precisa dela) e reinicia se cair', () => {
    expect(unit).toContain('WantedBy=graphical-session.target');
    expect(unit).toContain('Restart=on-failure');
  });

  it('escapa % (especificador do systemd) e caminhos com espaço', () => {
    const u = systemdUnit({ ...linux, root: '/home/ana/meus projetos/ai-office', pathEnv: '/a%b' });
    expect(u).toContain('Environment=PATH=/a%%b');
    expect(u).toContain('WorkingDirectory="/home/ana/meus projetos/ai-office"');
    expect(u).toContain('"/home/ana/meus projetos/ai-office/server/index.ts"');
  });

  it('arquivo em ~/.config/systemd/user', () => {
    expect(serviceFile('linux', '/home/ana', {})).toBe('/home/ana/.config/systemd/user/ai-office.service');
    expect(serviceFile('linux', '/home/ana', { XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/systemd/user/ai-office.service');
  });
});

describe('Windows', () => {
  const win: ServiceSpec = { root: 'C:\\Users\\Ana\\ai-office', node: 'C:\\Program Files\\nodejs\\node.exe', pathEnv: '', home: 'C:\\Users\\Ana' };

  it('script na pasta Inicializar, sem janela de console', () => {
    const vbs = windowsStartupScript(win);
    expect(vbs).toContain('sh.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\Ana\\ai-office\\node_modules\\tsx\\dist\\cli.mjs""');
    expect(vbs).toContain(', 0, False');
    expect(serviceFile('win32', win.home, { APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming' })).toBe(
      'C:\\Users\\Ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\ai-office.vbs',
    );
  });
});

describe('macOS', () => {
  it('LaunchAgent que sobe no login e se mantém vivo', () => {
    const plist = launchAgentPlist({ ...linux, home: '/Users/ana', root: '/Users/ana/a&b' });
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<string>/Users/ana/a&amp;b/server/index.ts</string>');
    expect(serviceFile('darwin', '/Users/ana')).toBe('/Users/ana/Library/LaunchAgents/dev.ai-office.plist');
  });
});
