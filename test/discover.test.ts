import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverProjects, findTranscript } from '../server/discover.ts';
import { tempDir } from './helpers.ts';

function transcript(root: string, folder: string, session: string, lines: object[], mtime?: number) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

describe('discoverProjects', () => {
  it('lista as pastas dos transcripts, mais recentes primeiro', () => {
    const root = tempDir('projects');
    const a = tempDir('proj-a');
    const b = tempDir('proj-b');
    transcript(root, 'x', 's1', [{ type: 'summary' }, { cwd: a }], Date.now() - 60_000);
    transcript(root, 'y', 's2', [{ cwd: b }], Date.now());
    expect(discoverProjects(root).map((p) => p.path)).toEqual([b, a]);
  });

  it('ignora pastas que não existem mais e transcripts sem cwd', () => {
    const root = tempDir('projects');
    transcript(root, 'x', 's1', [{ cwd: '/nao/existe/mais' }]);
    transcript(root, 'y', 's2', [{ type: 'summary' }]);
    expect(discoverProjects(root)).toEqual([]);
  });

  it('lida com caminhos com acento e barra invertida escapada', () => {
    const root = tempDir('projects');
    const dir = tempDir('área de trabalho');
    transcript(root, 'z', 's', [{ cwd: dir }]);
    expect(discoverProjects(root)[0].path).toBe(dir);
  });

  it('sem pasta de projetos devolve lista vazia', () => {
    expect(discoverProjects('/nao/existe')).toEqual([]);
  });
});

describe('findTranscript', () => {
  it('acha o transcript de uma sessão em qualquer pasta de projeto', () => {
    const root = tempDir('projects');
    const file = transcript(root, '-home-x', 'sessao-1', [{ cwd: '/x' }]);
    expect(findTranscript('sessao-1', root)).toBe(file);
  });

  it('regressão: sessão aberta e fechada sem mensagem não tem transcript', () => {
    const root = tempDir('projects');
    transcript(root, '-home-x', 'outra', [{ cwd: '/x' }]);
    expect(findTranscript('nunca-salva', root)).toBeUndefined();
    expect(findTranscript('', root)).toBeUndefined();
  });
});
