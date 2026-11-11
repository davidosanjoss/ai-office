import { describe, expect, it } from 'vitest';
import { alwaysLabel, hookOutput, requestFrom, requestSummary } from '../shared/permissions.ts';
import { questionAnswers } from '../web/logic.ts';

const bash = requestFrom('r1', 'a1', {
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Roda os testes' },
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }],
}, 1);
const pergunta = requestFrom('r2', 'a1', {
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Qual banco?', header: 'Banco', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] },
}, 1);

describe('pedidos respondidos pelo escritório', () => {
  it('permitir, e permitir sem perguntar de novo com as regras que o Claude Code sugeriu', () => {
    expect(hookOutput(bash, { behavior: 'allow' })).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(hookOutput(bash, { behavior: 'allow', always: true })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: bash.suggestions } },
    });
    expect(alwaysLabel(bash)).toBe('Permitir e não perguntar de novo (Bash(npm test))');
  });

  it('negar leva o motivo para o agente e pode interromper', () => {
    expect(hookOutput(bash, { behavior: 'deny', message: ' use o pnpm ', interrupt: true })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'use o pnpm', interrupt: true } },
    });
    expect(hookOutput(bash, { behavior: 'deny' })).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } });
  });

  it('pergunta: devolve as perguntas com as respostas (o Claude Code exige updatedInput)', () => {
    expect(pergunta.kind).toBe('question');
    expect(hookOutput(pergunta, { behavior: 'allow', answers: { 'Qual banco?': 'SQLite' } })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...pergunta.toolInput, answers: { 'Qual banco?': 'SQLite' } } } },
    });
    expect(requestSummary(pergunta)).toBe('Pergunta: Qual banco?');
  });

  it('aprovar o plano também devolve a entrada', () => {
    const plano = requestFrom('r3', 'a1', { tool_name: 'ExitPlanMode', tool_input: { plan: '1. fazer' } }, 1);
    expect(hookOutput(plano, { behavior: 'allow' })).toMatchObject({ hookSpecificOutput: { decision: { updatedInput: { plan: '1. fazer' } } } });
  });

  it('respostas das perguntas: opção, várias opções e "Outra"', () => {
    const qs = [
      { question: 'A?', options: [{ label: 'x' }, { label: 'y' }] },
      { question: 'B?', options: [{ label: 'm' }, { label: 'n' }], multiSelect: true },
      { question: 'C?', options: [{ label: 'p' }] },
    ];
    expect(questionAnswers(qs, { 'A?': ['y'], 'B?': ['m', 'n'], 'C?': [] }, { 'C?': ' outra coisa ' })).toEqual({ 'A?': 'y', 'B?': 'm, n', 'C?': 'outra coisa' });
    expect(questionAnswers(qs, { 'A?': [] }, {})).toEqual({});
  });
});
