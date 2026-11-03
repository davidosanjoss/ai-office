import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Agent, Room } from '../shared/types.ts';
import { detectProjects, draftSummary, firstParagraph, insideRoot, memoryScope, nowText, remoteProjectName, roomContext, rootDocs } from '../server/projects.ts';
import { makeRepo, tempDir } from './helpers.ts';

/** Uma sala como a do SAFF: dois repositórios e documentos soltos na raiz. */
function saff() {
  const root = tempDir('saff');
  for (const name of ['ms-arquivos', 'ms-sales']) {
    const repo = makeRepo(name);
    fs.renameSync(repo, path.join(root, name));
  }
  fs.mkdirSync(path.join(root, 'rascunhos'));
  fs.writeFileSync(path.join(root, 'plano.md'), '# plano\n');
  fs.writeFileSync(path.join(root, 'Wiki - Overview.pdf'), '%PDF');
  fs.writeFileSync(path.join(root, 'foto.png'), '');
  return root;
}

const room = (root: string, patch: Partial<Room> = {}): Room => ({
  id: 'r1',
  name: 'SAFF',
  path: root,
  createdAt: 1,
  projects: [
    { id: 'p1', name: 'ms-arquivos', path: path.join(root, 'ms-arquivos'), summary: 'Recebe e valida os arquivos de venda.' },
    { id: 'p2', name: 'ms-sales', path: path.join(root, 'ms-sales'), summary: 'Monta as vendas a partir dos arquivos.' },
  ],
  ...patch,
});

describe('detectProjects', () => {
  it('cada repositório logo abaixo da raiz vira um projeto, na ordem do nome', () => {
    const root = saff();
    expect(detectProjects(root)).toEqual([path.join(root, 'ms-arquivos'), path.join(root, 'ms-sales')]);
  });

  it('raiz que já é um repositório é um projeto só', () => {
    const repo = makeRepo('app');
    expect(detectProjects(repo)).toEqual([repo]);
  });

  it('pasta sem repositórios vira um projeto com a própria pasta', () => {
    const dir = tempDir('solta');
    expect(detectProjects(dir)).toEqual([dir]);
  });
});

describe('insideRoot', () => {
  it('aceita a raiz e o que está dentro, recusa o que está fora', () => {
    expect(insideRoot('/a/saff', '/a/saff')).toBe(true);
    expect(insideRoot('/a/saff', '/a/saff/ms')).toBe(true);
    expect(insideRoot('/a/saff', '/a/saff-outro')).toBe(false);
    expect(insideRoot('/a/saff', '/a')).toBe(false);
  });
});

describe('rascunho da ficha', () => {
  it('pula título, selos e listas e pega o primeiro parágrafo de texto', () => {
    const md = '# Título\n\n[![ci](x)](y)\n\n- item\n\nServiço que recebe os arquivos de venda das lojas e valida o layout.\nSegunda linha.\n\n## Outro\n\nNão este.';
    expect(firstParagraph(md)).toBe('Serviço que recebe os arquivos de venda das lojas e valida o layout. Segunda linha.');
  });

  it('junta a descrição do package.json com o README e corta o texto longo', () => {
    const dir = tempDir('pkg');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ description: 'API de vendas' }));
    fs.writeFileSync(path.join(dir, 'README.md'), `# x\n\n${'Texto do readme bem comprido. '.repeat(30)}`);
    const s = draftSummary(dir);
    expect(s.startsWith('API de vendas Texto do readme')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(400);
    expect(s.endsWith('…')).toBe(true);
  });

  it('pasta sem README fica com a ficha vazia', () => {
    expect(draftSummary(tempDir('vazia'))).toBe('');
  });
});

describe('rootDocs', () => {
  it('lista só os documentos soltos na raiz, sem as pastas', () => {
    expect(rootDocs(saff())).toEqual(['plano.md', 'Wiki - Overview.pdf']);
  });
});

describe('nome do projeto no ai-memory', () => {
  it('segue a regra do ai-memory para os remotos (nomes reais do Azure e do GitHub)', () => {
    expect(remoteProjectName('git@ssh.dev.azure.com:v3/ampmdevops/Plataformas%20Digitais/ampm-saff-ms-faturamento-arquivos')).toBe(
      'v3-ampmdevops-plataformas-20digitais-ampm-saff-ms-faturamento-arquivos',
    );
    expect(remoteProjectName('https://github.com/davidosanjoss/ai-office.git')).toBe('davidosanjoss-ai-office');
    expect(remoteProjectName('git@github.com:davidosanjoss/ai-office.git')).toBe('davidosanjoss-ai-office');
    expect(remoteProjectName('/caminho/local')).toBeUndefined();
  });

  it('usa o origin do repositório; sem remoto, o nome da pasta', () => {
    const repo = makeRepo('Servico');
    expect(memoryScope(repo)).toEqual({ workspace: 'default', project: path.basename(repo) });
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:org/servico.git']);
    expect(memoryScope(repo)).toEqual({ workspace: 'default', project: 'org-servico' });
  });

  it('o .ai-memory.toml mais próximo vence o remoto', () => {
    const repo = makeRepo('marcado');
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:org/servico.git']);
    fs.writeFileSync(path.join(repo, '.ai-memory.toml'), 'workspace = "ampm"\nproject = "saff-arquivos"\n');
    expect(memoryScope(path.join(repo))).toEqual({ workspace: 'ampm', project: 'saff-arquivos' });
  });
});

describe('roomContext', () => {
  const opts = { memory: false, nowFile: '/dados/agora.md', scopeOf: (d: string) => ({ workspace: 'default', project: path.basename(d) }) };

  it('diz em qual projeto o agente está e mostra a ficha dos vizinhos, o sistema e os documentos', () => {
    const root = saff();
    const text = roomContext(room(root, { brief: 'arquivos → motor → sales' }), { projectId: 'p2' }, opts);
    expect(text).toContain(`Você trabalha no projeto **ms-sales** (\`${path.join(root, 'ms-sales')}\`)`);
    expect(text).toContain('## O sistema\narquivos → motor → sales');
    expect(text).toContain('- **ms-arquivos**, em');
    expect(text).toContain(': Recebe e valida os arquivos de venda.');
    expect(text).toContain('- **ms-sales** (o seu)');
    expect(text).toContain('- plano.md\n- Wiki - Overview.pdf');
    expect(text).toContain('/dados/agora.md');
    expect(text).not.toContain('ai-memory');
  });

  it('com o ai-memory ligado, dá o projeto de cada um e como consultar e avisar os vizinhos', () => {
    const text = roomContext(room(saff()), { projectId: 'p1' }, { ...opts, memory: true });
    expect(text).toContain('Seu projeto no ai-memory é workspace `default`, project `ms-arquivos`.');
    expect(text).toContain('- ms-sales: workspace `default`, project `ms-sales`');
    expect(text).toContain('memory_query');
    expect(text).toContain('memory_message_send');
  });

  it('sala de um projeto só não fala de vizinhos', () => {
    const repo = makeRepo('solo');
    const text = roomContext({ id: 'r', name: 'solo', path: repo, createdAt: 1, projects: [{ id: 'p', name: 'solo', path: repo, summary: '' }] }, {}, { ...opts, memory: true });
    expect(text).not.toContain('vizinhos');
    expect(text).toContain('Seu projeto no ai-memory');
  });
});

describe('nowText', () => {
  it('mostra cada agente com o projeto, o worktree e o que está fazendo, sem os terminais', () => {
    const r = room('/saff');
    const a = (patch: Partial<Agent>): Agent => ({ id: 'x', roomId: 'r1', name: 'Ana', cwd: '/', sessionId: '', status: 'working', activity: 'Editando x.ts', subagents: 0, createdAt: 1, ...patch });
    const text = nowText(r, [
      a({ projectId: 'p1' }),
      a({ id: 'y', name: 'Bruno', projectId: 'p2', worktreeBranch: 'office/bruno', status: 'exited' }),
      a({ id: 'z', name: 'Terminal 1', kind: 'shell' }),
      a({ id: 'w', name: 'Outra sala', roomId: 'r2' }),
    ], 0);
    expect(text).toContain('- **Ana** (ms-arquivos): Editando x.ts');
    expect(text).toContain('- **Bruno** (ms-sales, branch office/bruno): fora do escritório');
    expect(text).not.toContain('Terminal 1');
    expect(text).not.toContain('Outra sala');
  });
});
