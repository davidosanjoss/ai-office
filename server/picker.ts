import { execFile } from 'node:child_process';
import os from 'node:os';
import { which } from './platform.ts';

/**
 * Abre a janela nativa de escolher pasta do sistema. O navegador não revela caminhos
 * reais, mas o servidor roda na mesma máquina e pode mostrar o diálogo ele mesmo.
 * Retorna undefined se você cancelar.
 */
export async function pickFolder(start = os.homedir()): Promise<string | undefined> {
  const { file, args } = dialogCommand(start);
  // No Windows o caminho vai por variável de ambiente para não precisar escapar no script.
  const env = { ...process.env, AI_OFFICE_START: start };
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, windowsHide: false, encoding: 'utf8' }, (err, stdout) => {
      const picked = stdout.trim();
      // Todos os diálogos saem com código 1 ao cancelar.
      if (err && !picked) return (err as { code?: unknown }).code === 1 ? resolve(undefined) : reject(err);
      resolve(picked || undefined);
    });
  });
}

export interface PickerEnv {
  platform: NodeJS.Platform;
  desktop?: string;
  which: (cmd: string) => string | undefined;
}

const realEnv = (): PickerEnv => ({ platform: process.platform, desktop: process.env.XDG_CURRENT_DESKTOP, which });

export function dialogCommand(start: string, env: PickerEnv = realEnv()): { file: string; args: string[] } {
  const title = 'Escolha a pasta do projeto';

  if (env.platform === 'win32') {
    // Um formulário invisível "sempre no topo" como dono faz o diálogo aparecer na frente do navegador.
    const script = `
      [Console]::OutputEncoding = [Text.Encoding]::UTF8
      Add-Type -AssemblyName System.Windows.Forms
      $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
      $d = New-Object System.Windows.Forms.FolderBrowserDialog
      $d.Description = '${title}'
      $d.ShowNewFolderButton = $true
      $d.SelectedPath = $env:AI_OFFICE_START
      if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath } else { exit 1 }`;
    return { file: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', script] };
  }

  if (env.platform === 'darwin') {
    return {
      file: 'osascript',
      args: ['-e', `POSIX path of (choose folder with prompt "${title}" default location POSIX file "${start}")`],
    };
  }

  // Linux: o diálogo do próprio desktop quando possível.
  const kde = /kde/i.test(env.desktop ?? '');
  const kdialog = env.which('kdialog');
  const zenity = env.which('zenity');
  if (kdialog && (kde || !zenity)) return { file: kdialog, args: ['--getexistingdirectory', start, '--title', title] };
  if (zenity) return { file: zenity, args: ['--file-selection', '--directory', `--filename=${start}/`, `--title=${title}`] };
  throw new Error('Nenhum seletor de pastas encontrado. Instale o zenity ou o kdialog, ou digite o caminho.');
}
