import { describe, expect, it } from 'vitest';
import { MAX_TYPED, type Participant, applyMention, invitation, mentionQuery, mentionSuggestions, oneLine, parseMentions, recordMarkdown, sharedMessage, userMessage } from '../shared/incident.ts';
import type { Incident } from '../shared/types.ts';
import { lastAssistantText } from '../server/incidents.ts';

const people: Participant[] = [
  { id: 'a', name: 'Vitória', project: 'gateway' },
  { id: 'b', name: 'Bruno', project: 'filas' },
  { id: 'c', name: 'Ana 2', project: 'filas' },
];

describe('menções no chat da sala de guerra', () => {
  it('sem @, a mensagem vai para todos', () => {
    expect(parseMentions('alguém viu o 503?', people)).toEqual({ to: [], unknown: [] });
  });

  it('@nome chama o agente, sem ligar para acento e maiúscula', () => {
    expect(parseMentions('@vitoria olha o timeout', people).to).toEqual(['a']);
    expect(parseMentions('@VITÓRIA, olha', people).to).toEqual(['a']);
  });

  it('@projeto chama todos os agentes daquele projeto', () => {
    expect(parseMentions('@filas a fila encheu?', people).to).toEqual(['b', 'c']);
  });

  it('nome com espaço vira hífen na menção', () => {
    expect(parseMentions('@ana-2 e @bruno', people).to).toEqual(['b', 'c']);
  });

  it('menção a quem não está na sala volta como desconhecida, para avisar', () => {
    expect(parseMentions('@carlos vê isso', people)).toEqual({ to: [], unknown: ['carlos'] });
  });

  it('e-mail no meio do texto não é menção', () => {
    expect(parseMentions('mande para fulano@empresa.com', people)).toEqual({ to: [], unknown: [] });
  });
});

describe('o que é digitado no terminal dos agentes', () => {
  it('é sempre uma linha só: quebra de linha viraria Enter', () => {
    expect(oneLine('linha 1\nlinha 2\r\n\n  linha 3')).toBe('linha 1 / linha 2 / linha 3');
  });

  it('não leva caracteres de controle (ESC, Ctrl+C) para o terminal', () => {
    expect(oneLine('a\x1b[31mb\x03c')).toBe('a [31mb c');
  });

  it('texto grande é cortado, e o resto fica no registro', () => {
    const typed = oneLine('x'.repeat(5000));
    expect(typed.length).toBeLessThan(MAX_TYPED + 40);
    expect(typed).toContain('íntegra no registro');
  });

  it('o convite diz quem o agente é e onde está o registro com o briefing', () => {
    const text = invitation({ title: '503 na API', file: '/dados/incidentes/x.md' }, people[0]);
    expect(text).not.toContain('\n');
    expect(text).toContain('Vitória (projeto gateway)');
    expect(text).toContain('"503 na API"');
    expect(text).toContain('/dados/incidentes/x.md');
  });

  it('sua mensagem e o repasse dizem de onde vieram', () => {
    expect(userMessage('oi\ntudo bem?', true)).toBe('[Sala de guerra] Mensagem do usuário para todos: oi / tudo bem?');
    expect(userMessage('oi', false)).toContain('só para você');
    const shared = sharedMessage(people[1], 'a fila está cheia\ndesde 10h');
    expect(shared).toMatch(/^\[Sala de guerra\] Bruno \(projeto filas\) disse: a fila está cheia \/ desde 10h/);
    expect(shared).not.toContain('\n');
  });
});

describe('registro do incidente', () => {
  const incident: Incident = {
    id: 'i1',
    floorId: 'f',
    slot: 0,
    title: '503 na API',
    description: 'Pedidos falhando desde 10h',
    createdAt: 0,
    participants: ['a', 'b'],
    messages: [
      { id: 1, ts: 0, kind: 'voce', to: ['b'], text: 'a fila encheu?' },
      { id: 2, ts: 0, kind: 'agente', agentId: 'b', to: [], text: 'Sim, 10 mil mensagens' },
    ],
    file: '/x.md',
  };

  it('tem descrição, regras, participantes e a linha do tempo com quem falou', () => {
    const md = recordMarkdown(incident, people);
    expect(md).toContain('# Incidente: 503 na API');
    expect(md).toContain('Pedidos falhando desde 10h');
    expect(md).toContain('Modo investigação');
    expect(md).toContain('Vitória (projeto gateway)');
    expect(md).toContain('Você → Bruno');
    expect(md).toContain('Sim, 10 mil mensagens');
    expect(md).toContain('em andamento');
    expect(md).not.toContain('Post-mortem');
  });

  it('ao encerrar, ganha o post-mortem', () => {
    const md = recordMarkdown(incident, people, { at: 0, resolution: 'Aumentamos os consumidores da fila' });
    expect(md).toContain('## Post-mortem');
    expect(md).toContain('Aumentamos os consumidores da fila');
    expect(md).not.toContain('em andamento');
  });
});

describe('resposta do agente lida do transcript', () => {
  const line = (type: string, content: unknown) => JSON.stringify({ type, message: { role: type, content } });

  it('pega o texto final, depois da última ferramenta, sem as falas intermediárias', () => {
    const jsonl = [
      line('user', 'investigue o 503'),
      line('assistant', [{ type: 'text', text: 'Vou ler o gateway.' }]),
      line('assistant', [{ type: 'tool_use', id: 't', name: 'Read', input: {} }]),
      line('user', [{ type: 'tool_result', tool_use_id: 't', content: '...' }]),
      line('assistant', [{ type: 'text', text: 'O timeout é 5s.' }]),
      line('assistant', [{ type: 'text', text: 'A fila demora 8s.' }]),
      '',
    ].join('\n');
    expect(lastAssistantText(jsonl)).toBe('O timeout é 5s.\n\nA fila demora 8s.');
  });

  it('resposta sem ferramentas, até o pedido do usuário', () => {
    const jsonl = [line('user', 'antes'), line('assistant', [{ type: 'text', text: 'velha' }]), line('user', 'oi'), line('assistant', 'Olá!')].join('\n');
    expect(lastAssistantText(jsonl)).toBe('Olá!');
  });

  it('linhas quebradas ou de outros tipos não atrapalham', () => {
    const jsonl = ['{quebrada', JSON.stringify({ type: 'summary' }), line('assistant', [{ type: 'text', text: 'ok' }]), '{"type":"assis'].join('\n');
    expect(lastAssistantText(jsonl)).toBe('ok');
  });
});

describe('auto-complete das menções no chat', () => {
  it('acha a menção no cursor, e não no meio de um e-mail', () => {
    expect(mentionQuery('oi @vit', 7)).toEqual({ start: 3, query: 'vit' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('fulano@emp', 10)).toBeUndefined();
    expect(mentionQuery('@vit olha', 9)).toBeUndefined();
  });

  it('sugere agentes e projetos com a chave que o servidor aceita, sem ligar para acento', () => {
    const all = mentionSuggestions(people, '');
    expect(all.map((s) => s.key)).toEqual(['ana-2', 'bruno', 'vitoria', 'filas', 'gateway']);
    expect(all.find((s) => s.key === 'filas')).toEqual({ key: 'filas', label: 'filas', hint: 'projeto · 2 agentes' });
    expect(mentionSuggestions(people, 'VIT').map((s) => s.label)).toEqual(['Vitória']);
    // Quem começa com o texto vem antes de quem só contém.
    expect(mentionSuggestions(people, 'a').map((s) => s.key)).toEqual(['ana-2', 'vitoria', 'filas', 'gateway']);
    // Toda sugestão é uma menção válida.
    for (const s of all) expect(parseMentions(`@${s.key}`, people).unknown).toEqual([]);
  });

  it('agente com o nome do projeto aparece uma vez só', () => {
    expect(mentionSuggestions([{ id: 'x', name: 'Filas', project: 'filas' }], '').map((s) => s.key)).toEqual(['filas']);
  });

  it('completar troca o que foi digitado e põe o cursor depois do espaço', () => {
    expect(applyMention('oi @vi tudo bem', 3, 6, 'vitoria')).toEqual({ text: 'oi @vitoria tudo bem', caret: 12 });
    expect(applyMention('@fi', 0, 3, 'filas')).toEqual({ text: '@filas ', caret: 7 });
  });
});
