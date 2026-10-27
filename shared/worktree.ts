// Regras do worktree de um agente que não dependem do git: o texto sugerido para o PR e
// quando a branch pode ser apagada. Usado pelo servidor e pela interface.

import type { WorktreeStatus } from './types.ts';

/** A branch só pode ser apagada se o trabalho dela já está na branch da sala ou no origin. */
export const canDeleteBranch = (st: WorktreeStatus) => (!!st.target && st.ahead === 0) || st.pushed;

/** Título e descrição do PR a partir dos commits da branch, do mais antigo para o mais novo. */
export function prSuggestion(commits: { subject: string; body: string }[], branch: string): { title: string; body: string } {
  if (!commits.length) return { title: branch, body: '' };
  if (commits.length === 1) return { title: commits[0].subject, body: commits[0].body.trim() };
  return {
    title: commits[0].subject,
    body: ['Commits:', '', ...commits.map((c) => `- ${c.subject}`)].join('\n'),
  };
}
