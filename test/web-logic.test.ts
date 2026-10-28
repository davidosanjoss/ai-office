import { describe, expect, it } from 'vitest';
import type { Agent, Floor, Incident, IncidentMessage, MemoryStatus, Room } from '../shared/types.ts';
import {
  IDLE_RELEASE_MS,
  TYPING_GRACE_MS,
  attentionQueue,
  becameAttention,
  exitedMessage,
  memoryView,
  roomTabs,
  warTabs,
  nextAutoFocus,
  childPath,
  parentPath,
  fileNameError,
  renamedPath,
  removedWith,
  treeMarks,
  editorButtons,
  headState,
  gitSectionOpen,
  officeAgents,
  resumeLabel,
  roomAgents,
  TERREO,
  agentsOnFloor,
  attentionByFloor,
  elevatorStops,
  floorOfAgent,
  nextStop,
  roomsOnFloor,
  directoryTree,
  normalize,
  officeCounters,
  canRemoveWarRoom,
  canShare,
  chatAuthor,
  incidentAgents,
  incidentAt,
  incidentCandidates,
  warRoomsOf,
} from '../web/logic.ts';

const agent = (id: string, patch: Partial<Agent> = {}): Agent => ({
  id,
  kind: 'claude',
  roomId: 'r1',
  name: id,
  cwd: '/x',
  sessionId: id,
  status: 'working',
  activity: '',
  subagents: 0,
  createdAt: 0,
  ...patch,
});

const NOW = 1_000_000;
const focus = (agents: Agent[], selectedId: string | undefined, patch: Partial<Parameters<typeof nextAutoFocus>[0]> = {}) =>
  nextAutoFocus({ agents, selectedId, enabled: true, now: NOW, lastKeyAt: 0, selectedAt: 0, ...patch });

describe('fila de atenção', () => {
  it('ordena quem terminou ou pediu aprovação, do mais antigo para o mais novo', () => {
    const q = attentionQueue([
      agent('a', { status: 'done', attentionAt: 30 }),
      agent('b', { status: 'working' }),
      agent('c', { status: 'waiting', attentionAt: 10 }),
      agent('d', { status: 'done' }), // sem attentionAt: já visto
    ]);
    expect(q.map((a) => a.id)).toEqual(['c', 'a']);
  });

  it('avisa só quando o status muda para terminou/aprovação', () => {
    expect(becameAttention(agent('a', { status: 'working' }), agent('a', { status: 'done' }))).toBe(true);
    expect(becameAttention(agent('a', { status: 'done' }), agent('a', { status: 'done', activity: 'x' }))).toBe(false);
    expect(becameAttention(undefined, agent('a', { status: 'waiting' }))).toBe(true);
    expect(becameAttention(undefined, agent('a', { status: 'idle' }))).toBe(false);
  });
});

describe('foco automático', () => {
  const done = (id: string, at: number) => agent(id, { status: 'done', attentionAt: at });

  it('abre o terminal de quem terminou primeiro', () => {
    expect(focus([agent('atual'), done('b', 20), done('c', 10)], 'atual')).toBe('c');
  });

  it('regressão: não troca de agente com o explorador aberto (escondia o arquivo que você editava)', () => {
    expect(focus([agent('atual', { status: 'working' }), done('b', 5)], 'atual', { exploring: true })).toBeUndefined();
    expect(focus([agent('atual', { status: 'working' }), done('b', 5)], 'atual', { exploring: false })).toBe('b');
  });

  it('sem ninguém selecionado, vai para o primeiro da fila', () => {
    expect(focus([done('b', 5)], undefined)).toBe('b');
  });

  it('desligado, não troca', () => {
    expect(focus([agent('atual'), done('b', 1)], 'atual', { enabled: false })).toBeUndefined();
  });

  it('regressão: não troca enquanto você digita', () => {
    expect(focus([agent('atual'), done('b', 1)], 'atual', { lastKeyAt: NOW - TYPING_GRACE_MS + 100 })).toBeUndefined();
  });

  it('regressão: não sai de um agente que terminou enquanto você lê a resposta dele', () => {
    const agents = [done('lendo', 1), done('outro', 2)];
    expect(focus(agents, 'lendo', { selectedAt: NOW - 60_000 })).toBeUndefined();
  });

  it('não sai de quem está pedindo aprovação', () => {
    expect(focus([agent('atual', { status: 'waiting', attentionAt: 1 }), done('b', 2)], 'atual')).toBeUndefined();
  });

  it('agente parado só libera o foco depois de um tempo sem você digitar', () => {
    const agents = [agent('atual', { status: 'idle' }), done('b', 1)];
    expect(focus(agents, 'atual', { selectedAt: NOW - 1000 })).toBeUndefined();
    expect(focus(agents, 'atual', { selectedAt: NOW - IDLE_RELEASE_MS - 1 })).toBe('b');
  });

  it('agente encerrado libera o foco', () => {
    expect(focus([agent('atual', { status: 'exited' }), done('b', 1)], 'atual')).toBe('b');
  });

  it('fila vazia, fica onde está', () => {
    expect(focus([agent('atual')], 'atual')).toBeUndefined();
  });
});

describe('abas e escritório', () => {
  it('abas da sala em ordem de chegada, incluindo terminais comuns', () => {
    const list = roomAgents(
      [agent('b', { createdAt: 2 }), agent('x', { roomId: 'r2' }), agent('sh', { kind: 'shell', createdAt: 3 }), agent('a', { createdAt: 1 })],
      'r1',
    );
    expect(list.map((a) => a.id)).toEqual(['a', 'b', 'sh']);
  });

  it('terminais comuns não viram funcionários no escritório', () => {
    expect(officeAgents([agent('a'), agent('sh', { kind: 'shell' }), agent('old', { kind: undefined })]).map((a) => a.id)).toEqual(['a', 'old']);
  });
});

describe('faixa de "encerrado"', () => {
  it('terminal comum: reabrir', () => {
    const sh = agent('Terminal 1', { kind: 'shell', status: 'exited' });
    expect(resumeLabel(sh)).toBe('Reabrir terminal');
    expect(exitedMessage(sh)).toContain('servidor reiniciou');
  });

  it('agente: retomar conversa, com o código de saída', () => {
    const a = agent('Ana', { status: 'exited', activity: 'Saiu do escritório', exitCode: 0 });
    expect(resumeLabel(a)).toBe('Retomar conversa');
    expect(exitedMessage(a)).toBe('Ana saiu do escritório (código 0). A conversa continua salva.');
  });

  it('regressão: mostra o motivo quando o Claude não conseguiu abrir', () => {
    const a = agent('Ana', { status: 'exited', activity: 'Não conseguiu abrir: No conversation found', exitCode: 1 });
    expect(exitedMessage(a)).toBe('Ana não conseguiu abrir: No conversation found');
  });
});

describe('andares', () => {
  const floors: Floor[] = [
    { id: 'empresa', name: 'Empresa', color: '#7aa2f7', order: 1, createdAt: 0 },
    { id: 'pessoal', name: 'Pessoal', color: '#9ece6a', order: 2, createdAt: 0 },
  ];
  const rooms: Room[] = [
    { id: 'r1', name: 'api', path: '/api', createdAt: 0, floorId: 'empresa' },
    { id: 'r2', name: 'site', path: '/site', createdAt: 0, floorId: 'pessoal' },
  ];

  it('salas e agentes de cada andar; o térreo não tem salas', () => {
    const agents = [agent('a', { roomId: 'r1' }), agent('b', { roomId: 'r2' })];
    expect(roomsOnFloor(rooms, 'empresa').map((r) => r.id)).toEqual(['r1']);
    expect(roomsOnFloor(rooms, TERREO)).toEqual([]);
    expect(agentsOnFloor(agents, rooms, 'pessoal').map((a) => a.id)).toEqual(['b']);
    expect(floorOfAgent(agents[0], rooms)).toBe('empresa');
  });

  it('bolinha do elevador: quantos precisam de você em cada andar', () => {
    const agents = [
      agent('a', { roomId: 'r1', status: 'done', attentionAt: 1 }),
      agent('b', { roomId: 'r1', status: 'waiting', attentionAt: 2 }),
      agent('c', { roomId: 'r2', status: 'working' }),
    ];
    expect(Object.fromEntries(attentionByFloor(agents, rooms))).toEqual({ empresa: 2 });
  });

  it('o foco automático só olha o andar em que você está', () => {
    const agents = [agent('atual', { roomId: 'r1' }), agent('outro', { roomId: 'r2', status: 'done', attentionAt: 1 })];
    // Quem terminou está em outro andar: no andar da empresa, o foco fica onde está.
    expect(focus(agentsOnFloor(agents, rooms, 'empresa'), 'atual')).toBeUndefined();
    expect(focus(agentsOnFloor(agents, rooms, 'pessoal'), undefined)).toBe('outro');
  });

  it('elevador: térreo embaixo, andares pela ordem, e para nas pontas', () => {
    expect(elevatorStops(floors)).toEqual([TERREO, 'empresa', 'pessoal']);
    expect(nextStop(floors, TERREO, 1)).toBe('empresa');
    expect(nextStop(floors, 'pessoal', 1)).toBe('pessoal');
    expect(nextStop(floors, 'empresa', -1)).toBe(TERREO);
    expect(nextStop(floors, 'apagado', 1)).toBe('empresa');
  });
});

describe('barra lateral e contadores', () => {
  const floors: Floor[] = [
    { id: 'empresa', name: 'Empresa', color: '#7aa2f7', order: 1, createdAt: 0 },
    { id: 'freela', name: 'Freelance', color: '#9ece6a', order: 2, createdAt: 0 },
  ];
  const rooms: Room[] = [
    { id: 'r1', name: 'gateway', path: '/g', createdAt: 0, floorId: 'empresa' },
    { id: 'r2', name: 'filas', path: '/f', createdAt: 0, floorId: 'empresa' },
    { id: 'r3', name: 'site-cliente', path: '/s', createdAt: 0, floorId: 'freela' },
  ];
  const agents = [
    agent('Vitória', { roomId: 'r1', status: 'working', subagents: 2, activity: 'Editando proxy.ts' }),
    agent('Bruno', { roomId: 'r2', status: 'done', attentionAt: 1, activity: 'Terminou!' }),
    agent('Carla', { roomId: 'r3', status: 'exited' }),
    agent('Terminal 1', { roomId: 'r1', kind: 'shell', status: 'idle' }),
  ];

  it('contadores do topo', () => {
    expect(officeCounters(rooms, agents)).toEqual({ salas: 3, agentes: 3, trabalhando: 1, ajudantes: 2, terminais: 1, precisam: 1 });
  });

  it('sem busca: todos os andares, salas em ordem alfabética, terminais comuns de fora', () => {
    const tree = directoryTree(floors, rooms, agents);
    expect(tree.map((f) => f.floor.id)).toEqual(['empresa', 'freela']);
    expect(tree[0].rooms.map((r) => r.room.name)).toEqual(['filas', 'gateway']);
    expect(tree[0].rooms[1].agents.map((a) => a.name)).toEqual(['Vitória']);
  });

  it('busca por agente, sem acento: mostra só o caminho até ele', () => {
    const tree = directoryTree(floors, rooms, agents, 'vitoria');
    expect(tree.map((f) => f.floor.id)).toEqual(['empresa']);
    expect(tree[0].rooms.map((r) => r.room.name)).toEqual(['gateway']);
  });

  it('busca pelo que o agente está fazendo', () => {
    expect(directoryTree(floors, rooms, agents, 'proxy')[0].rooms[0].agents[0].name).toBe('Vitória');
  });

  it('achar o andar ou a sala mostra tudo o que tem dentro', () => {
    expect(directoryTree(floors, rooms, agents, 'freela')[0].rooms[0].agents.map((a) => a.name)).toEqual(['Carla']);
    expect(directoryTree(floors, rooms, agents, 'filas')[0].rooms[0].agents.map((a) => a.name)).toEqual(['Bruno']);
  });

  it('busca sem resultado: árvore vazia; andar sem salas aparece sem busca', () => {
    expect(directoryTree(floors, rooms, agents, 'nada-a-ver')).toEqual([]);
    const vazio: Floor = { id: 'novo', name: 'Novo', color: '#fff', order: 3, createdAt: 0 };
    expect(directoryTree([...floors, vazio], rooms, agents).at(-1)).toEqual({ floor: vazio, rooms: [] });
    expect(normalize('Ação')).toBe('acao');
  });
});

describe('sala de guerra', () => {
  const floor: Floor = { id: 'f', name: 'Empresa', color: '#7aa2f7', order: 1, createdAt: 0 };
  const rooms: Room[] = [
    { id: 'r1', name: 'gateway', path: '/g', createdAt: 0, floorId: 'f' },
    { id: 'r2', name: 'filas', path: '/q', createdAt: 0, floorId: 'f' },
    { id: 'r3', name: 'site', path: '/s', createdAt: 0, floorId: 'outro' },
  ];
  const incident: Incident = { id: 'i', floorId: 'f', slot: 0, title: '503', description: '', createdAt: 0, participants: ['b', 'a'], messages: [], file: '/x.md' };
  const msg = (patch: Partial<IncidentMessage>): IncidentMessage => ({ id: 1, ts: 0, kind: 'agente', to: [], text: '', ...patch });

  it('um andar tem uma sala de guerra até você abrir outra', () => {
    expect(warRoomsOf(floor)).toBe(1);
    expect(warRoomsOf({ ...floor, warRooms: 3 })).toBe(3);
    expect(incidentAt([incident], 'f', 0)).toBe(incident);
    expect(incidentAt([incident], 'f', 1)).toBeUndefined();
  });

  it('as abas são os participantes, na ordem em que entraram, sem quem já saiu', () => {
    const agents = [agent('a'), agent('b')];
    expect(incidentAgents(incident, agents).map((a) => a.id)).toEqual(['b', 'a']);
    expect(incidentAgents(incident, [agent('a')]).map((a) => a.id)).toEqual(['a']);
    expect(incidentAgents(undefined, agents)).toEqual([]);
  });

  it('só agentes do Claude do andar, fora de outro incidente, podem ser chamados', () => {
    const agents = [
      agent('livre', { roomId: 'r1' }),
      agent('ocupado', { roomId: 'r2', incidentId: 'x' }),
      agent('terminal', { roomId: 'r1', kind: 'shell' }),
      agent('outro-andar', { roomId: 'r3' }),
    ];
    expect(incidentCandidates(agents, rooms, 'f').map((a) => a.id)).toEqual(['livre']);
  });

  it('no chat, cada resposta mostra quem falou e de qual projeto', () => {
    const agents = [agent('a', { name: 'Ana', roomId: 'r1' })];
    expect(chatAuthor(msg({ kind: 'voce' }), agents, rooms)).toBe('Você');
    expect(chatAuthor(msg({ kind: 'agente', agentId: 'a' }), agents, rooms)).toBe('Ana · gateway');
    expect(chatAuthor(msg({ kind: 'repasse', agentId: 'a' }), agents, rooms)).toBe('Repasse de Ana · gateway');
    expect(chatAuthor(msg({ kind: 'agente', agentId: 'sumiu' }), agents, rooms)).toBe('Agente que saiu');
  });

  it('só dá para repassar a resposta de um agente quando há mais alguém na sala', () => {
    expect(canShare(msg({ agentId: 'a' }), incident)).toBe(true);
    expect(canShare(msg({ agentId: 'a' }), { ...incident, participants: ['a'] })).toBe(false);
    expect(canShare(msg({ kind: 'voce' }), incident)).toBe(false);
    expect(canShare(msg({ kind: 'repasse', agentId: 'a' }), incident)).toBe(false);
  });

  it('só a sala de guerra de cima, vazia, pode ser tirada; a primeira fica sempre', () => {
    const three = { ...floor, warRooms: 3 };
    expect(canRemoveWarRoom(three, 2, [])).toBe(true);
    expect(canRemoveWarRoom(three, 1, [])).toBe(false);
    expect(canRemoveWarRoom(three, 2, [{ ...incident, slot: 2 }])).toBe(false);
    expect(canRemoveWarRoom(floor, 0, [])).toBe(false);
  });
});

describe('indicador da memória (ai-memory)', () => {
  const st = (patch: Partial<MemoryStatus> = {}): MemoryStatus => ({
    running: false,
    hooks: false,
    mcp: false,
    url: 'http://127.0.0.1:49374',
    dataDir: '/home/ana/.local/share/ai-memory',
    version: '3.2.8',
    autoInstall: true,
    docker: true,
    ...patch,
  });

  it('nada instalado: desligada, oferece instalar e diz o que falta', () => {
    const v = memoryView(st());
    expect(v).toMatchObject({ label: 'Memória: desligada', tone: 'off', canInstall: true, canUninstall: false, showSteps: false });
    expect(v.problems).toHaveLength(3);
  });

  it('tudo no lugar: ligada, sem instalar de novo', () => {
    expect(memoryView(st({ running: true, hooks: true, mcp: true }))).toMatchObject({ label: 'Memória: ligada', tone: 'on', canInstall: false, canUninstall: true, problems: [] });
  });

  it('servidor fora do ar com o Claude ligado: incompleta, e instalar de novo sobe o servidor', () => {
    const v = memoryView(st({ hooks: true, mcp: true }));
    expect(v).toMatchObject({ label: 'Memória: incompleta', tone: 'warn', canInstall: true, canUninstall: true });
    expect(v.problems).toEqual(['O servidor do ai-memory não está respondendo.']);
  });

  it('instalando: nenhum botão até terminar', () => {
    const v = memoryView(st({ job: { kind: 'instalar', step: 'x', done: false, log: [] } }));
    expect(v).toMatchObject({ label: 'Memória: instalando…', tone: 'busy', canInstall: false, canUninstall: false });
  });

  it('Windows: sem botão de instalar, mostra o passo a passo', () => {
    expect(memoryView(st({ autoInstall: false }))).toMatchObject({ canInstall: false, canUninstall: false, showSteps: true });
    expect(memoryView(st({ autoInstall: false, running: true, hooks: true, mcp: true })).showSteps).toBe(false);
  });
});

describe('abas da sala de guerra e terminais', () => {
  const a = (id: string, patch: Partial<Agent> = {}): Agent =>
    ({ id, roomId: 'r', name: id, cwd: '/', sessionId: '', status: 'idle', activity: '', subagents: 0, createdAt: 0, ...patch }) as Agent;
  const incident = { id: 'i1', participants: ['p2', 'p1'] } as Incident;

  it('a sala de guerra mostra os participantes e depois os terminais dela', () => {
    const agents = [a('t2', { kind: 'shell', incidentId: 'i1', createdAt: 2 }), a('p1', { incidentId: 'i1' }), a('t1', { kind: 'shell', incidentId: 'i1', createdAt: 1 }), a('p2', { incidentId: 'i1' }), a('outro', { kind: 'shell' })];
    expect(warTabs(incident, agents).map((x) => x.id)).toEqual(['p2', 'p1', 't1', 't2']);
    expect(warTabs(undefined, agents)).toEqual([]);
  });

  it('o terminal da sala de guerra não aparece nas abas da sala do projeto onde abriu', () => {
    const agents = [a('p1', { incidentId: 'i1' }), a('t1', { kind: 'shell', incidentId: 'i1' }), a('t0', { kind: 'shell' })];
    // O agente chamado continua nas abas da sala dele; o terminal da guerra, não.
    expect(roomTabs(agents, 'r').map((x) => x.id)).toEqual(['p1', 't0']);
  });
});

describe('explorador de arquivos', () => {
  it('monta e desmonta caminhos com "/"', () => {
    expect(childPath('', 'a.ts')).toBe('a.ts');
    expect(childPath('src/util', 'a.ts')).toBe('src/util/a.ts');
    expect(parentPath('src/util/a.ts')).toBe('src/util');
    expect(parentPath('a.ts')).toBe('');
  });

  it('recusa nomes que viram caminho ou que o Windows não aceita', () => {
    expect(fileNameError('app.ts')).toBeUndefined();
    expect(fileNameError('  ')).toMatch(/Digite/);
    expect(fileNameError('a/b')).toMatch(/"\/"/);
    expect(fileNameError('..')).toBeDefined();
    expect(fileNameError('.GIT')).toMatch(/\.git/);
    expect(fileNameError('a:b')).toMatch(/Windows/);
  });

  it('o arquivo aberto acompanha a renomeação dele ou de uma pasta acima', () => {
    expect(renamedPath('src/a.ts', 'src/a.ts', 'src/b.ts')).toBe('src/b.ts');
    expect(renamedPath('src/util/a.ts', 'src', 'lib')).toBe('lib/util/a.ts');
    expect(renamedPath('srcx/a.ts', 'src', 'lib')).toBeUndefined();
    expect(removedWith('src/a.ts', 'src')).toBe(true);
    expect(removedWith('srcx/a.ts', 'src')).toBe(false);
  });

  it('marca os arquivos alterados e as pastas que os contêm', () => {
    const marks = treeMarks([
      { path: 'src/util/a.ts', status: 'M' },
      { path: 'novo.txt', status: '??' },
      { path: 'src/b.ts', status: 'A' },
    ]);
    expect(Object.fromEntries(marks)).toEqual({ 'src/util/a.ts': 'M', 'src/util': '•', src: '•', 'novo.txt': '?', 'src/b.ts': 'A' });
  });
});

describe('desfazer no editor', () => {
  const st = (patch: Partial<Parameters<typeof editorButtons>[0]> = {}) =>
    editorButtons({ readOnly: false, dirty: false, head: 'equal', showingChanges: false, ...patch });

  it('compara o editor com o último commit', () => {
    expect(headState('a', 'a')).toBe('equal');
    expect(headState('a', 'b')).toBe('differs');
    expect(headState('a', undefined)).toBe('new');
    expect(headState('a', null)).toBe('unknown');
  });

  it('regressão: o fim de linha não conta (\\r\\n do git do Windows contra \\n do arquivo)', () => {
    expect(headState('a\nb\n', 'a\r\nb\r\n')).toBe('equal');
    expect(headState('a\r\nb\r\n', 'a\nb\n')).toBe('equal');
    expect(headState('a\nc\n', 'a\r\nb\r\n')).toBe('differs');
  });

  it('desfazer edição só com algo por salvar; desfazer alterações só com diferença do commit', () => {
    expect(st()).toEqual({ save: true, undoEdit: false, changes: false, restore: false });
    expect(st({ dirty: true })).toMatchObject({ undoEdit: true, restore: false });
    expect(st({ head: 'differs' })).toMatchObject({ changes: true, restore: true });
    // Arquivo novo ou pasta sem git: não há commit para onde voltar.
    expect(st({ head: 'new', dirty: true })).toMatchObject({ undoEdit: true, changes: false, restore: false });
    expect(st({ head: 'unknown' })).toMatchObject({ changes: false, restore: false });
    // Desfez tudo na tela de alterações: o botão fica, para voltar ao editor.
    expect(st({ head: 'equal', showingChanges: true })).toMatchObject({ changes: true, restore: false });
  });

  it('arquivo de outra branch é só leitura: nenhum botão', () => {
    expect(st({ readOnly: true, dirty: true, head: 'differs' })).toEqual({ save: false, undoEdit: false, changes: false, restore: false });
  });
});

describe('seções do painel de git', () => {
  it('arquivos começam abertos e os últimos commits fechados; depois vale o que você escolheu', () => {
    expect(gitSectionOpen({}, 'working')).toBe(true);
    expect(gitSectionOpen({}, 'commits')).toBe(false);
    expect(gitSectionOpen({ working: false, commits: true }, 'working')).toBe(false);
    expect(gitSectionOpen({ working: false, commits: true }, 'commits')).toBe(true);
  });
});
