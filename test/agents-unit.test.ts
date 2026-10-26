import { afterEach, describe, expect, it } from 'vitest';
import { claudeArgs, cleanEnv, lastLine, slugify } from '../server/agents.ts';

describe('claudeArgs', () => {
  it('sessão nova fixa o ID com --session-id', () => {
    expect(claudeArgs('abc', false, '/s.json')).toEqual(['--settings', '/s.json', '--session-id', 'abc']);
  });

  it('retomada usa --resume com o mesmo ID', () => {
    expect(claudeArgs('abc', true, '/s.json')).toEqual(['--settings', '/s.json', '--resume', 'abc']);
  });

  it('regressão: os hooks entram sempre por --settings, sem mexer no ~/.claude/settings.json', () => {
    for (const resume of [false, true]) expect(claudeArgs('x', resume).slice(0, 1)).toEqual(['--settings']);
  });
});

describe('lastLine', () => {
  it('regressão: extrai a mensagem de erro do --resume no meio dos códigos do terminal', () => {
    // Saída real do Claude Code ao retomar uma sessão que não foi salva.
    const real = '\x1b7\x1b8\x1b[<uNo conversation found with session ID: b203\x1b(B\x1b[<u\x1b7\x1b8';
    expect(lastLine(real)).toBe('No conversation found with session ID: b203');
  });

  it('ignora cores e linhas vazias', () => {
    expect(lastLine('primeira\r\n\x1b[31mboom: deu ruim\x1b[0m\r\n\r\n')).toBe('boom: deu ruim');
  });

  it('remove títulos de janela (OSC)', () => {
    expect(lastLine('\x1b]0;título\x07texto')).toBe('texto');
  });

  it('saída vazia vira string vazia', () => {
    expect(lastLine('\x1b[2J')).toBe('');
  });
});

describe('cleanEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('regressão: remove os marcadores de sessão do Claude que desligariam o histórico dos agentes', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    process.env.CLAUDE_CODE_SESSION_ID = 'pai';
    const env = cleanEnv();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  it('mantém as configurações do usuário (ex.: Bedrock)', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.ANTHROPIC_MODEL = 'x';
    const env = cleanEnv();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.ANTHROPIC_MODEL).toBe('x');
  });
});

describe('slugify', () => {
  it('regressão: acentos somem em vez de virar hífen ("Vitória" → "vitoria", não "vito-ria")', () => {
    expect(slugify('Vitória')).toBe('vitoria');
    expect(slugify('João Pedro')).toBe('joao-pedro');
  });

  it('nome só com símbolos vira "agente"', () => {
    expect(slugify('!!!')).toBe('agente');
  });
});
