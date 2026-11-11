// Sala viva: o que acontece com os agentes vira cena no mapa. Eventos do GitHub (PR aberto ou
// mergeado, release, CI vermelho ou verde) a partir dos comandos que o agente rodou; e os comandos
// que ele deixou rodando em segundo plano ("esperando o shell"), com o fim lido do transcript.
// Regras puras, usadas pelo servidor (que detecta) e pela interface (que desenha).

/** Efeito na sala inteira: festa (confete e faixa) ou alarme (sala avermelhada e sirene). */
export interface RoomEffect {
  kind: 'festa' | 'alarme';
  text: string;
  /** Até quando (ms). */
  until: number;
}

/** Comando que o agente deixou rodando em segundo plano. */
export interface BgShell {
  id: string;
  command: string;
  since: number;
}

/** Efeito num agente: o comando que ele esperava acabou (bem ou mal). */
export interface AgentEffect {
  kind: 'ok' | 'falhou';
  text: string;
  until: number;
}

export const PARTY_MS = 12_000;
export const ALARM_MS = 10 * 60_000;

export type GithubEvent =
  | { kind: 'pr-aberto' | 'pr-merge' | 'release' | 'ci-falhou' | 'ci-ok' | 'push'; text: string };

/**
 * O que um comando do agente fez no GitHub, pela linha de comando e pela saída. Só o que deu
 * certo conta (um `gh pr create` que falhou não vira festa).
 */
export function githubEvent(command: string, output: string): GithubEvent | undefined {
  const cmd = command.replace(/\s+/g, ' ');
  const pr = /github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/.exec(output)?.[1];
  const failed = /(^|\n)\s*(error|fatal|failed|could not|no such|não foi)/i.test(output) && !pr;
  if (/\bgh pr create\b/.test(cmd) && pr) return { kind: 'pr-aberto', text: `PR #${pr} aberto!` };
  if (/\bgh pr merge\b/.test(cmd) && !failed) {
    const n = /\bgh pr merge\s+(\d+)/.exec(cmd)?.[1] ?? /#(\d+)/.exec(output)?.[1];
    return { kind: 'pr-merge', text: n ? `PR #${n} mergeado!` : 'PR mergeado!' };
  }
  if (/\bgh release create\b/.test(cmd) && !failed) {
    const tag = /\bgh release create\s+([^\s-][^\s]*)/.exec(cmd)?.[1];
    return { kind: 'release', text: tag ? `Release ${tag} publicada!` : 'Release publicada!' };
  }
  if (/\bgh (run (watch|view)|pr checks)\b/.test(cmd)) {
    // Verde primeiro: o resumo do sucesso também fala em "0 failing".
    if (/completed with 'success'|All checks were successful/i.test(output)) return { kind: 'ci-ok', text: 'CI verde!' };
    if (/completed with '(failure|cancelled|timed_out)'|(^|\n)\s*X\s|\bfail(ed|ure)?\b|Some checks were not successful/i.test(output)) return { kind: 'ci-falhou', text: 'CI falhou' };
    return undefined;
  }
  if (/\bgit push\b/.test(cmd) && !failed) return { kind: 'push', text: 'Push feito' };
  return undefined;
}

/** O efeito da sala para um evento do GitHub (o push só vai para a atividade). */
export function roomEffectFor(ev: GithubEvent, now: number): RoomEffect | undefined {
  if (ev.kind === 'push') return undefined;
  if (ev.kind === 'ci-falhou') return { kind: 'alarme', text: ev.text, until: now + ALARM_MS };
  return { kind: 'festa', text: ev.text, until: now + PARTY_MS };
}

/**
 * Fins de comandos em segundo plano num pedaço de transcript: o Claude Code grava um
 * <task-notification> com o id, o status e, no resumo, o código de saída.
 */
export function finishedShells(chunk: string): { id: string; ok: boolean; code?: number }[] {
  const out: { id: string; ok: boolean; code?: number }[] = [];
  for (const line of chunk.split('\n')) {
    if (!line.includes('task-notification')) continue;
    let text = line;
    try {
      const d = JSON.parse(line);
      text = typeof d.content === 'string' ? d.content : typeof d.message?.content === 'string' ? d.message.content : line;
    } catch {}
    const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
    const status = /<status>([^<]+)<\/status>/.exec(text)?.[1];
    if (!id || !status) continue;
    const code = /exit code (\d+)/.exec(text)?.[1];
    if (out.some((o) => o.id === id)) continue;
    out.push({ id, ok: status === 'completed' && (code === undefined || code === '0'), ...(code !== undefined ? { code: Number(code) } : {}) });
  }
  return out;
}

/** Fase da espera pelo shell, pelo tempo: pipoca, braços cruzados, teia de aranha e cochilo. */
export function shellStage(sinceMs: number): { icon: string; label: string } {
  const min = sinceMs / 60_000;
  if (min >= 25) return { icon: '💤', label: 'cochilando' };
  if (min >= 10) return { icon: '🕸️', label: 'criando teia' };
  if (min >= 3) return { icon: '😒', label: 'de braços cruzados' };
  return { icon: '🍿', label: 'comendo pipoca' };
}

/** "3 min", "1 h 05". */
export function elapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'agora';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
