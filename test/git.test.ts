import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addWorktree, fileDiff, gitInfo, unquote } from '../server/git.ts';
import { makeRepo, tempDir } from './helpers.ts';

describe('gitInfo', () => {
  it('pasta sem git', async () => {
    expect(await gitInfo(tempDir('sem-git'))).toEqual({ isRepo: false });
  });

  it('branch, arquivos modificados e novos, commits', async () => {
    const repo = makeRepo('repo');
    fs.writeFileSync(path.join(repo, 'README.md'), 'mudou\n');
    fs.writeFileSync(path.join(repo, 'novo.txt'), 'oi\n');
    const info = await gitInfo(repo);
    expect(info.isRepo).toBe(true);
    expect(info.branch).toBe('main');
    expect(info.files).toEqual(
      expect.arrayContaining([
        { status: 'M', path: 'README.md', additions: 1, deletions: 1 },
        { status: '??', path: 'novo.txt', additions: 1, deletions: 0 },
      ]),
    );
    // Na branch padrão não há seção "na branch".
    expect(info.base).toBeUndefined();
    expect(info.commits?.[0].subject).toBe('primeiro commit');
    expect(info.ahead).toBe(0);
  });

  it('repositório sem nenhum commit ainda', async () => {
    const dir = tempDir('vazio');
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    const info = await gitInfo(dir);
    expect(info.isRepo).toBe(true);
    expect(info.branch).toBe('main');
    expect(info.commits).toEqual([]);
  });
});

describe('addWorktree', () => {
  it('cria o worktree numa branch nova e ele aparece na lista', async () => {
    const repo = makeRepo('repo-wt');
    const dir = path.join(tempDir('wts'), 'ana');
    await addWorktree(repo, dir, 'office/ana-1');
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
    const info = await gitInfo(dir);
    expect(info.branch).toBe('office/ana-1');
    expect(info.worktrees?.map((w) => w.branch)).toEqual(expect.arrayContaining(['main', 'office/ana-1']));
  });

  it('erro claro quando a pasta não é um repositório', async () => {
    await expect(addWorktree(tempDir('nao-repo'), path.join(tempDir('x'), 'y'), 'b')).rejects.toThrow(/Não foi possível criar o worktree/);
  });
});

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { stdio: 'pipe' }).toString();
}

describe('o que mudou na branch', () => {
  it('lista os arquivos que a branch mudou desde que saiu da main, com os commits', async () => {
    const repo = makeRepo('branch');
    git(repo, 'checkout', '-q', '-b', 'feature/login');
    fs.writeFileSync(path.join(repo, 'login.ts'), 'export const a = 1;\nexport const b = 2;\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# teste\nmais uma linha\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'login');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'vazio');
    // Commit novo na main depois que a branch saiu não aparece como mudança da branch.
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'outro.ts'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main andou');
    git(repo, 'checkout', '-q', 'feature/login');

    const info = await gitInfo(repo);
    expect(info.branch).toBe('feature/login');
    expect(info.base).toBe('main');
    expect(info.branchCommits).toBe(2);
    expect(info.branchFiles).toEqual([
      { path: 'README.md', status: 'M', additions: 1, deletions: 0 },
      { path: 'login.ts', status: 'A', additions: 2, deletions: 0 },
    ]);
    expect(info.files).toEqual([]);
  });

  it('worktree de agente: a base é a branch de onde ele saiu', async () => {
    const repo = makeRepo('wt-branch');
    const dir = path.join(tempDir('wts'), 'bia');
    await addWorktree(repo, dir, 'office/bia-1');
    fs.writeFileSync(path.join(dir, 'novo.ts'), 'oi\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'agente trabalhou');
    const info = await gitInfo(dir);
    expect(info.base).toBe('main');
    expect(info.branchFiles?.map((f) => f.path)).toEqual(['novo.ts']);
  });

  it('caminhos com espaço e acento', async () => {
    const repo = makeRepo('nomes');
    fs.mkdirSync(path.join(repo, 'minha pasta'));
    fs.writeFileSync(path.join(repo, 'minha pasta', 'ação.txt'), 'a\n');
    const info = await gitInfo(repo);
    expect(info.files?.[0].path).toBe('minha pasta/ação.txt');
    const d = await fileDiff(repo, 'minha pasta/ação.txt', 'working');
    expect(d.diff).toContain('+a');
  });

  it('unquote desfaz as aspas do git', () => {
    expect(unquote('"a b.txt"')).toBe('a b.txt');
    expect(unquote('"\\303\\241.txt"')).toBe('á.txt');
    expect(unquote('normal.ts')).toBe('normal.ts');
  });
});

describe('fileDiff', () => {
  it('arquivo modificado: diff com as linhas antes e depois', async () => {
    const repo = makeRepo('diff');
    fs.writeFileSync(path.join(repo, 'README.md'), '# teste novo\n');
    const d = await fileDiff(repo, 'README.md', 'working');
    expect(d).toMatchObject({ path: 'README.md', scope: 'working', binary: false, truncated: false });
    expect(d.diff).toContain('-# teste');
    expect(d.diff).toContain('+# teste novo');
  });

  it('inclui o que já foi para o stage', async () => {
    const repo = makeRepo('stage');
    fs.writeFileSync(path.join(repo, 'README.md'), 'staged\n');
    git(repo, 'add', 'README.md');
    expect((await fileDiff(repo, 'README.md', 'working')).diff).toContain('+staged');
  });

  it('arquivo novo fora do git: todas as linhas como adicionadas', async () => {
    const repo = makeRepo('novo');
    fs.writeFileSync(path.join(repo, 'n.txt'), 'um\ndois');
    const d = await fileDiff(repo, 'n.txt', 'working');
    expect(d.diff).toBe('@@ -0,0 +1,2 @@\n+um\n+dois\n\\ No newline at end of file\n');
  });

  it('arquivo binário', async () => {
    const repo = makeRepo('bin');
    fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]));
    expect((await fileDiff(repo, 'img.bin', 'working')).binary).toBe(true);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'bin');
    fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.from([0, 9, 9, 0]));
    expect((await fileDiff(repo, 'img.bin', 'working')).binary).toBe(true);
  });

  it('arquivo apagado', async () => {
    const repo = makeRepo('apagado');
    fs.rmSync(path.join(repo, 'README.md'));
    const d = await fileDiff(repo, 'README.md', 'working');
    expect(d.diff).toContain('-# teste');
  });

  it('escopo da branch compara com o ponto em que ela saiu da main', async () => {
    const repo = makeRepo('diff-branch');
    git(repo, 'checkout', '-q', '-b', 'feat');
    fs.writeFileSync(path.join(repo, 'README.md'), '# teste\nfeat\n');
    git(repo, 'commit', '-qam', 'feat');
    const d = await fileDiff(repo, 'README.md', 'branch');
    expect(d.diff).toContain('+feat');
  });

  it('segurança: só mostra arquivos que estão na lista de alterados', async () => {
    const repo = makeRepo('seguro');
    fs.writeFileSync(path.join(repo, 'segredo.txt'), 'senha\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'segredo');
    await expect(fileDiff(repo, 'segredo.txt', 'working')).rejects.toThrow(/não está entre os alterados/);
    await expect(fileDiff(repo, '../../etc/passwd', 'working')).rejects.toThrow();
    await expect(fileDiff(repo, '--output=/tmp/x', 'working')).rejects.toThrow();
  });
});
