import { describe, expect, it } from 'vitest';
import { ALARM_MS, PARTY_MS, elapsed, finishedShells, githubEvent, roomEffectFor, shellStage } from '../shared/live.ts';
import type { Agent } from '../shared/types.ts';
import { roomLight, shellBubble } from '../web/logic.ts';

describe('eventos do GitHub', () => {
  it('PR aberto e mergeado, release, push', () => {
    expect(githubEvent('gh pr create --fill', 'https://github.com/org/app/pull/12\n')).toEqual({ kind: 'pr-aberto', text: 'PR #12 aberto!' });
    expect(githubEvent('gh pr merge 12 --squash', '✓ Squashed and merged pull request #12')).toEqual({ kind: 'pr-merge', text: 'PR #12 mergeado!' });
    expect(githubEvent('gh release create v1.2.0 --notes x', 'https://github.com/org/app/releases/tag/v1.2.0')).toEqual({ kind: 'release', text: 'Release v1.2.0 publicada!' });
    expect(githubEvent('git push -u origin feat/x', 'branch set up to track')).toEqual({ kind: 'push', text: 'Push feito' });
  });

  it('o que falhou não vira festa', () => {
    expect(githubEvent('gh pr create --fill', 'pull request create failed: GraphQL error')).toBeUndefined();
    expect(githubEvent('git push', 'fatal: could not read from remote')).toBeUndefined();
  });

  it('CI: vermelho, verde (o resumo do verde também diz "0 failing") e ainda rodando', () => {
    expect(githubEvent('gh run watch 99 --exit-status', "X CI (99) completed with 'failure'")?.kind).toBe('ci-falhou');
    expect(githubEvent('gh pr checks 12', 'Some checks were not successful\n1 failing, 3 successful')?.kind).toBe('ci-falhou');
    expect(githubEvent('gh pr checks 12', 'All checks were successful\n0 cancelled, 0 failing, 5 successful')?.kind).toBe('ci-ok');
    expect(githubEvent('gh run watch 99', "✓ CI (99) completed with 'success'")?.kind).toBe('ci-ok');
    expect(githubEvent('gh run view 99', '* in progress')).toBeUndefined();
  });

  it('festa por 12 s, alarme por 10 min; push só na atividade', () => {
    expect(roomEffectFor({ kind: 'pr-aberto', text: 'x' }, 0)).toEqual({ kind: 'festa', text: 'x', until: PARTY_MS });
    expect(roomEffectFor({ kind: 'ci-falhou', text: 'y' }, 0)).toEqual({ kind: 'alarme', text: 'y', until: ALARM_MS });
    expect(roomEffectFor({ kind: 'push', text: 'z' }, 0)).toBeUndefined();
  });
});

describe('esperando o shell', () => {
  it('lê o fim dos comandos no transcript (status e código de saída), uma vez cada', () => {
    const note = (id: string, status: string, code: number) =>
      JSON.stringify({ type: 'queue-operation', content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>Background command "x" ${status} (exit code ${code})</summary>\n</task-notification>` });
    const chunk = [note('a1', 'completed', 0), note('b2', 'failed', 1), note('a1', 'completed', 0), '{"type":"assistant"}'].join('\n');
    expect(finishedShells(chunk)).toEqual([{ id: 'a1', ok: true, code: 0 }, { id: 'b2', ok: false, code: 1 }]);
  });

  it('fases da espera e tempo decorrido', () => {
    expect([0, 3, 10, 25].map((m) => shellStage(m * 60_000).icon)).toEqual(['🍿', '😒', '🕸️', '💤']);
    expect([elapsed(20_000), elapsed(5 * 60_000), elapsed(65 * 60_000)]).toEqual(['agora', '5 min', '1 h 05']);
  });

  it('balão: o último comando, quantos mais e a fase', () => {
    const a = { status: 'idle', shells: [{ id: 'x', command: 'build', since: 0 }, { id: 'y', command: 'npm test', since: 0 }] } as unknown as Agent;
    expect(shellBubble(a, 4 * 60_000)).toEqual({ short: '😒 4 min', long: 'Esperando o shell: npm test (+1) · 4 min · de braços cruzados' });
    expect(shellBubble({ ...a, status: 'exited' } as Agent, 0)).toBeUndefined();
  });
});

describe('luz da sala', () => {
  const ag = (status: Agent['status']) => ({ status }) as Agent;
  it('apagada sem ninguém ativo; de noite, luz quente', () => {
    expect(roomLight([], 12)).toBe('apagada');
    expect(roomLight([ag('exited')], 12)).toBe('apagada');
    expect(roomLight([ag('idle')], 12)).toBe('dia');
    expect(roomLight([ag('working')], 21)).toBe('noite');
    expect(roomLight([ag('working')], 5)).toBe('noite');
  });
});
