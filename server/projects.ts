// Salas com vários projetos: a sala é a pasta raiz de um sistema (ex.: ~/ampm/saff) e cada
// projeto é um repositório dentro dela. Aqui ficam a descoberta dos projetos, o rascunho da ficha
// de cada um, o nome dele no ai-memory e o contexto compartilhado que cada agente recebe: o
// fluxo, as fichas dos vizinhos, os documentos da raiz e quem está fazendo o quê.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Project, Room } from '../shared/types.ts';

/** Tamanho máximo do rascunho automático da ficha. */
const SUMMARY_MAX = 400;
/** Documentos da raiz listados no contexto (só o caminho: o agente lê quando precisar). */
const DOC_EXTS = new Set(['.md', '.markdown', '.txt', '.pdf', '.docx', '.doc', '.xlsx', '.csv', '.odt', '.rst', '.adoc']);
const MAX_DOCS = 30;

const isRepo = (dir: string) => fs.existsSync(path.join(dir, '.git'));

/**
 * Pastas de projeto dentro da raiz: a própria raiz, se ela é um repositório; senão, as pastas
 * logo abaixo que são repositórios. Uma raiz sem nenhum repositório vira um projeto só.
 */
export function detectProjects(root: string): string[] {
  if (isRepo(root)) return [root];
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && isRepo(path.join(root, d.name)))
      .map((d) => path.join(root, d.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {}
  return dirs.length ? dirs : [root];
}

export function newProject(dir: string): Project {
  return { id: randomUUID().slice(0, 8), name: path.basename(dir), path: dir, summary: draftSummary(dir) };
}

/** Uma pasta pode entrar como projeto da sala: existe e fica na raiz ou dentro dela. */
export function insideRoot(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Projetos da sala, com o da própria pasta para as salas de antes dos projetos. */
export function projectsOf(room: Room): Project[] {
  return room.projects?.length ? room.projects : [{ id: 'raiz', name: room.name, path: room.path, summary: '' }];
}

/** Projeto em que o agente trabalha (o primeiro da sala, para os registros antigos). */
export function projectOf(room: Room, projectId?: string): Project {
  const all = projectsOf(room);
  return all.find((p) => p.id === projectId) ?? all[0];
}

const read = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Rascunho da ficha de um projeto, para você editar: a descrição do package.json (ou similar)
 * e o primeiro parágrafo de texto do README ou do CLAUDE.md, cortado num tamanho curto.
 */
export function draftSummary(dir: string): string {
  const parts: string[] = [];
  const pkg = read(path.join(dir, 'package.json'));
  if (pkg) {
    try {
      const d = JSON.parse(pkg).description;
      if (typeof d === 'string' && d.trim()) parts.push(d.trim());
    } catch {}
  }
  for (const name of ['README.md', 'readme.md', 'README', 'CLAUDE.md', 'AGENTS.md']) {
    const text = read(path.join(dir, name));
    const para = text && firstParagraph(text);
    if (para && !parts.some((p) => p.includes(para) || para.includes(p))) {
      parts.push(para);
      break;
    }
  }
  const out = parts.join(' ').replace(/\s+/g, ' ').trim();
  return out.length > SUMMARY_MAX ? `${out.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : out;
}

/** Primeiro parágrafo de prosa de um markdown: pula títulos, selos, imagens, listas e código. */
export function firstParagraph(md: string): string {
  const blocks = md.replace(/\r\n/g, '\n').replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^(#|!\[|\[!\[|<|>|\||[-*+] |\d+\. |---|===)/.test(l));
    const text = lines.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim();
    if (text.length >= 20) return text;
  }
  return '';
}

/** Documentos soltos na raiz da sala (fora das pastas dos projetos), relativos à raiz. */
export function rootDocs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile() && DOC_EXTS.has(path.extname(d.name).toLowerCase()))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_DOCS);
  } catch {
    return [];
  }
}

// ---------- ai-memory ----------

export interface MemoryScope {
  workspace: string;
  project: string;
}

/**
 * Nome do projeto no ai-memory, pela mesma regra dele: o `.ai-memory.toml` mais próximo; senão o
 * remoto (upstream, depois origin) sem o host; senão o nome da pasta.
 */
export function memoryScope(dir: string): MemoryScope {
  const marker = findMarker(dir);
  if (marker?.project) return { workspace: marker.workspace ?? 'default', project: marker.project };
  for (const remote of ['upstream', 'origin']) {
    const url = gitRemote(dir, remote);
    const name = url && remoteProjectName(url);
    if (name) return { workspace: marker?.workspace ?? 'default', project: name };
  }
  return { workspace: marker?.workspace ?? 'default', project: path.basename(dir) };
}

/** "git@ssh.dev.azure.com:v3/org/Plataformas%20Digitais/repo" → "v3-org-plataformas-20digitais-repo". */
export function remoteProjectName(url: string): string | undefined {
  let p = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/]+\/(.*)$/i.exec(p);
  const scp = /^(?:[^@/]+@)?[^:/]+:(.*)$/.exec(p);
  if (scheme) p = scheme[1];
  else if (scp) p = scp[1];
  else return undefined;
  p = p.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!p) return undefined;
  return p.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function gitRemote(dir: string, name: string): string | undefined {
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function findMarker(dir: string): { workspace?: string; project?: string } | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const text = read(path.join(d, '.ai-memory.toml'));
    if (text !== undefined) {
      const get = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text)?.[1];
      return { workspace: get('workspace'), project: get('project') };
    }
    if (path.dirname(d) === d) return undefined;
  }
}

// ---------- contexto compartilhado ----------

export interface ContextOpts {
  /** O ai-memory está ligado ao Claude Code (MCP): entram as instruções de memória da sala. */
  memory: boolean;
  /** Arquivo vivo com o que cada agente da sala está fazendo agora. */
  nowFile: string;
  /** Nome do projeto de cada pasta no ai-memory (configurável nos testes). */
  scopeOf?: (dir: string) => MemoryScope;
}

/** Contexto que o agente recebe no prompt de sistema: a sala, os vizinhos e como falar com eles. */
export function roomContext(room: Room, agent: Pick<Agent, 'projectId'>, opts: ContextOpts): string {
  const all = projectsOf(room);
  const mine = projectOf(room, agent.projectId);
  const others = all.filter((p) => p.id !== mine.id);
  const scopeOf = opts.scopeOf ?? memoryScope;
  const out: string[] = [];
  out.push(`# Sala ${room.name}`);
  if (others.length) {
    out.push(
      `Você trabalha no projeto **${mine.name}** (\`${mine.path}\`). Ele faz parte de um sistema maior, com a raiz em \`${room.path}\`, junto com os projetos listados abaixo. Seu trabalho é no seu projeto; os outros você pode ler para entender contratos e integrações, mas não os altere sem o pedido explícito de quem está falando com você.`,
    );
  } else {
    out.push(`Você trabalha no projeto **${mine.name}** (\`${mine.path}\`), na sala com raiz em \`${room.path}\`.`);
  }
  if (room.brief?.trim()) out.push(`## O sistema\n${room.brief.trim()}`);
  out.push(
    `## Projetos da sala\n${all
      .map((p) => {
        const me = p.id === mine.id ? ' (o seu)' : '';
        const summary = p.summary.trim() ? `: ${p.summary.trim()}` : '';
        return `- **${p.name}**${me}, em \`${p.path}\`${summary}`;
      })
      .join('\n')}`,
  );
  const docs = rootDocs(room.path);
  if (docs.length) {
    out.push(`## Documentos na raiz da sala\nLeia quando o assunto pedir (estão em \`${room.path}\`):\n${docs.map((d) => `- ${d}`).join('\n')}`);
  }
  out.push(
    `## Quem está trabalhando agora\nO escritório mantém \`${opts.nowFile}\` atualizado com o que cada agente da sala está fazendo. Leia antes de mexer num contrato ou numa integração que outro projeto usa.`,
  );
  if (opts.memory) {
    const scope = (p: Project) => scopeOf(p.path);
    const me = scope(mine);
    const lines = [
      `## Memória compartilhada (ai-memory)`,
      `Seu projeto no ai-memory é workspace \`${me.workspace}\`, project \`${me.project}\`.`,
    ];
    if (others.length) {
      lines.push(
        `Os vizinhos da sala:\n${others.map((p) => `- ${p.name}: workspace \`${scope(p).workspace}\`, project \`${scope(p).project}\``).join('\n')}`,
        `- Antes de mudar ou depender de algo que atravessa projetos (contratos, filas, formatos de arquivo, campos), busque nos vizinhos com \`memory_query\` passando \`scopes\` com esses projetos.`,
        `- Ao mudar algo que um vizinho consome, avise o projeto dele com \`memory_message_send\`; no começo de cada tarefa, veja com \`memory_message_list\` se chegou recado para o seu projeto.`,
        `- Decisões que valem para o sistema todo só viram página do ai-memory quando o usuário pedir.`,
      );
    }
    out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

/** Quadro "quem está fazendo o quê" da sala, regravado a cada mudança de um agente. */
export function nowText(room: Room, agents: Agent[], now = Date.now()): string {
  const people = agents.filter((a) => a.roomId === room.id && a.kind !== 'shell');
  const lines = people.map((a) => {
    const p = projectOf(room, a.projectId);
    const where = a.worktreeBranch ? `${p.name}, branch ${a.worktreeBranch}` : p.name;
    const state = a.status === 'exited' ? 'fora do escritório' : a.activity || a.status;
    return `- **${a.name}** (${where}): ${state}`;
  });
  return `# Sala ${room.name}: quem está fazendo o quê\n\nAtualizado em ${new Date(now).toISOString()}.\n\n${lines.join('\n') || 'Ninguém na sala.'}\n`;
}
