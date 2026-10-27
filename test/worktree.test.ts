import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorktreeStatus } from '../shared/types.ts';
import { canDeleteBranch, prSuggestion } from '../shared/worktree.ts';
import { predictConflicts } from '../server/worktree.ts';
import { deleteBranchOption, worktreeActions } from '../web/logic.ts';
import { makeRepo } from './helpers.ts';

const base: WorktreeStatus = {
  branch: 'office/ana-1',
  target: 'main',
  ahead: 2,
  behind: 0,
  dirty: 0,
  conflicts: [],
  remote: true,
  pushed: false,
  suggestion: { title: 't', body: '' },
};
const st = (patch: Partial<WorktreeStatus>) => ({ ...base, ...patch });

describe('sugestão de PR a partir dos commits', () => {
  it('um commit: o assunto vira título e o corpo vira descrição', () => {
    expect(prSuggestion([{ subject: 'Tela de login', body: 'Com validação.\n' }], 'b')).toEqual({ title: 'Tela de login', body: 'Com validação.' });
  });

  it('vários: título do primeiro e a lista na descrição', () => {
    expect(prSuggestion([{ subject: 'A', body: '' }, { subject: 'B', body: 'x' }], 'b')).toEqual({ title: 'A', body: 'Commits:\n\n- A\n- B' });
  });

  it('sem commits: o nome da branch', () => {
    expect(prSuggestion([], 'office/ana-1').title).toBe('office/ana-1');
  });
});

describe('botões do worktree', () => {
  it('com commits novos e sem conflito, tudo liberado', () => {
    const ui = worktreeActions(base);
    expect(ui.pr).toEqual({ label: 'Abrir PR', disabled: undefined });
    expect(ui.merge).toEqual({ label: 'Trazer para main', disabled: undefined });
    expect(ui.remove.disabled).toBeUndefined();
    expect(ui.summary).toBe('2 commits a mais que main');
    expect(ui.warnings).toEqual([]);
  });

  it('conflito previsto desliga o merge e diz os arquivos', () => {
    const ui = worktreeActions(st({ conflicts: ['README.md'], behind: 1 }));
    expect(ui.merge.disabled).toBe('Daria conflito em README.md');
    expect(ui.summary).toBe('2 commits a mais que main, 1 commit atrás');
    expect(ui.warnings[0]).toMatch(/Conflito com main em: README\.md/);
  });

  it('nada novo: merge e PR desligados', () => {
    const ui = worktreeActions(st({ ahead: 0 }));
    expect(ui.merge.disabled).toBe('main já tem todos os commits');
    expect(ui.pr.disabled).toMatch(/Nenhum commit novo/);
    expect(ui.summary).toBe('Tudo já está em main');
  });

  it('sem origin, não dá para abrir PR', () => {
    expect(worktreeActions(st({ remote: false })).pr.disabled).toMatch(/origin/);
  });

  it('com PR aberto, o botão só envia commits novos', () => {
    expect(worktreeActions(st({ pr: 'u', pushed: true })).pr).toEqual({ label: 'Enviar para o PR', disabled: 'O PR já tem todos os commits' });
    expect(worktreeActions(st({ pr: 'u', pushed: false })).pr).toEqual({ label: 'Enviar para o PR', disabled: undefined });
  });

  it('arquivo não commitado: avisa e não deixa encerrar', () => {
    const ui = worktreeActions(st({ dirty: 3 }));
    expect(ui.remove.disabled).toMatch(/não commitado/);
    expect(ui.warnings[0]).toMatch(/3 arquivo\(s\) não commitado/);
  });

  it('sala sem branch (HEAD solto): não dá para trazer', () => {
    expect(worktreeActions(st({ target: undefined })).merge.disabled).toMatch(/não está numa branch/);
  });
});

describe('apagar a branch ao encerrar', () => {
  it('só quando o trabalho já está na sala ou no origin', () => {
    expect(canDeleteBranch(st({ ahead: 0 }))).toBe(true);
    expect(canDeleteBranch(st({ pushed: true }))).toBe(true);
    expect(canDeleteBranch(base)).toBe(false);
    expect(canDeleteBranch(st({ ahead: 0, target: undefined }))).toBe(false);
    expect(deleteBranchOption(base)).toEqual({ allowed: false, hint: 'Ela tem commits que não estão em main nem no origin.' });
    expect(deleteBranchOption(st({ ahead: 0 })).hint).toBe('O trabalho já está em main.');
  });
});

describe('previsão de conflito', () => {
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  it('lista só os arquivos que conflitam, sem tocar no repositório', async () => {
    const repo = makeRepo('prever');
    git(repo, 'checkout', '-q', '-b', 'outra');
    fs.writeFileSync(path.join(repo, 'README.md'), 'outra\n');
    fs.writeFileSync(path.join(repo, 'novo.txt'), 'sem conflito\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'outra');
    git(repo, 'checkout', '-q', 'main');
    expect(await predictConflicts(repo, 'main', 'outra')).toEqual([]);
    fs.writeFileSync(path.join(repo, 'README.md'), 'main\n');
    git(repo, 'commit', '-q', '-am', 'main');
    const head = git(repo, 'rev-parse', 'HEAD').toString();
    expect(await predictConflicts(repo, 'main', 'outra')).toEqual(['README.md']);
    expect(git(repo, 'rev-parse', 'HEAD').toString()).toBe(head);
    expect(git(repo, 'status', '--porcelain').toString()).toBe('');
  });
});
