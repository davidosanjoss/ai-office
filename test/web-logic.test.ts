import { describe, expect, it } from 'vitest';
import type { Agent } from '../shared/types.ts';
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
