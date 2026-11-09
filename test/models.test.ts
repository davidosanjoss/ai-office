import { describe, expect, it } from 'vitest';
import { modelLaunch, modelsLabel, parseModels, validModelName } from '../shared/models.ts';

describe('modelos por projeto', () => {
  it('um modelo vira --model', () => {
    expect(modelLaunch({ mode: 'unico', model: 'sonnet' })).toEqual({ args: ['--model', 'sonnet'], env: {} });
  });

  it('raciocínio + execução usa o opusplan, trocando o que "opus" e "sonnet" querem dizer', () => {
    expect(modelLaunch({ mode: 'duplo', reasoning: 'claude-opus-5-5', execution: 'claude-haiku-5-5' })).toEqual({
      args: ['--model', 'opusplan'],
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-haiku-5-5' },
    });
  });

  it('sem escolha, o padrão da conta: nenhum argumento', () => {
    expect(modelLaunch(undefined)).toEqual({ args: [], env: {} });
    expect(modelsLabel(undefined)).toBe('padrão da conta');
    expect(modelsLabel({ mode: 'duplo', reasoning: 'opus', execution: 'sonnet' })).toBe('opus → sonnet');
  });

  it('o nome do modelo vira argumento: nada que o shell interprete', () => {
    for (const ok of ['opus', 'sonnet[1m]', 'claude-opus-5-5', 'gpt_x.1']) expect(validModelName(ok)).toBe(true);
    for (const bad of ['opus; rm -rf ~', 'a b', '$(x)', '"opus"', 'a&b', '', 'x'.repeat(81)]) expect(validModelName(bad)).toBe(false);
    expect(modelLaunch({ mode: 'unico', model: 'opus & calc' })).toEqual({ args: [], env: {} });
  });

  it('o que vem da rede: vazio volta ao padrão; incompleto ou estranho é recusado', () => {
    expect(parseModels(null)).toBeUndefined();
    expect(parseModels({ mode: 'unico', model: '  ' })).toBeUndefined();
    expect(parseModels({ mode: 'unico', model: ' opus ' })).toEqual({ mode: 'unico', model: 'opus' });
    expect(parseModels({ mode: 'duplo', reasoning: 'opus' })).toBeNull();
    expect(parseModels({ mode: 'duplo', reasoning: 'opus', execution: 'x|y' })).toBeNull();
    expect(parseModels({ mode: 'outro' })).toBeNull();
    expect(parseModels('opus')).toBeNull();
  });
});
