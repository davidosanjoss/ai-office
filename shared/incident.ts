// Regras da sala de guerra que não dependem do servidor: quem uma mensagem chama, o que é
// digitado no terminal de cada agente e o registro em markdown. Usado pelo servidor e testado sem processos.

import type { Incident, IncidentMessage } from './types.ts';

/** Quem está na sala, do jeito que as mensagens precisam: nome do agente e projeto de origem. */
export interface Participant {
  id: string;
  name: string;
  project: string;
}

/** "Vitória Souza" → "vitoria-souza": o que vem depois do @ numa menção. */
export function mentionKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

/**
 * Destino de uma mensagem sua: `@nome` ou `@projeto` manda só para eles; sem menção, para todos.
 * Menções que não batem com ninguém voltam em `unknown`, para avisar em vez de mandar errado.
 */
export function parseMentions(text: string, people: Participant[]): { to: string[]; unknown: string[] } {
  const to = new Set<string>();
  const unknown: string[] = [];
  for (const m of text.matchAll(/(^|\s)@([\p{L}\p{N}._-]+)/gu)) {
    const key = mentionKey(m[2]).replace(/[.,;:!?]+$/, '');
    const hits = people.filter((p) => mentionKey(p.name) === key || mentionKey(p.project) === key);
    if (hits.length) for (const p of hits) to.add(p.id);
    else unknown.push(m[2]);
  }
  return { to: people.filter((p) => to.has(p.id)).map((p) => p.id), unknown };
}

const who = (p: Participant) => `${p.name} (projeto ${p.project})`;

/** Tamanho máximo do que é digitado no terminal de um agente; o resto fica no registro. */
export const MAX_TYPED = 1500;

/**
 * Tudo que vai para o terminal de um agente é UMA linha: uma quebra de linha digitada viraria
 * Enter (principalmente no Windows). O texto completo fica no registro do incidente.
 */
export function oneLine(text: string, max = MAX_TYPED): string {
  const flat = text.replace(/\s*\n\s*/g, ' / ').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}… (íntegra no registro)` : flat;
}

/** O convite que cada agente recebe ao entrar. O briefing (problema, regras, quem está) fica no registro. */
export function invitation(incident: Pick<Incident, 'title' | 'file'>, me: Participant): string {
  return oneLine(
    `[Sala de guerra] Você é ${who(me)} e foi chamado para investigar o incidente "${incident.title}" junto com agentes de outros projetos. ` +
      `Leia o registro em ${incident.file} (descrição, regras e quem está na sala) e comece a investigar no seu repositório.`,
  );
}

/** Sua mensagem, como chega no terminal de cada agente. */
export function userMessage(text: string, toAll: boolean): string {
  return oneLine(`[Sala de guerra] Mensagem do usuário${toAll ? ' para todos' : ' só para você'}: ${text}`);
}

/** A resposta de um agente repassada aos outros (só quando você clica em "compartilhar"). */
export function sharedMessage(from: Participant, text: string): string {
  const tail = ' Comente só se isso muda algo na sua investigação.';
  return `${oneLine(`[Sala de guerra] ${who(from)} disse: ${text}`, MAX_TYPED - tail.length)}${tail}`;
}

/** Regras da sala, no topo do registro. */
export const RULES = [
  'Investigue no seu repositório e traga hipóteses, evidências (arquivo e linha) e o que dá e o que não dá para fazer do seu lado.',
  'Modo investigação: não altere código nem rode comandos que mudem algo sem o OK explícito do usuário.',
  'Seja direto: sua resposta vai para o chat da sala de guerra, que o usuário lê junto com a dos outros.',
  'Mensagens que começam com [Sala de guerra] vêm do usuário ou são respostas de outros agentes que ele repassou. A íntegra de tudo está na linha do tempo abaixo.',
];

/** Registro do incidente em markdown: cabeçalho, participantes e a linha do tempo do chat. */
export function recordMarkdown(incident: Incident, people: Participant[], closed?: { at: number; resolution: string }): string {
  const name = (id?: string) => people.find((p) => p.id === id)?.name ?? 'agente que saiu';
  const time = (ts: number) => new Date(ts).toLocaleString('pt-BR');
  const line = (m: IncidentMessage) => {
    const to = m.to.length ? ` → ${m.to.map(name).join(', ')}` : '';
    const head = { voce: `Você${to}`, agente: name(m.agentId), repasse: `Repasse de ${name(m.agentId)}`, sistema: 'Sala' }[m.kind];
    return `### ${time(m.ts)} · ${head}\n\n${m.text.trim()}\n`;
  };
  return [
    `# Incidente: ${incident.title}`,
    ``,
    `- Aberto em: ${time(incident.createdAt)}`,
    closed ? `- Encerrado em: ${time(closed.at)}` : `- Situação: em andamento`,
    `- Participantes: ${people.map(who).join(', ') || 'ninguém'}`,
    ``,
    `## Descrição`,
    ``,
    incident.description || '(sem descrição)',
    ``,
    `## Regras para os agentes`,
    ``,
    ...RULES.map((r) => `- ${r}`),
    ``,
    `## Linha do tempo`,
    ``,
    ...incident.messages.map(line),
    ...(closed ? [`## Post-mortem`, ``, closed.resolution || '(sem resolução registrada)', ``] : []),
  ].join('\n');
}
