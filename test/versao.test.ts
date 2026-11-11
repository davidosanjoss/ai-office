import { describe, expect, it } from 'vitest';
// @ts-expect-error: script em JavaScript, sem tipos
import { bumpOf, latestTag, nextVersion, parseTag } from '../scripts/versao.mjs';

describe('versão das releases', () => {
  it('lê as tags, inclusive as antigas de dois números', () => {
    expect(parseTag('v0.2')).toEqual([0, 2, 0]);
    expect(parseTag('v1.10.3')).toEqual([1, 10, 3]);
    expect(parseTag('nightly')).toBeUndefined();
    expect(latestTag(['v0.1', 'v0.2', 'v0.10.0', 'v0.9.4', 'teste'])).toBe('v0.10.0');
    expect(latestTag([])).toBeUndefined();
  });

  it('feat sobe a do meio; o resto, a última; o rótulo versão-maior, a primeira', () => {
    expect(bumpOf({ branch: 'feat/consumo' })).toBe('minor');
    expect(bumpOf({ branch: 'fix/colar' })).toBe('patch');
    expect(bumpOf({ branch: 'infra/ai-memory' })).toBe('patch');
    expect(bumpOf({ branch: 'fix/x', labels: ['versão-maior'] })).toBe('major');
  });

  it('o maior salto entre os PRs que entraram vence', () => {
    expect(nextVersion('v0.2', [{ branch: 'fix/a' }])).toBe('v0.2.1');
    expect(nextVersion('v0.2.1', [{ branch: 'fix/a' }, { branch: 'feat/b' }])).toBe('v0.3.0');
    expect(nextVersion('v0.3.0', [{ branch: 'feat/b', labels: ['versão-maior'] }])).toBe('v1.0.0');
    expect(nextVersion(undefined, [{ branch: 'feat/a' }])).toBe('v0.1.0');
  });
});

describe('versão em uso no escritório', () => {
  it('do git describe para o texto curto da barra', async () => {
    const { fromDescribe } = await import('../server/version.ts');
    expect(fromDescribe('v0.19.0')).toBe('v0.19.0');
    expect(fromDescribe('v0.19.0-3-gabc1234')).toBe('v0.19.0+3');
    expect(fromDescribe('v0.19.0-3-gabc1234-dirty')).toBe('v0.19.0+3*');
    expect(fromDescribe('v0.2')).toBe('v0.2');
  });

  it('lê a versão de um repositório com tag', async () => {
    const { execFileSync } = await import('node:child_process');
    const { makeRepo } = await import('./helpers.ts');
    const { officeVersion } = await import('../server/version.ts');
    const repo = makeRepo('versao');
    execFileSync('git', ['-C', repo, 'tag', 'v1.2.3']);
    expect(officeVersion(repo)).toMatchObject({ version: 'v1.2.3', branch: 'main' });
  });
});
