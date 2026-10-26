import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeBin, defaultShell, ptyCommand, which } from '../server/platform.ts';
import { tempDir } from './helpers.ts';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('which', () => {
  it('acha um executável no PATH', () => {
    const dir = tempDir('bin');
    const name = process.platform === 'win32' ? 'ferramenta.cmd' : 'ferramenta';
    fs.writeFileSync(path.join(dir, name), '');
    process.env.PATH = dir;
    expect(which('ferramenta')).toBe(path.join(dir, name));
  });

  it('devolve undefined quando não existe', () => {
    process.env.PATH = tempDir('vazio');
    expect(which('nao-existe-xyz')).toBeUndefined();
  });
});

describe('ptyCommand', () => {
  it('roda .cmd/.bat pelo cmd.exe no Windows', () => {
    const cmd = ptyCommand('C:\\npm\\claude.cmd', ['--x'], true);
    expect(cmd.args).toEqual(['/d', '/s', '/c', 'C:\\npm\\claude.cmd', '--x']);
  });

  it('roda scripts .mjs com o Node', () => {
    expect(ptyCommand('/a/fake.mjs', ['--y'], false)).toEqual({ file: process.execPath, args: ['/a/fake.mjs', '--y'] });
  });

  it('roda binários direto', () => {
    expect(ptyCommand('/usr/bin/claude', ['--z'], false)).toEqual({ file: '/usr/bin/claude', args: ['--z'] });
  });
});

describe('claudeBin', () => {
  it('respeita AI_OFFICE_CLAUDE_BIN', () => {
    process.env.AI_OFFICE_CLAUDE_BIN = '/caminho/claude-falso';
    expect(claudeBin()).toBe('/caminho/claude-falso');
  });
});

describe('defaultShell', () => {
  it('respeita AI_OFFICE_SHELL', () => {
    process.env.AI_OFFICE_SHELL = '/bin/meu-shell';
    expect(defaultShell()).toBe('/bin/meu-shell');
  });

  it.skipIf(process.platform === 'win32')(
    'regressão: usa o shell de login, não o $SHELL herdado de quem iniciou o servidor',
    () => {
      delete process.env.AI_OFFICE_SHELL;
      process.env.SHELL = '/bin/zsh-herdado-de-outra-sessao';
      const login = os.userInfo().shell;
      expect(defaultShell()).toBe(login || '/bin/zsh-herdado-de-outra-sessao');
      if (login) expect(defaultShell()).not.toBe('/bin/zsh-herdado-de-outra-sessao');
    },
  );
});
