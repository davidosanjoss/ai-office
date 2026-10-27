import { describe, expect, it } from 'vitest';
import type { Agent, Floor, Incident, IncidentMessage, Room } from '../shared/types.ts';
import {
  IDLE_RELEASE_MS,
  TYPING_GRACE_MS,
  attentionQueue,
  becameAttention,
  exitedMessage,
  nextAutoFocus,
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
