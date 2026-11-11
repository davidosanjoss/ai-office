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
  /** Como os agentes das salas deste andar trabalham (ausente = padrão do Claude Code). */
  defaults?: FloorDefaults;
}

/** Padrões de um andar, aplicados a cada sessão do Claude que abre (ou volta) numa sala dele. */
export interface FloorDefaults {
  /** false tira a co-autoria do Claude dos commits e PRs (ausente = como o Claude Code faz). */
  coAuthor?: boolean;
  /** Texto acrescentado ao prompt de sistema de cada agente do andar. */
  instructions?: string;
  /** Política de contexto grande (shared/context.ts); ausente = 'avisar'. */
  context?: import('./context.ts').ContextPolicy;
}

/** Um projeto (repositório) dentro de uma sala. */
export interface Project {
  id: string;
  name: string;
  /** Pasta do projeto: a própria raiz da sala ou uma pasta dentro dela. */
  path: string;
  /** Ficha curta que os agentes dos outros projetos da sala recebem. Começa como rascunho automático. */
  summary: string;
  /** Você editou a ficha: o rascunho automático não a substitui mais. */
  summaryEdited?: boolean;
  /** Modelos dos agentes deste projeto (ausente = o padrão da sua conta no Claude Code). */
  models?: ProjectModels;
}

/**
 * Modelos de um projeto. 'unico': um modelo para tudo. 'duplo': um para o raciocínio (o modo de
 * planejamento do Claude Code) e outro para a execução.
 */
export interface ProjectModels {
  mode: 'unico' | 'duplo';
  /** Modelo único (alias como "opus" ou o nome completo, como "claude-opus-5-5"). */
  model?: string;
  reasoning?: string;
  execution?: string;
}

/**
 * Uma sala é a pasta raiz de um sistema (ex.: ~/ampm/saff) e reúne os projetos dele. Cada agente
 * trabalha num projeto e recebe o contexto da sala: o fluxo, as fichas dos outros projetos e quem
 * está fazendo o quê.
 */
export interface Room {
  id: string;
  name: string;
  /** Pasta raiz da sala. */
  path: string;
  /** Projetos da sala. Salas de antes disso ganham um, com a própria pasta, ao carregar. */
  projects?: Project[];
  /** Resumo do sistema como um todo (o fluxo entre os projetos), escrito por você. */
  brief?: string;
  createdAt: number;
  /** Andar da sala. Salas de antes dos andares vão para o primeiro andar ao carregar. */
  floorId?: string;
  /** Vaga na planta do andar (shared/building.ts). Salas antigas ganham uma ao carregar. */
  pos?: { x: number; y: number };
  /** Festa ou alarme na sala (eventos do GitHub), até `until`. */
  effect?: import('./live.ts').RoomEffect;
}

export interface Agent {
  id: string;
  /** 'shell' é um terminal comum, sem Claude. Ausente nos registros antigos = 'claude'. */
  kind?: 'claude' | 'shell';
  roomId: string;
  /** Projeto da sala em que o agente trabalha. Ausente nos registros antigos = o primeiro da sala. */
  projectId?: string;
  /** Modelos com que a sessão abriu (modelsLabel): se o projeto mudou depois, vale ao retomar. */
  models?: string;
  /** Comandos que o agente deixou rodando em segundo plano ("esperando o shell"). */
  shells?: import('./live.ts').BgShell[];
  /** O comando que ele esperava acabou: comemoração ou nuvem de chuva, até `until`. */
  effect?: import('./live.ts').AgentEffect;
  /** Lista de tarefas do agente (TodoWrite), para o progresso nos detalhes. */
  todos?: { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }[];
  /** Ajudantes (subagentes) chamados e ainda trabalhando: a descrição de cada um. */
  helpers?: string[];
  name: string;
  /** Pasta onde o agente roda: a do projeto ou a de um worktree. */
  cwd: string;
  /** Branch do worktree, quando o agente tem um. */
  worktreeBranch?: string;
  /** PR aberto pelo escritório para a branch do worktree. */
  worktreePr?: string;
  sessionId: string;
  /** Sessões anteriores deste agente (trocadas por uma sessão nova com resumo): o consumo delas continua dele. */
  pastSessions?: string[];
  /** Já pediu para gravar a memória nesta travessia do limite de contexto (shared/context.ts). */
  contextSaved?: boolean;
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

/** Situação do worktree de um agente em relação à branch da sala, para as ações do painel de git. */
export interface WorktreeStatus {
  branch: string;
  /** Branch em que a pasta da sala está, para onde o trabalho volta. Ausente com HEAD solto. */
  target?: string;
  /** Commits do worktree que a branch da sala não tem. */
  ahead: number;
  /** Commits da branch da sala que o worktree não tem. */
  behind: number;
  /** Arquivos não commitados no worktree: não vão no merge nem no PR. */
  dirty: number;
  /** Arquivos que dariam conflito ao trazer para a sala; ausente se não deu para prever. */
  conflicts?: string[];
  /** O repositório tem o remoto `origin`. */
  remote: boolean;
  /** `origin/<branch>` está no mesmo commit do worktree. */
  pushed: boolean;
  pr?: string;
  /** Título e descrição sugeridos para o PR, a partir dos commits. */
  suggestion: { title: string; body: string };
}

export interface FileDiff {
  path: string;
  scope: DiffScope;
  /** Diff unificado (formato do `git diff`). */
  diff: string;
  binary: boolean;
  truncated: boolean;
}

/** Um item de uma pasta, no explorador de arquivos. */
export interface DirEntry {
  name: string;
  kind: 'dir' | 'file';
}

export interface DirListing {
  /** Pasta listada, relativa à raiz do projeto, com "/" (vazio = raiz). */
  path: string;
  entries: DirEntry[];
  /** A pasta tinha itens demais e a lista foi cortada. */
  truncated: boolean;
}

/** Um arquivo aberto no editor: da pasta (editável) ou de um commit (só leitura). */
export interface FileContent {
  path: string;
  content: string;
  /** Impressão digital do conteúdo lido; o salvar a confere para não apagar o que um agente mudou. */
  version: string;
  binary: boolean;
  /** Grande demais para abrir no editor. */
  tooLarge: boolean;
  /** Na leitura de um commit: o arquivo não existe nele. */
  missing?: boolean;
}

/** Uma branch ou tag, para escolher o que ver no histórico. */
export interface GitRef {
  name: string;
  kind: 'branch' | 'remote' | 'tag';
  hash: string;
  when: string;
  subject: string;
  /** É a branch em que a pasta está. */
  current?: boolean;
}

export interface CommitSummary {
  hash: string;
  short: string;
  subject: string;
  author: string;
  /** Data relativa ("há 2 dias"). */
  when: string;
  /** Data ISO, para o título ao passar o mouse. */
  date: string;
  parents: string[];
}

export interface CommitLog {
  commits: CommitSummary[];
  /** Há commits mais antigos além dos que vieram. */
  more: boolean;
}

export interface CommitDetail extends CommitSummary {
  /** Mensagem completa, com o corpo. */
  message: string;
  /** Com o que foi comparado: o primeiro pai (ou a árvore vazia, no primeiro commit). */
  base: string;
  files: FileChange[];
}

/** Diferença entre duas refs: o que "to" tem de diferente de "from". */
export interface RefCompare {
  from: string;
  to: string;
  /** Hashes completos das duas pontas, para ler os arquivos de cada lado. */
  fromHash: string;
  toHash: string;
  /** Commits de "to" que "from" não tem, e o contrário. */
  ahead: number;
  behind: number;
  commits: CommitSummary[];
  files: FileChange[];
}

/** Situação do ai-memory (memória dos agentes), para o indicador do topo. */
export interface MemoryStatus {
  /** O servidor do ai-memory responde no `/healthz`. */
  running: boolean;
  /** Hooks do ai-memory instalados no Claude Code (capturam as sessões). */
  hooks: boolean;
  /** MCP do ai-memory registrado no Claude Code (as sessões consultam a memória). */
  mcp: boolean;
  url: string;
  /** Pasta dos dados: a padrão do ai-memory, fora deste repositório. */
  dataDir: string;
  version: string;
  /** Instalação pelo botão (Linux e macOS). No Windows, o escritório mostra o passo a passo. */
  autoInstall: boolean;
  /** Achou o comando `docker`. */
  docker: boolean;
  /** Versão que o container do servidor está rodando (ausente sem container ou sem Docker). */
  serverVersion?: string;
  /** O container roda outra versão que a fixada: o Instalar atualiza (com backup dos dados). */
  outdated?: boolean;
  /** Instalação ou remoção em andamento (ou a última, com o erro). */
  job?: MemoryJob;
}

export interface MemoryJob {
  kind: 'instalar' | 'desinstalar';
  /** Passo atual, em português, para mostrar no diálogo. */
  step: string;
  done: boolean;
  error?: string;
  /** Últimas linhas de saída dos comandos, para quando algo falha. */
  log: string[];
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
  | { t: 'memory'; memory: MemoryStatus }
  | { t: 'activity'; event: ActivityEvent }
  | { t: 'out'; id: string; data: string }
  | { t: 'replay'; id: string; data: string }
  | { t: 'requests'; requests: import('./permissions.ts').PendingRequest[] };

// Mensagens WebSocket navegador → servidor
export type ClientMsg =
  | { t: 'in'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'attach'; id: string }
  | { t: 'seen'; id: string };
