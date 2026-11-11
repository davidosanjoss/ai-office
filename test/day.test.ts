import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dayBounds, hoursMinutes, projectDigest, summarizeDay } from '../shared/day.ts';
import { DEFAULT_PRICES } from '../shared/usage.ts';
import type { Room } from '../shared/types.ts';
import { todosFrom } from '../server/hooks.ts';
import { dayPrompts } from '../server/day.ts';
import { tempDir } from './helpers.ts';

const room = { id: 'r1', name: 'SAFF', path: '/saff', createdAt: 1, projects: [{ id: 'a', name: 'arquivos', path: '/saff/a', summary: '' }, { id: 's', name: 'sales', path: '/saff/s', summary: '' }] } as Room;
const date = '2026-11-11';
const { from } = dayBounds(date);
const h = (n: number) => from + n * 3600_000;

describe('meu dia', () => {
  it('soma o tempo de agente por projeto e por hora, e acha as esperas mais longas', () => {
    const r = summarizeDay({
      date,
      intervals: [
        { agentId: '1', agent: 'Ana', roomId: 'r1', projectId: 's', status: 'working', from: h(9), to: h(10.5) },
        { agentId: '1', agent: 'Ana', roomId: 'r1', projectId: 's', status: 'waiting', from: h(10.5), to: h(11) },
        { agentId: '2', agent: 'Bia', roomId: 'r1', projectId: 'a', status: 'done', from: h(14), to: h(14.25) },
        // Começou no dia anterior: só conta a parte deste dia.
        { agentId: '3', agent: 'Caio', roomId: 'r1', projectId: 'a', status: 'working', from: h(-1), to: h(1) },
      ],
      events: [{ event: '🎉 PR #12 aberto!', roomId: 'r1', at: h(11) }],
      prompts: [{ cwd: '/saff/s/src', text: 'arruma o layout', at: h(9) }],
      commits: { 'p:s': [{ hash: 'abc', subject: 'Layout novo', at: h(10) }] },
      records: [],
      locate: (cwd) => (cwd.startsWith('/saff/s') ? { key: 'p:s', label: 'SAFF · sales', roomId: 'r1', projectId: 's' } : { key: `fora:${cwd}`, label: cwd }),
      rooms: [room],
      prices: DEFAULT_PRICES,
      now: h(20),
    });
    const sales = r.projects.find((p) => p.place.key === 'p:s')!;
    expect(sales).toMatchObject({ workMs: 1.5 * 3600_000, waitMs: 0.5 * 3600_000, agents: ['Ana'] });
    expect(sales.prompts.map((p) => p.text)).toEqual(['arruma o layout']);
    expect(sales.commits[0].subject).toBe('Layout novo');
    expect(r.projects.find((p) => p.place.key === 'p:a')!.workMs).toBe(3600_000);
    expect(r.totals).toMatchObject({ workMs: 2.5 * 3600_000, waitMs: 0.5 * 3600_000, doneMs: 0.25 * 3600_000, prompts: 1, commits: 1 });
    expect(r.byHour[9].work).toBe(60);
    expect(r.byHour[10]).toEqual({ work: 30, wait: 30 });
    expect(r.longestWaits[0]).toMatchObject({ agent: 'Ana', ms: 0.5 * 3600_000, status: 'waiting' });
    expect(r.projects.find((p) => p.place.key === 'r:r1')?.events[0].text).toBe('🎉 PR #12 aberto!');
    expect(projectDigest(sales)).toBe('Projeto: SAFF · sales\nPedidos:\n- arruma o layout\nCommits:\n- Layout novo');
  });

  it('formata o tempo', () => {
    expect([hoursMinutes(0), hoursMinutes(45 * 60_000), hoursMinutes(135 * 60_000)]).toEqual(['—', '45 min', '2 h 15']);
  });

  it('pedidos do dia: só as suas mensagens, sem notificações, mensagens do sistema nem as de outro dia', () => {
    const root = tempDir('dia-transcripts');
    const dir = path.join(root, '-saff');
    fs.mkdirSync(dir);
    const u = (content: unknown, at: number, extra: object = {}) => JSON.stringify({ type: 'user', cwd: '/saff/s', timestamp: new Date(at).toISOString(), message: { role: 'user', content }, ...extra });
    fs.writeFileSync(
      path.join(dir, 's.jsonl'),
      [
        u('arruma o layout', h(9)),
        u('<task-notification>x</task-notification>', h(9.5)),
        u([{ type: 'tool_result', content: 'ok' }], h(9.6)),
        u('meta', h(9.7), { isMeta: true }),
        u('de ontem', h(-2)),
        u('um aviso do sistema', h(10), { promptSource: 'system' }),
        u('This session is being continued from a previous conversation that ran out of context.', h(10.1)),
        u('resumo compactado', h(10.2), { isCompactSummary: true }),
      ].join('\n') + '\n',
    );
    expect(dayPrompts(date, root).map((p) => p.text)).toEqual(['arruma o layout']);
  });
});

describe('tarefas do agente', () => {
  it('o TodoWrite manda a lista inteira; TaskCreate e TaskUpdate mexem uma de cada vez', () => {
    const list = todosFrom('TodoWrite', { todos: [{ content: 'Ler', status: 'completed' }, { content: 'Testar', status: 'in_progress', activeForm: 'Testando' }, { content: '' }] });
    expect(list.todos).toEqual([{ content: 'Ler', status: 'completed' }, { content: 'Testar', status: 'in_progress', activeForm: 'Testando' }]);
    const created = todosFrom('TaskCreate', { subject: 'Deploy' }, list.todos);
    expect(created.todos!.at(-1)).toEqual({ content: 'Deploy', status: 'pending' });
    expect(todosFrom('TaskUpdate', { subject: 'Deploy', status: 'completed' }, created.todos).todos!.at(-1)!.status).toBe('completed');
    expect(todosFrom('Read', {}, list.todos)).toEqual({});
  });
});
