// Monaco (o editor do VS Code), carregado só quando o explorador abre: o escritório continua leve.

import * as monaco from 'monaco-editor';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// Cada arquivo abre sozinho, sem o resto do projeto: os imports apareceriam como erro.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  defaults.setCompilerOptions({ ...defaults.getCompilerOptions(), jsx: monaco.typescript.JsxEmit.Preserve, allowNonTsExtensions: true });
}

monaco.editor.defineTheme('escritorio', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#16161e',
    'editorGutter.background': '#16161e',
    'diffEditor.insertedLineBackground': '#9ece6a1f',
    'diffEditor.removedLineBackground': '#f7768e1f',
  },
});

/** Linguagem do Monaco pelo nome do arquivo (extensão ou nomes conhecidos como Dockerfile). */
export function languageOf(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id;
  }
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.some((ext) => name.endsWith(ext.toLowerCase()))) return lang.id;
  }
  return 'plaintext';
}

export { monaco };
