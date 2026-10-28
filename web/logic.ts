// Regras de decisão da interface, sem DOM, para poderem ser testadas.

import type { Agent, FileChange, Floor, Incident, IncidentMessage, MemoryStatus, Room, WorktreeStatus } from '../shared/types.ts';
import { canDeleteBranch } from '../shared/worktree.ts';

/** Depois da última tecla, quanto esperar antes de trocar de terminal sozinho. */
export const TYPING_GRACE_MS = 3500;
/** Um agente parado sem você digitar nele por esse tempo libera o foco automático. */
export const IDLE_RELEASE_MS = 20_000;

export function roomAgents(agents: Agent[], roomId?: string): Agent[] {
  return agents.filter((a) => a.roomId === roomId).sort((a, b) => a.createdAt - b.createdAt);
}

/** Funcionários do escritório: terminais comuns só aparecem como abas. */
export function officeAgents(agents: Agent[]): Agent[] {
  return agents.filter((a) => a.kind !== 'shell');
}

export function needsAttention(a: Agent): boolean {
  return (a.status === 'done' || a.status === 'waiting') && !!a.attentionAt;
}

/** Agentes que terminaram ou pediram aprovação, do mais antigo para o mais novo. */
export function attentionQueue(agents: Agent[]): Agent[] {
  return agents.filter(needsAttention).sort((a, b) => a.attentionAt! - b.attentionAt!);
}

export interface FocusInput {
  agents: Agent[];
  selectedId?: string;
  enabled: boolean;
  now: number;
  lastKeyAt: number;
  selectedAt: number;
  /** O explorador de arquivos está aberto: você está lendo ou editando código. */
  exploring?: boolean;
}

/**
 * Para quem o foco automático deve ir agora, ou undefined para ficar onde está.
 * Só troca quando o agente atual não precisa de você: está trabalhando, encerrado,
 * abrindo, ou parado há um tempo sem você digitar. Nunca troca enquanto você digita
 * nem enquanto você lê um agente que acabou de terminar, nem com o explorador aberto (trocar de
 * agente o esconderia no meio da edição).
 */
export function nextAutoFocus(f: FocusInput): string | undefined {
  if (!f.enabled || f.exploring || f.now - f.lastKeyAt < TYPING_GRACE_MS) return undefined;
  const current = f.agents.find((a) => a.id === f.selectedId);
  if (current) {
    const quietFor = f.now - Math.max(f.lastKeyAt, f.selectedAt);
    const free = current.status === 'working' || current.status === 'exited' || current.status === 'starting';
    if (!free && !(current.status === 'idle' && quietFor > IDLE_RELEASE_MS)) return undefined;
  }
  return attentionQueue(f.agents).find((a) => a.id !== f.selectedId)?.id;
}

/** Status entrou agora em "terminou" ou "pediu aprovação" (para avisar uma vez só). */
export function becameAttention(prev: Agent | undefined, next: Agent): boolean {
  const needs = next.status === 'done' || next.status === 'waiting';
  return needs && prev?.status !== next.status;
}

export function exitedMessage(a: Agent): string {
  if (a.kind === 'shell') return `${a.name} foi encerrado quando o servidor reiniciou.`;
  if (a.activity.startsWith('Não conseguiu abrir')) return `${a.name} ${a.activity.charAt(0).toLowerCase()}${a.activity.slice(1)}`;
  const code = a.exitCode !== undefined ? ` (código ${a.exitCode})` : '';
  return `${a.name} saiu do escritório${code}. A conversa continua salva.`;
}

export function resumeLabel(a: Agent): string {
  return a.kind === 'shell' ? 'Reabrir terminal' : 'Retomar conversa';
}

// ---------- andares ----------

/** Id do térreo na navegação: ele não é um Floor salvo, é a entrada do prédio. */
export const TERREO = 'terreo';

export function roomsOnFloor(rooms: Room[], floorId: string): Room[] {
  return floorId === TERREO ? [] : rooms.filter((r) => r.floorId === floorId);
}

export function agentsOnFloor(agents: Agent[], rooms: Room[], floorId: string): Agent[] {
  const ids = new Set(roomsOnFloor(rooms, floorId).map((r) => r.id));
  return agents.filter((a) => ids.has(a.roomId));
}

/** Andar de um agente (pela sala dele). */
export function floorOfAgent(agent: Agent | undefined, rooms: Room[]): string | undefined {
  return agent ? rooms.find((r) => r.id === agent.roomId)?.floorId : undefined;
}

/** Quantos agentes precisam de você em cada andar: a bolinha no botão do elevador. */
export function attentionByFloor(agents: Agent[], rooms: Room[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of attentionQueue(agents)) {
    const f = floorOfAgent(a, rooms);
    if (f) out.set(f, (out.get(f) ?? 0) + 1);
  }
  return out;
}

/** Ordem do elevador, de baixo para cima: térreo e depois os andares pela ordem. */
export function elevatorStops(floors: Floor[]): string[] {
  return [TERREO, ...[...floors].sort((a, b) => a.order - b.order).map((f) => f.id)];
}

/** Próxima parada subindo (+1) ou descendo (-1); fica onde está nas pontas. */
export function nextStop(floors: Floor[], current: string, dir: 1 | -1): string {
  const stops = elevatorStops(floors);
  const i = stops.indexOf(current);
  if (i < 0) return stops[Math.min(1, stops.length - 1)];
  return stops[Math.max(0, Math.min(stops.length - 1, i + dir))];
}

// ---------- barra lateral e contadores ----------

export interface Counters {
  salas: number;
  /** Agentes do Claude (terminais comuns não contam). */
  agentes: number;
  trabalhando: number;
  /** Ajudantes (subagentes) trabalhando agora. */
  ajudantes: number;
  /** Terminais comuns abertos. */
  terminais: number;
  precisam: number;
}

export function officeCounters(rooms: Room[], agents: Agent[]): Counters {
  const claude = agents.filter((a) => a.kind !== 'shell');
  return {
    salas: rooms.length,
    agentes: claude.length,
    trabalhando: claude.filter((a) => a.status === 'working').length,
    ajudantes: claude.reduce((n, a) => n + (a.subagents ?? 0), 0),
    terminais: agents.filter((a) => a.kind === 'shell' && a.status !== 'exited').length,
    precisam: attentionQueue(agents).length,
  };
}

export interface DirectoryFloor {
  floor: Floor;
  rooms: { room: Room; agents: Agent[] }[];
}

/** Sem acento e sem maiúsculas: "Vitória" acha "vitoria". */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Árvore da barra lateral: andares → salas → agentes (só os do Claude), filtrada pela busca.
 * A busca olha o nome do andar, da sala e do agente e o que o agente está fazendo; achar um andar
 * ou uma sala mostra tudo o que está dentro dele.
 */
export function directoryTree(floors: Floor[], rooms: Room[], agents: Agent[], query = ''): DirectoryFloor[] {
  const q = normalize(query.trim());
  const hit = (text: string) => !q || normalize(text).includes(q);
  const out: DirectoryFloor[] = [];
  for (const floor of [...floors].sort((a, b) => a.order - b.order)) {
    const floorHit = hit(floor.name);
    const list = [];
    for (const room of rooms.filter((r) => r.floorId === floor.id).sort((a, b) => a.name.localeCompare(b.name))) {
      const inRoom = roomAgents(agents, room.id).filter((a) => a.kind !== 'shell');
      const roomHit = floorHit || hit(room.name);
      const matching = roomHit ? inRoom : inRoom.filter((a) => hit(a.name) || hit(a.activity));
      if (roomHit || matching.length) list.push({ room, agents: matching });
    }
    if (floorHit || list.length) out.push({ floor, rooms: list });
  }
  return out;
}

// ---------- sala de guerra ----------

/** Quantas salas de guerra o andar tem (ausente = 1). */
export function warRoomsOf(floor: Floor | undefined): number {
  return floor?.warRooms ?? 1;
}

export function incidentAt(incidents: Incident[], floorId: string, slot: number): Incident | undefined {
  return incidents.find((i) => i.floorId === floorId && i.slot === slot);
}

/** Participantes que ainda existem, na ordem em que entraram: são as abas da sala de guerra. */
export function incidentAgents(incident: Incident | undefined, agents: Agent[]): Agent[] {
  if (!incident) return [];
  return incident.participants.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
}

/** Abas da sala de guerra: os participantes e, depois, os terminais comuns dela. */
export function warTabs(incident: Incident | undefined, agents: Agent[]): Agent[] {
  if (!incident) return [];
  const shells = agents.filter((a) => a.kind === 'shell' && a.incidentId === incident.id).sort((a, b) => a.createdAt - b.createdAt);
  return [...incidentAgents(incident, agents), ...shells];
}

/** Abas de uma sala de projeto: o terminal da sala de guerra que abriu nesta pasta fica só nas abas de lá. */
export function roomTabs(agents: Agent[], roomId?: string): Agent[] {
  return roomAgents(agents, roomId).filter((a) => !(a.kind === 'shell' && a.incidentId));
}

/** Quem pode ser chamado para a sala de guerra: agentes do Claude do andar que não estão em outra. */
export function incidentCandidates(agents: Agent[], rooms: Room[], floorId: string): Agent[] {
  return agentsOnFloor(agents, rooms, floorId)
    .filter((a) => a.kind !== 'shell' && !a.incidentId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Quem falou, como aparece no chat: "Você", "Ana · gateway", "Sala". */
export function chatAuthor(m: IncidentMessage, agents: Agent[], rooms: Room[]): string {
  if (m.kind === 'voce') return 'Você';
  if (m.kind === 'sistema') return 'Sala';
  const a = agents.find((x) => x.id === m.agentId);
  const who = a ? `${a.name} · ${rooms.find((r) => r.id === a.roomId)?.name ?? '?'}` : 'Agente que saiu';
  return m.kind === 'repasse' ? `Repasse de ${who}` : who;
}

/** O botão "compartilhar com a sala" só aparece na resposta de um agente, quando há mais alguém na sala. */
export function canShare(m: IncidentMessage, incident: Incident): boolean {
  return m.kind === 'agente' && !!m.agentId && incident.participants.some((id) => id !== m.agentId);
}

/** Só a sala de guerra de cima, vazia, pode ser tirada, e o andar fica sempre com pelo menos uma. */
export function canRemoveWarRoom(floor: Floor | undefined, slot: number, incidents: Incident[]): boolean {
  const n = warRoomsOf(floor);
  return !!floor && n > 1 && slot === n - 1 && !incidentAt(incidents, floor.id, slot);
}

/** Um botão do worktree: o texto e, quando não dá para usar, o motivo (vira a dica do botão). */
export interface WorktreeButton {
  label: string;
  disabled?: string;
}

/** O que os botões do worktree mostram, e por que cada um está desligado. */
export function worktreeActions(st: WorktreeStatus): {
  pr: WorktreeButton;
  merge: WorktreeButton;
  remove: WorktreeButton;
  summary: string;
  warnings: string[];
} {
  const target = st.target ?? 'a sala';
  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
  const pr: WorktreeButton = st.pr
    ? { label: 'Enviar para o PR', disabled: st.pushed ? 'O PR já tem todos os commits' : undefined }
    : {
        label: 'Abrir PR',
        disabled: !st.remote ? 'O repositório não tem o remoto "origin"' : !st.ahead && !st.pushed ? `Nenhum commit novo em relação a ${target}` : undefined,
      };
  const merge: WorktreeButton = {
    label: `Trazer para ${target}`,
    disabled: !st.target
      ? 'A pasta da sala não está numa branch'
      : !st.ahead
        ? `${st.target} já tem todos os commits`
        : st.conflicts?.length
          ? `Daria conflito em ${st.conflicts.join(', ')}`
          : undefined,
  };
  const remove: WorktreeButton = {
    label: 'Encerrar worktree',
    disabled: st.dirty ? 'Tem arquivo não commitado no worktree' : undefined,
  };
  const summary = !st.target
    ? 'Sala sem branch'
    : st.ahead
      ? `${commits(st.ahead)} a mais que ${st.target}${st.behind ? `, ${commits(st.behind)} atrás` : ''}`
      : `Tudo já está em ${st.target}`;
  const warnings = [
    st.dirty ? `${st.dirty} arquivo(s) não commitado(s) ficam de fora do merge e do PR.` : '',
    st.conflicts?.length ? `Conflito com ${target} em: ${st.conflicts.join(', ')}. Peça ao agente para trazer ${target} para a branch dele e resolver.` : '',
  ].filter(Boolean);
  return { pr, merge, remove, summary, warnings };
}

/** Texto da opção de apagar a branch ao encerrar: só liga se o trabalho tem outra cópia. */
export function deleteBranchOption(st: WorktreeStatus): { allowed: boolean; hint: string } {
  if (canDeleteBranch(st)) return { allowed: true, hint: st.ahead === 0 && st.target ? `O trabalho já está em ${st.target}.` : 'A branch está no origin.' };
  return { allowed: false, hint: `Ela tem commits que não estão em ${st.target ?? 'a sala'} nem no origin.` };
}

/** Como o indicador da memória (ai-memory) aparece no topo e o que o diálogo oferece. */
export function memoryView(st: MemoryStatus | undefined): {
  label: string;
  tone: 'on' | 'off' | 'warn' | 'busy';
  /** O que falta, em português, para a memória funcionar. */
  problems: string[];
  canInstall: boolean;
  canUninstall: boolean;
  /** No Windows: mostrar os comandos para colar no PowerShell. */
  showSteps: boolean;
} {
  if (!st) return { label: 'Memória', tone: 'off', problems: [], canInstall: false, canUninstall: false, showSteps: false };
  const busy = !!st.job && !st.job.done;
  const on = st.running && st.hooks && st.mcp;
  const any = st.running || st.hooks || st.mcp;
  const problems = on
    ? []
    : [
        !st.running ? 'O servidor do ai-memory não está respondendo.' : '',
        !st.hooks ? 'As sessões do Claude não estão sendo guardadas (faltam os hooks).' : '',
        !st.mcp ? 'O Claude não consegue consultar a memória (falta o MCP).' : '',
      ].filter(Boolean);
  const label = busy ? (st.job!.kind === 'instalar' ? 'Memória: instalando…' : 'Memória: removendo…') : on ? 'Memória: ligada' : any ? 'Memória: incompleta' : 'Memória: desligada';
  return {
    label,
    tone: busy ? 'busy' : on ? 'on' : any ? 'warn' : 'off',
    problems,
    canInstall: st.autoInstall && !busy && !on,
    canUninstall: st.autoInstall && !busy && any,
    showSteps: !st.autoInstall && !on,
  };
}

// ---------- explorador de arquivos ----------

/** Caminho de `name` dentro da pasta `dir` (vazio = raiz), sempre com "/". */
export function childPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Pasta que contém `p` (vazio = raiz). */
export function parentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Por que o nome não serve para um arquivo ou pasta; undefined se serve. */
export function fileNameError(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Digite um nome.';
  if (/[\\/]/.test(n)) return 'O nome não pode ter "/" nem "\\".';
  if (n === '.' || n === '..') return 'Esse nome não pode.';
  if (n.toLowerCase() === '.git') return 'A pasta .git fica de fora do explorador.';
  if (/[<>:"|?*\x00-\x1f]/.test(n)) return 'O Windows não aceita < > : " | ? * no nome.';
  return undefined;
}

/**
 * Onde fica um arquivo aberto depois de renomear `from` para `to`: o próprio arquivo ou uma
 * pasta acima dele. Undefined se a renomeação não o afeta.
 */
export function renamedPath(open: string, from: string, to: string): string | undefined {
  if (open === from) return to;
  if (open.startsWith(`${from}/`)) return to + open.slice(from.length);
  return undefined;
}

/** O arquivo aberto foi apagado junto com `removed` (ele mesmo ou uma pasta acima). */
export function removedWith(open: string, removed: string): boolean {
  return open === removed || open.startsWith(`${removed}/`);
}

/**
 * Marcas do git na árvore: a letra de cada arquivo alterado, e "•" nas pastas que têm algo
 * alterado dentro, para você achar as mudanças sem abrir pasta por pasta.
 */
export function treeMarks(changes: FileChange[]): Map<string, string> {
  const marks = new Map<string, string>();
  for (const c of changes) {
    marks.set(c.path, c.status === '??' ? '?' : c.status[0]);
    for (let dir = parentPath(c.path); dir; dir = parentPath(dir)) {
      if (marks.has(dir)) break;
      marks.set(dir, '•');
    }
  }
  return marks;
}

/** O arquivo no editor em relação ao último commit: igual, diferente ou novo (fora do git). */
export type HeadState = 'equal' | 'differs' | 'new' | 'unknown';

export interface EditorButtons {
  save: boolean;
  /** Volta ao que está salvo no disco. */
  undoEdit: boolean;
  /** Mostra o arquivo lado a lado com o último commit. */
  changes: boolean;
  /** Volta o arquivo inteiro ao último commit. */
  restore: boolean;
}

/** Quais botões o editor mostra, pelo estado do arquivo aberto. */
export function editorButtons(s: { readOnly: boolean; dirty: boolean; head: HeadState; showingChanges: boolean }): EditorButtons {
  if (s.readOnly) return { save: false, undoEdit: false, changes: false, restore: false };
  return {
    save: true,
    undoEdit: s.dirty,
    // Na tela de alterações o botão continua, para voltar ao editor.
    changes: s.head === 'differs' || s.showingChanges,
    restore: s.head === 'differs',
  };
}

/**
 * Compara o texto do editor com o do último commit (ausente = arquivo novo; null = sem git).
 * O fim de linha não conta: no Windows o git grava \r\n, e o arquivo pode ter vindo com \n.
 */
export function headState(current: string, head: string | null | undefined): HeadState {
  if (head === null) return 'unknown';
  if (head === undefined) return 'new';
  const lf = (t: string) => t.replace(/\r\n/g, '\n');
  return current === head || lf(current) === lf(head) ? 'equal' : 'differs';
}

// ---------- painel de git ----------

/** Seções do painel de git que você pode recolher. */
export type GitSection = 'worktree' | 'working' | 'branch' | 'commits';

/** Como cada seção começa: as de arquivos abertas, os últimos commits fechados. */
const GIT_SECTIONS_OPEN: Record<GitSection, boolean> = { worktree: true, working: true, branch: true, commits: false };

/** A seção está aberta: o que você escolheu por último, ou o padrão dela. */
export function gitSectionOpen(saved: Partial<Record<GitSection, boolean>>, sec: GitSection): boolean {
  return saved[sec] ?? GIT_SECTIONS_OPEN[sec];
}
