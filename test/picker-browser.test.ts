import { describe, expect, it } from 'vitest';
import { findBrowser, type BrowserEnv } from '../server/browser.ts';
import { dialogCommand } from '../server/picker.ts';

const has =
  (...names: string[]) =>
  (cmd: string) =>
    names.includes(cmd) ? `/usr/bin/${cmd}` : undefined;

describe('seletor de pastas nativo', () => {
  it('KDE usa o kdialog', () => {
    const c = dialogCommand('/home/x', { platform: 'linux', desktop: 'KDE', which: has('kdialog', 'zenity') });
    expect(c).toEqual({ file: '/usr/bin/kdialog', args: ['--getexistingdirectory', '/home/x', '--title', 'Escolha a pasta do projeto'] });
  });

  it('GNOME e outros usam o zenity', () => {
    const c = dialogCommand('/home/x', { platform: 'linux', desktop: 'GNOME', which: has('kdialog', 'zenity') });
    expect(c.file).toBe('/usr/bin/zenity');
    expect(c.args).toContain('--directory');
  });

  it('sem zenity, cai no kdialog mesmo fora do KDE', () => {
    expect(dialogCommand('/h', { platform: 'linux', desktop: 'XFCE', which: has('kdialog') }).file).toBe('/usr/bin/kdialog');
  });

  it('sem nenhum seletor, erro explicando o que instalar', () => {
    expect(() => dialogCommand('/h', { platform: 'linux', which: has() })).toThrow(/zenity ou o kdialog/);
  });

  it('Windows usa o FolderBrowserDialog do PowerShell em modo STA, com a pasta por variável de ambiente', () => {
    const c = dialogCommand('C:\\Users\\x', { platform: 'win32', which: has() });
    expect(c.file).toBe('powershell.exe');
    expect(c.args).toContain('-STA');
    expect(c.args.at(-1)).toContain('FolderBrowserDialog');
    expect(c.args.at(-1)).toContain('$env:AI_OFFICE_START');
  });

  it('macOS usa o osascript', () => {
    const c = dialogCommand('/Users/x', { platform: 'darwin', which: has() });
    expect(c.file).toBe('osascript');
    expect(c.args[1]).toContain('choose folder');
  });
});

describe('navegador para a janela própria (--app)', () => {
  const env = (patch: Partial<BrowserEnv>): BrowserEnv => ({
    platform: 'linux',
    env: {},
    exists: () => false,
    which: has(),
    ...patch,
  });

  it('AI_OFFICE_BROWSER tem prioridade', () => {
    expect(findBrowser(env({ env: { AI_OFFICE_BROWSER: '/opt/x' }, which: has('opera') }))).toEqual(['/opt/x']);
  });

  it('Linux: Opera antes do Chrome', () => {
    expect(findBrowser(env({ which: has('google-chrome-stable', 'opera') }))).toEqual(['/usr/bin/opera']);
  });

  it('Linux: cai no Chrome sem Opera', () => {
    expect(findBrowser(env({ which: has('google-chrome-stable') }))).toEqual(['/usr/bin/google-chrome-stable']);
  });

  it('Windows: acha o Edge que vem instalado', () => {
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const b = env({ platform: 'win32', env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, exists: (p) => p === edge });
    expect(findBrowser(b)).toEqual([edge]);
  });

  it('Windows: Opera instalado no perfil do usuário vem primeiro', () => {
    const opera = 'C:\\Users\\x\\AppData\\Local\\Programs\\Opera\\opera.exe';
    const b = env({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      exists: () => true,
    });
    expect(findBrowser(b)).toEqual([opera]);
  });

  it('macOS: abre o app com open -na', () => {
    const b = env({ platform: 'darwin', exists: (p) => p === '/Applications/Opera.app' });
    expect(findBrowser(b)).toEqual(['open', '-na', 'Opera', '--args']);
  });

  it('nenhum navegador encontrado', () => {
    expect(findBrowser(env({}))).toBeUndefined();
  });
});
