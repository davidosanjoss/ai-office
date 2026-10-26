import fs from 'node:fs';
import path from 'node:path';
import { which } from './platform.ts';

export interface BrowserEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  which: (cmd: string) => string | undefined;
}

const realEnv = (): BrowserEnv => ({ platform: process.platform, env: process.env, exists: fs.existsSync, which });

/**
 * Comando (executável + argumentos iniciais) de um navegador baseado em Chromium,
 * que aceita --app=URL para abrir numa janela própria. O Opera vem primeiro.
 */
export function findBrowser(b: BrowserEnv = realEnv()): string[] | undefined {
  const custom = b.env.AI_OFFICE_BROWSER;
  if (custom) return [custom];

  if (b.platform === 'darwin') {
    for (const app of ['Opera', 'Microsoft Edge', 'Google Chrome', 'Brave Browser', 'Vivaldi', 'Chromium']) {
      if (b.exists(`/Applications/${app}.app`)) return ['open', '-na', app, '--args'];
    }
    return undefined;
  }

  if (b.platform === 'win32') {
    const pf = b.env.ProgramFiles;
    const pf86 = b.env['ProgramFiles(x86)'];
    const local = b.env.LOCALAPPDATA;
    // Cada navegador nas pastas onde o instalador dele costuma colocar.
    const candidates: [string | undefined, string][] = [
      [local, 'Programs\\Opera\\opera.exe'],
      [pf, 'Opera\\opera.exe'],
      [pf86, 'Microsoft\\Edge\\Application\\msedge.exe'],
      [pf, 'Microsoft\\Edge\\Application\\msedge.exe'],
      [pf, 'Google\\Chrome\\Application\\chrome.exe'],
      [pf86, 'Google\\Chrome\\Application\\chrome.exe'],
      [local, 'Google\\Chrome\\Application\\chrome.exe'],
      [pf, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      [local, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      [local, 'Vivaldi\\Application\\vivaldi.exe'],
    ];
    for (const [base, rel] of candidates) {
      if (!base) continue;
      const full = path.win32.join(base, rel);
      if (b.exists(full)) return [full];
    }
    return undefined;
  }

  for (const name of ['opera', 'chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'brave', 'brave-browser', 'microsoft-edge-stable', 'vivaldi-stable']) {
    const bin = b.which(name);
    if (bin) return [bin];
  }
  return undefined;
}
