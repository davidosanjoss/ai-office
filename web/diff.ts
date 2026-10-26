// Visualizador de diff: transforma a saída do `git diff` em linhas numeradas e as desenha.

import type { FileDiff } from '../shared/types.ts';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'note';
  text: string;
  /** Número da linha no arquivo antigo (removidas e contexto). */
  old?: number;
  /** Número da linha no arquivo novo (adicionadas e contexto). */
  new?: number;
}

/** Lê um diff unificado. O cabeçalho (diff --git, index, ---/+++) é ignorado. */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: 'hunk', text: hunk[3].trim() });
    } else if (raw.startsWith('diff --git')) {
      inHunk = false;
    } else if (!inHunk) {
      continue;
    } else if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), new: newNo++ });
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), old: oldNo++ });
    } else if (raw.startsWith(' ')) {
      out.push({ kind: 'ctx', text: raw.slice(1), old: oldNo++, new: newNo++ });
    } else if (raw.startsWith('\\')) {
      out.push({ kind: 'note', text: 'sem quebra de linha no fim do arquivo' });
    }
  }
  return out;
}

export function countChanges(lines: DiffLine[]) {
  return {
    additions: lines.filter((l) => l.kind === 'add').length,
    deletions: lines.filter((l) => l.kind === 'del').length,
  };
}

/** Desenha as linhas do diff dentro de `body`. */
export function renderDiff(body: HTMLElement, file: FileDiff) {
  body.replaceChildren();
  if (file.binary) {
    body.append(message('Arquivo binário: não dá para mostrar as linhas.'));
    return;
  }
  const lines = parseDiff(file.diff);
  if (!lines.length) {
    body.append(message('Sem diferenças de conteúdo (pode ter mudado só a permissão do arquivo).'));
    return;
  }

  const table = document.createElement('div');
  table.className = 'diff-lines';
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    const row = document.createElement('div');
    row.className = `dl ${l.kind}`;
    if (l.kind === 'hunk') {
      row.innerHTML = '<span class="no"></span><span class="no"></span><span class="code"></span>';
      row.querySelector('.code')!.textContent = l.text ? `⋯ ${l.text}` : '⋯';
    } else if (l.kind === 'note') {
      row.innerHTML = '<span class="no"></span><span class="no"></span><span class="code"></span>';
      row.querySelector('.code')!.textContent = l.text;
    } else {
      row.innerHTML = '<span class="no"></span><span class="no"></span><span class="code"></span>';
      const [o, n, code] = row.children as unknown as HTMLElement[];
      o.textContent = l.old !== undefined ? String(l.old) : '';
      n.textContent = l.new !== undefined ? String(l.new) : '';
      code.textContent = `${l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '} ${l.text}`;
    }
    frag.append(row);
  }
  table.append(frag);
  body.append(table);
  if (file.truncated) body.append(message('Diff muito grande: mostrando só o começo.'));
}

function message(text: string) {
  const p = document.createElement('p');
  p.className = 'diff-msg';
  p.textContent = text;
  return p;
}
