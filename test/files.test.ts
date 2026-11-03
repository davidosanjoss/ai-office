import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanPath, listDir, makeDir, readFile, removePath, renamePath, resolveInside, writeFile } from '../server/files.ts';
import { commitDetail, commitLog, commitOf, compareRefs, fileAt, fileAtHead, listRefs, treeAt } from '../server/history.ts';
import { makeRepo, tempDir } from './helpers.ts';

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { stdio: 'pipe' }).toString();
}

/** O git do Windows (core.autocrlf) grava no disco com \r\n o que vem de um checkout. */
const lf = (t: string) => t.replace(/\r\n/g, '\n');

function commit(dir: string, msg: string) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

describe('caminhos do explorador', () => {
  it('normaliza e recusa o que sairia da pasta', () => {
    expect(cleanPath('')).toBe('');
    expect(cleanPath('./src//a.ts')).toBe('src/a.ts');
    expect(cleanPath('src\\b.ts')).toBe('src/b.ts');
    expect(() => cleanPath('../fora')).toThrow(/sair/);
    expect(() => cleanPath('src/../../fora')).toThrow(/sair/);
    expect(() => cleanPath('/etc/passwd')).toThrow(/relativo/);
    expect(() => cleanPath('C:\\Windows')).toThrow(/relativo/);
    expect(() => cleanPath('.git/config')).toThrow(/\.git/);
    expect(() => cleanPath('sub/.GIT/hooks')).toThrow(/\.git/);
    expect(() => cleanPath(42)).toThrow(/inválido/);
  });

  it.skipIf(process.platform === 'win32')('um link simbólico não leva para fora da pasta', () => {
    const root = tempDir('links');
    const outside = tempDir('fora');
    fs.writeFileSync(path.join(outside, 'segredo.txt'), 'x');
    fs.symlinkSync(outside, path.join(root, 'atalho'));
    expect(() => resolveInside(root, 'atalho/segredo.txt')).toThrow(/sai da pasta/);
    expect(() => writeFile(root, 'atalho/novo.txt', 'x')).toThrow(/sai da pasta/);
    expect(fs.existsSync(path.join(outside, 'novo.txt'))).toBe(false);
  });
});

describe('arquivos', () => {
  it('lista pastas antes dos arquivos e esconde o .git', () => {
    const repo = makeRepo('lista');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'b.txt'), '');
    fs.writeFileSync(path.join(repo, 'A.txt'), '');
    expect(listDir(repo, '').entries).toEqual([
      { name: 'src', kind: 'dir' },
      { name: 'A.txt', kind: 'file' },
      { name: 'b.txt', kind: 'file' },
      { name: 'README.md', kind: 'file' },
    ]);
    expect(() => listDir(repo, 'nada')).toThrow(/não encontrada/);
  });

  it('lê, salva e recusa salvar por cima do que mudou no disco', () => {
    const dir = tempDir('salvar');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'um\n');
    const read = readFile(dir, 'a.txt');
    expect(read).toMatchObject({ path: 'a.txt', content: 'um\n', binary: false, tooLarge: false });

    const saved = writeFile(dir, 'a.txt', 'dois\n', { version: read.version });
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('dois\n');
    expect(saved.version).not.toBe(read.version);

    // Um agente mudou o arquivo depois que você abriu: salvar com a versão antiga é recusado.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'do agente\n');
    expect(() => writeFile(dir, 'a.txt', 'meu\n', { version: saved.version })).toThrow(/mudou no disco/);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('do agente\n');
    // Sem versão, sobrescreve (o "Salvar mesmo assim").
    writeFile(dir, 'a.txt', 'meu\n');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('meu\n');
  });

  it('binário e arquivo grande demais abrem sem conteúdo', () => {
    const dir = tempDir('bin');
    fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(dir, 'grande.txt'), 'x'.repeat(3 * 1024 * 1024));
    expect(readFile(dir, 'img.bin')).toMatchObject({ binary: true, content: '' });
    expect(readFile(dir, 'grande.txt')).toMatchObject({ tooLarge: true, content: '' });
  });

  it('cria, renomeia e apaga arquivos e pastas', () => {
    const dir = tempDir('gerenciar');
    makeDir(dir, 'src/util');
    writeFile(dir, 'src/util/a.ts', 'x', { create: true });
    expect(() => writeFile(dir, 'src/util/a.ts', 'y', { create: true })).toThrow(/Já existe/);
    expect(() => writeFile(dir, 'sem/pasta.ts', 'y', { create: true })).toThrow(/pasta não existe/);

    renamePath(dir, 'src/util/a.ts', 'src/b.ts');
    expect(fs.existsSync(path.join(dir, 'src', 'b.ts'))).toBe(true);
    expect(() => renamePath(dir, 'src', 'src/util/dentro')).toThrow(/dentro dela mesma/);
    writeFile(dir, 'c.ts', '', { create: true });
    expect(() => renamePath(dir, 'c.ts', 'src/b.ts')).toThrow(/Já existe/);

    removePath(dir, 'src');
    expect(fs.existsSync(path.join(dir, 'src'))).toBe(false);
    expect(() => removePath(dir, '')).toThrow(/raiz/);
  });
});

describe('histórico', () => {
  function repoWithBranch() {
    const repo = makeRepo('hist');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'um\n');
    commit(repo, 'adiciona a');
    git(repo, 'checkout', '-q', '-b', 'feat/x');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'um\ndois\n');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export {};\n');
    commit(repo, 'muda a, cria b');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'tag', 'v1');
    return repo;
  }

  it('branches e tags, com a atual marcada', async () => {
    const refs = await listRefs(repoWithBranch());
    expect(refs.find((r) => r.name === 'main')).toMatchObject({ kind: 'branch', current: true });
    expect(refs.find((r) => r.name === 'feat/x')).toMatchObject({ kind: 'branch', subject: 'muda a, cria b' });
    expect(refs.find((r) => r.name === 'v1')).toMatchObject({ kind: 'tag' });
    await expect(listRefs(tempDir('sem-git'))).rejects.toThrow(/não é um repositório/);
  });

  it('commits de uma ref, do mais novo ao mais antigo, e filtrados por arquivo', async () => {
    const repo = repoWithBranch();
    const log = await commitLog(repo, 'feat/x');
    expect(log.commits.map((c) => c.subject)).toEqual(['muda a, cria b', 'adiciona a', 'primeiro commit']);
    expect(log.more).toBe(false);
    expect((await commitLog(repo, 'feat/x', { file: 'README.md' })).commits.map((c) => c.subject)).toEqual(['primeiro commit']);
    expect((await commitLog(repo, 'feat/x', { skip: 2 })).commits).toHaveLength(1);
  });

  it('o que um commit mudou, inclusive o primeiro', async () => {
    const repo = repoWithBranch();
    const d = await commitDetail(repo, 'feat/x');
    expect(d.message).toBe('muda a, cria b');
    expect(d.files).toEqual([
      { path: 'a.txt', status: 'M', additions: 1, deletions: 0 },
      { path: 'src/b.ts', status: 'A', additions: 1, deletions: 0 },
    ]);
    const first = (await commitLog(repo, 'main')).commits.at(-1)!;
    expect((await commitDetail(repo, first.hash)).files.map((f) => f.path)).toEqual(['README.md']);
  });

  it('compara duas branches', async () => {
    const c = await compareRefs(repoWithBranch(), 'main', 'feat/x');
    expect(c).toMatchObject({ ahead: 1, behind: 0 });
    expect(c.commits.map((x) => x.subject)).toEqual(['muda a, cria b']);
    expect(c.files.map((f) => f.path)).toEqual(['a.txt', 'src/b.ts']);
  });

  it('pastas e arquivos de outra branch, sem trocar de branch', async () => {
    const repo = repoWithBranch();
    expect((await treeAt(repo, 'feat/x', '')).entries).toEqual([
      { name: 'src', kind: 'dir' },
      { name: 'a.txt', kind: 'file' },
      { name: 'README.md', kind: 'file' },
    ]);
    expect((await treeAt(repo, 'feat/x', 'src')).entries).toEqual([{ name: 'b.ts', kind: 'file' }]);
    expect((await fileAt(repo, 'feat/x', 'a.txt')).content).toBe('um\ndois\n');
    expect((await fileAt(repo, 'main', 'src/b.ts')).missing).toBe(true);
    // A pasta continua na main.
    expect(lf(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'))).toBe('um\n');
  });

  it('arquivo no último commit, com caminho relativo à pasta (a sala pode ser uma subpasta do repositório)', async () => {
    const repo = repoWithBranch();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'mudou no disco\n');
    expect(lf((await fileAtHead(repo, 'a.txt')).content)).toBe('um\n');
    fs.writeFileSync(path.join(repo, 'novo.txt'), 'x');
    expect((await fileAtHead(repo, 'novo.txt')).missing).toBe(true);

    git(repo, 'checkout', '-q', '-f', 'feat/x');
    expect(lf((await fileAtHead(path.join(repo, 'src'), 'b.ts')).content)).toBe('export {};\n');

    const empty = tempDir('sem-commits');
    git(empty, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(empty, 'a.txt'), 'x');
    expect((await fileAtHead(empty, 'a.txt')).missing).toBe(true);
    await expect(fileAtHead(tempDir('sem-git-head'), 'a.txt')).rejects.toThrow(/não é um repositório/);
  });

  it('regressão: no último commit, o arquivo vem como o git o grava no disco (\\r\\n do Windows), senão "Ver alterações" acusava o arquivo inteiro', async () => {
    const repo = makeRepo('crlf');
    // O git do Windows vem com core.autocrlf=true: o checkout grava as linhas com \r\n.
    git(repo, 'config', 'core.autocrlf', 'true');
    fs.rmSync(path.join(repo, 'README.md'));
    git(repo, 'checkout', '--', 'README.md');
    const disk = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    expect(disk).toBe('# teste\r\n');
    expect((await fileAtHead(repo, 'README.md')).content).toBe(disk);
  });

  it('recusa refs que o git leria como opção, e avisa da que não existe', async () => {
    const repo = makeRepo('refs');
    await expect(commitOf(repo, '--output=/tmp/x')).rejects.toThrow(/inválida/);
    await expect(commitOf(repo, 'main; rm')).rejects.toThrow(/inválida/);
    await expect(commitOf(repo, 'nao-existe')).rejects.toThrow(/Não achei/);
    expect(await commitOf(repo, 'HEAD')).toMatch(/^[0-9a-f]{40}$/);
  });
});
