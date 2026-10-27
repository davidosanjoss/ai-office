// Tipos compartilhados entre servidor e navegador.

export type AgentStatus =
  | 'starting' // PTY aberto, Claude ainda carregando
  | 'idle' // pronto, esperando instrução
  | 'working' // processando um pedido
  | 'waiting' // pediu permissão: levanta a mão
  | 'done' // terminou o pedido e você ainda não viu
  | 'exited'; // processo encerrado (pode ser retomado)

/** Um andar do prédio: uma empresa ou contexto (empresa, pessoal, freelance...). */
export interface Floor {
  id: string;
  name: string;
  /** Cor das paredes, da placa e do botão no elevador. */
  color: string;
  /** Posição no prédio: 1 é o primeiro andar acima do térreo. */
  order: number;
  createdAt: number;
  /** Quantas salas de guerra o andar tem (ausente = 1). */
  warRooms?: number;
}

export interface Room {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  /** Andar da sala. Salas de antes dos andares vão para o primeiro andar ao carregar. */
  floorId?: string;
  /** Vaga na planta do andar (shared/building.ts). Salas antigas ganham uma ao carregar. */
  pos?: { x: number; y: number };
}

export interface Agent {
  id: string;
  /** 'shell' é um terminal comum, sem Claude. Ausente nos registros antigos = 'claude'. */
  kind?: 'claude' | 'shell';
  roomId: string;
  name: string;
  /** Pasta onde o agente roda: a do projeto ou a de um worktree. */
  cwd: string;
  /** Branch do worktree, quando o agente tem um. */
  worktreeBranch?: string;
  sessionId: string;
  status: AgentStatus;
  activity: string;
  subagents: number;
  createdAt: number;
  /** Quando entrou em 'done' ou 'waiting'; ordena a fila de atenção. */
  attentionAt?: number;
  exitCode?: number;
  /** Incidente em que o agente está: ele fica na sala de guerra, e a mesa dele fica vazia. */
  incidentId?: string;
  /** Contratado só para o incidente: vai embora quando o incidente é encerrado. */
  forIncident?: boolean;
}

/** Uma mensagem no chat da sala de guerra. */
export interface IncidentMessage {
  id: number;
  ts: number;
  /** 'voce': você escreveu; 'agente': resposta de um participante; 'repasse': você repassou a
   * resposta de um agente para os outros; 'sistema': entrada, saída e avisos. */
  kind: 'voce' | 'agente' | 'repasse' | 'sistema';
  /** Agente que falou (respostas e repasses). */
  agentId?: string;
  /** Para quem foi (vazio = todos os participantes). */
  to: string[];
  text: string;
}

/** Um problema investigado na sala de guerra de um andar. */
export interface Incident {
  id: string;
  floorId: string;
  /** Qual sala de guerra do andar (0 é a de baixo). */
  slot: number;
  title: string;
  description: string;
  createdAt: number;
  /** Agentes na sala, na ordem em que entraram. */
  participants: string[];
  messages: IncidentMessage[];
  /** Registro em markdown (linha do tempo), que os agentes podem ler. */
  file: string;
}

export interface ActivityEvent {
  id: number;
  ts: number;
  agentId: string;
  roomId: string;
  text: string;
  kind: 'tool' | 'prompt' | 'done' | 'waiting' | 'system';
}

export interface OfficeState {
  floors: Floor[];
  rooms: Room[];
  agents: Agent[];
  activity: ActivityEvent[];
  incidents: Incident[];
}

/** Um arquivo alterado. additions/deletions ausentes = binário. */
export interface FileChange {
  path: string;
  /** Letra do git: M modificado, A novo, D apagado, ?? não rastreado, U conflito. */
  status: string;
  additions?: number;
  deletions?: number;
}

/** 'working': o que não foi commitado. 'branch': o que a branch mudou desde que saiu da base. */
export type DiffScope = 'working' | 'branch';

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  /** Mudanças não commitadas (incluindo arquivos novos). */
  files?: FileChange[];
  /** Branch de onde esta saiu (ex.: main), quando é outra. */
  base?: string;
  /** Commits desta branch que a base não tem. */
  branchCommits?: number;
  /** O que a branch mudou desde o ponto em que saiu da base. */
  branchFiles?: FileChange[];
  commits?: { hash: string; subject: string; when: string }[];
  worktrees?: { path: string; branch: string }[];
}

export interface FileDiff {
  path: string;
  scope: DiffScope;
  /** Diff unificado (formato do `git diff`). */
  diff: string;
  binary: boolean;
  truncated: boolean;
}

// Mensagens WebSocket servidor → navegador
export type ServerMsg =
  | { t: 'state'; state: OfficeState }
  | { t: 'agent'; agent: Agent }
  | { t: 'agentRemoved'; id: string }
  | { t: 'floor'; floor: Floor }
  | { t: 'floorRemoved'; id: string }
  | { t: 'room'; room: Room }
  | { t: 'roomRemoved'; id: string }
  | { t: 'incident'; incident: Incident }
  | { t: 'incidentRemoved'; id: string }
  | { t: 'activity'; event: ActivityEvent }
  | { t: 'out'; id: string; data: string }
  | { t: 'replay'; id: string; data: string };

// Mensagens WebSocket navegador → servidor
export type ClientMsg =
  | { t: 'in'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'attach'; id: string }
  | { t: 'seen'; id: string };
