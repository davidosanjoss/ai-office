import { describe, expect, it } from 'vitest';
import { countChanges, parseDiff } from '../web/diff.ts';

const SAMPLE = `diff --git a/app.ts b/app.ts
index 1111111..2222222 100644
--- a/app.ts
+++ b/app.ts
@@ -1,4 +1,5 @@ function main() {
 import x from 'x';
-const a = 1;
+const a = 2;
+const b = 3;
 
 export {};
@@ -20,2 +21,2 @@
-velho
+novo
 fim
\\ No newline at end of file
`;

describe('parseDiff', () => {
  const lines = parseDiff(SAMPLE);

  it('ignora o cabeçalho e marca os blocos (hunks)', () => {
    expect(lines[0]).toEqual({ kind: 'hunk', text: 'function main() {' });
    expect(lines.filter((l) => l.kind === 'hunk')).toHaveLength(2);
  });

  it('numera as linhas do arquivo antigo e do novo', () => {
    expect(lines.slice(1, 7)).toEqual([
      { kind: 'ctx', text: "import x from 'x';", old: 1, new: 1 },
      { kind: 'del', text: 'const a = 1;', old: 2 },
      { kind: 'add', text: 'const a = 2;', new: 2 },
      { kind: 'add', text: 'const b = 3;', new: 3 },
      { kind: 'ctx', text: '', old: 3, new: 4 },
      { kind: 'ctx', text: 'export {};', old: 4, new: 5 },
    ]);
  });

  it('segundo bloco recomeça na numeração dele', () => {
    const second = lines.slice(lines.findIndex((l, i) => i > 0 && l.kind === 'hunk') + 1);
    expect(second.slice(0, 3)).toEqual([
      { kind: 'del', text: 'velho', old: 20 },
      { kind: 'add', text: 'novo', new: 21 },
      { kind: 'ctx', text: 'fim', old: 21, new: 22 },
    ]);
    expect(second.at(-1)?.kind).toBe('note');
  });

  it('conta adicionadas e removidas', () => {
    expect(countChanges(lines)).toEqual({ additions: 3, deletions: 2 });
  });

  it('arquivo novo (sem linhas antigas)', () => {
    expect(parseDiff('@@ -0,0 +1,2 @@\n+a\n+b\n')).toEqual([
      { kind: 'hunk', text: '' },
      { kind: 'add', text: 'a', new: 1 },
      { kind: 'add', text: 'b', new: 2 },
    ]);
  });

  it('linhas que parecem cabeçalho dentro do bloco continuam sendo conteúdo', () => {
    const l = parseDiff('@@ -1,2 +1,2 @@\n---- titulo\n++++ titulo\n');
    expect(l.slice(1)).toEqual([
      { kind: 'del', text: '--- titulo', old: 1 },
      { kind: 'add', text: '+++ titulo', new: 1 },
    ]);
  });

  it('diff vazio', () => {
    expect(parseDiff('')).toEqual([]);
  });
});
