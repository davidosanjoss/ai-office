// Explorador: árvore de arquivos com editor (Monaco) e histórico do git (branches, commits e
// comparações, com diff lado a lado). É uma aba da sala, ao lado dos agentes, e ocupa o lugar
// do terminal. Fica preso à pasta em que foi aberto: trocar de aba só o esconde, e o que você
// editava continua lá quando volta; fechar a aba (×) o esvazia.

import type * as Monaco from 'monaco-editor';
import type { CommitDetail, CommitLog, CommitSummary, DirEntry, DirListing, FileChange, FileContent, GitInfo, GitRef, RefCompare } from '../shared/types.ts';
import * as logic from './logic.ts';

type MonacoModule = typeof import('./monaco.ts');

/** A pasta aberta no explorador. */
export interface ExplorerTarget {
  /** Rota da pasta: /api/agents/<id> ou /api/rooms/<id>. */
  base: string;
  /** Sala em cujas abas o explorador aparece. */
  roomId: string;
  /** Nome na aba ("Arquivos", ou "Arquivos · Ana" no worktree de um agente). */
  tab: string;
  /** Descrição no cabeçalho (sala e caminho, ou agente e branch do worktree). */
  label: string;
}

export interface ExplorerDeps {
  api(method: string, url: string, body?: unknown): Promise<any>;
  confirm(title: string, text: string): Promise<boolean>;
  /** O explorador apareceu: esconder o diff. */
  onShow(): void;
  /** O explorador saiu da tela: mostrar o terminal de novo. */
  onHide(): void;
  /** A aba mudou (abriu, fechou, ativou): redesenhar as abas. */
  onTabChange(): void;
  /** Trocou entre Arquivos, Histórico e Git (o modo Git mostra o painel de git do escritório). */
  onModeChange(mode: ExplorerMode): void;
}

export type ExplorerMode = 'files' | 'history' | 'git';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const q = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

/** Arquivo aberto no editor. Sem `ref`, é o da pasta (editável); com `ref`, o de um commit. */
interface OpenFile {
  path: string;
  ref?: string;
  version: string;
  /** Versão do modelo do Monaco no último salvar: diferente dela = talvez algo por salvar. */
  savedAt: number;
  /** Texto como está no disco, para o "Desfazer edição". */
  saved: string;
  /** Texto no último commit: undefined = arquivo novo; null = pasta sem git (ou não deu para ler). */
  head: string | null | undefined;
}

/** Diff aberto no histórico: o arquivo nas duas pontas. */
interface OpenDiff {
  path: string;
  from: string;
  to: string;
  label: string;
}

export class Explorer {
  private deps: ExplorerDeps;
  private target?: ExplorerTarget;
  private base = '';
  private mode: ExplorerMode = 'files';
  private shown = false;

  // Arquivos
  /** Ref vista na árvore; vazio = a pasta no disco. */
  private treeRef = '';
  private listings = new Map<string, DirEntry[]>();
  private truncated = new Set<string>();
  private expanded = new Set<string>(['']);
  private selected = '';
  private selectedKind: 'dir' | 'file' = 'dir';
  private marks = new Map<string, string>();
  private open?: OpenFile;
  private conflict = false;
  private saving = false;
  /** O arquivo aberto aparece lado a lado com o último commit. */
  private showingChanges = false;

  // Histórico
  private refs: GitRef[] = [];
  private histRef = '';
  private compareTo = '';
  private log: CommitSummary[] = [];
  private more = false;
  private commit?: CommitDetail;
  private comparison?: RefCompare;
  private diff?: OpenDiff;
  private histError = '';

  // Monaco
  private monaco?: MonacoModule;
  private loading?: Promise<MonacoModule>;
  private editor?: Monaco.editor.IStandaloneCodeEditor;
  private diffEditor?: Monaco.editor.IStandaloneDiffEditor;
  /** Alterações do arquivo aberto: o último commit à esquerda, o mesmo modelo do editor à direita. */
  private changesEditor?: Monaco.editor.IStandaloneDiffEditor;

  constructor(deps: ExplorerDeps) {
    this.deps = deps;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#files-modes button')) {
      b.addEventListener('click', () => this.setMode(b.dataset.mode as ExplorerMode));
    }
    $('#files-tree').addEventListener('click', (e) => this.onTreeClick(e));
    $('#files-ref').addEventListener('change', () => this.setTreeRef($<HTMLSelectElement>('#files-ref').value));
    $('#files-new-file').addEventListener('click', () => this.create('file'));
    $('#files-new-dir').addEventListener('click', () => this.create('dir'));
    $('#files-rename').addEventListener('click', () => this.rename());
    $('#files-delete').addEventListener('click', () => this.remove());
    $('#files-reload').addEventListener('click', () => this.reloadTree());
    $('#files-save').addEventListener('click', () => this.save());
    $('#files-undo').addEventListener('click', () => this.undoEdit());
    $('#files-changes-btn').addEventListener('click', () => this.toggleChanges());
    $('#files-restore').addEventListener('click', () => this.restore());
    $('#files-msg').addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')?.dataset.act;
      if (act === 'reload') this.reopen();
      else if (act === 'force') this.save(true);
      else if (act === 'edit' && this.diff) this.editFromDiff(this.diff.path);
    });
    $('#hist-ref').addEventListener('change', () => {
      this.histRef = $<HTMLSelectElement>('#hist-ref').value;
      this.loadHistory();
    });
    $('#hist-compare').addEventListener('change', () => {
      this.compareTo = $<HTMLSelectElement>('#hist-compare').value;
      this.loadHistory();
    });
    $('#hist-list').addEventListener('click', (e) => this.onHistoryClick(e));

    window.addEventListener('keydown', (e) => {
      if (!this.shown || document.querySelector('dialog[open]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        // Fora do editor também: o navegador abriria o "Salvar página".
        e.preventDefault();
        this.save();
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.dirty()) e.preventDefault();
    });
  }

  isShown() {
    return this.shown;
  }

  /** Modo em que o explorador está (Arquivos, Histórico ou Git). */
  currentMode(): ExplorerMode {
    return this.mode;
  }

  /** A aba aberta, se houver: em que sala ela aparece e com que nome. */
  tab(): ExplorerTarget | undefined {
    return this.target;
  }

  /**
   * Mostra o explorador. Com `target`, abre naquela pasta; se era outra, começa do zero
   * (perguntando, se há algo por salvar). Sem `target`, volta à aba que já estava aberta.
   */
  async show(target?: ExplorerTarget) {
    if (target && target.base !== this.base) {
      if (this.dirty() && !(await this.deps.confirm('Descartar alterações?', `${this.open!.path} tem alterações não salvas, de outra pasta.`))) return;
      this.reset(target.base);
    }
    if (target) this.target = target;
    if (!this.target) return;
    const wasShown = this.shown;
    this.shown = true;
    $('#files-view').hidden = false;
    $('#files-root').textContent = this.target.label;
    if (!wasShown) this.deps.onShow();
    this.setMode(this.mode);
    if (!this.listings.has('')) this.reloadTree();
    if (!this.refs.length) this.loadRefs();
    this.deps.onTabChange();
  }

  /** Volta ao terminal. O que estava aberto continua na aba para a próxima vez. */
  hide() {
    if (!this.shown) return;
    this.shown = false;
    $('#files-view').hidden = true;
    this.deps.onHide();
    this.deps.onTabChange();
  }

  /** Fecha a aba (o × dela), perguntando se há algo por salvar. */
  async closeTab() {
    if (this.dirty() && !(await this.deps.confirm('Descartar alterações?', `${this.open!.path} tem alterações não salvas.`))) return;
    this.reset('');
    this.target = undefined;
    if (this.shown) this.hide();
    else this.deps.onTabChange();
  }

  private reset(base: string) {
    this.base = base;
    this.treeRef = '';
    this.listings.clear();
    this.truncated.clear();
    this.expanded = new Set(['']);
    this.selected = '';
    this.selectedKind = 'dir';
    this.marks.clear();
    this.open = undefined;
    this.conflict = false;
    this.showingChanges = false;
    this.refs = [];
    this.histRef = '';
    this.compareTo = '';
    this.log = [];
    this.commit = undefined;
    this.comparison = undefined;
    this.diff = undefined;
    this.closeModels();
    this.disposeDiffModels();
    this.showPane('empty');
    this.setBar('', '');
  }

  private setMode(mode: ExplorerMode) {
    this.mode = mode;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#files-modes button')) b.classList.toggle('active', b.dataset.mode === mode);
    $('#files-tree-pane').hidden = mode !== 'files';
    $('#hist-pane').hidden = mode !== 'history';
    $('#git-pane').hidden = mode !== 'git';
    $('#files-work').hidden = mode === 'git';
    $('#git-main').hidden = mode !== 'git';
    this.deps.onModeChange(mode);
    if (mode === 'git') return;
    if (mode === 'files') {
      this.showPane(this.open ? (this.showingChanges ? 'changes' : 'editor') : 'empty');
      this.renderBar();
    } else {
      if (this.diff) this.showPane('diff');
      else this.showPane('empty');
      this.renderDiffBar();
      if (!this.log.length && !this.comparison && this.histRef) this.loadHistory();
    }
  }

  // ---------- Monaco ----------

  private loadMonaco(): Promise<MonacoModule> {
    this.loading ??= import('./monaco.ts').then((m) => (this.monaco = m));
    return this.loading;
  }

  private async codeEditor() {
    const m = await this.loadMonaco();
    this.editor ??= (() => {
      const ed = m.monaco.editor.create($('#files-editor'), {
        theme: 'escritorio',
        automaticLayout: true,
        fontFamily: "'JetBrains Mono', Consolas, monospace",
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 2,
      });
      ed.addCommand(m.monaco.KeyMod.CtrlCmd | m.monaco.KeyCode.KeyS, () => this.save());
      ed.onDidChangeModelContent(() => this.renderBar());
      return ed;
    })();
    return this.editor;
  }

  private async diffView() {
    const m = await this.loadMonaco();
    this.diffEditor ??= m.monaco.editor.createDiffEditor($('#files-diff'), {
      theme: 'escritorio',
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      fontFamily: "'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      minimap: { enabled: false },
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      scrollBeyondLastLine: false,
    });
    return this.diffEditor;
  }

  private async changesView() {
    const m = await this.loadMonaco();
    this.changesEditor ??= (() => {
      const ed = m.monaco.editor.createDiffEditor($('#files-changes'), {
        theme: 'escritorio',
        automaticLayout: true,
        originalEditable: false,
        renderMarginRevertIcon: true,
        fontFamily: "'JetBrains Mono', Consolas, monospace",
        fontSize: 13,
        minimap: { enabled: false },
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        scrollBeyondLastLine: false,
      });
      ed.getModifiedEditor().addCommand(m.monaco.KeyMod.CtrlCmd | m.monaco.KeyCode.KeyS, () => this.save());
      return ed;
    })();
    return this.changesEditor;
  }

  private disposeDiffModels() {
    const models = this.diffEditor?.getModel();
    this.diffEditor?.setModel(null);
    models?.original.dispose();
    models?.modified.dispose();
  }

  private showPane(pane: 'editor' | 'changes' | 'diff' | 'empty', text?: string) {
    $('#files-editor').hidden = pane !== 'editor';
    $('#files-changes').hidden = pane !== 'changes';
    $('#files-diff').hidden = pane !== 'diff';
    const empty = $('#files-empty');
    empty.hidden = pane !== 'empty';
    empty.textContent =
      text ?? (this.mode === 'files' ? 'Escolha um arquivo na árvore. Ctrl+S salva.' : 'Escolha um commit e depois um arquivo para ver o que mudou.');
  }

  // ---------- árvore ----------

  private treeUrl(dir: string) {
    return this.treeRef ? `${this.base}/history/tree?${q({ ref: this.treeRef, path: dir })}` : `${this.base}/files/list?${q({ path: dir })}`;
  }

  private async loadDir(dir: string) {
    const data = (await this.deps.api('GET', this.treeUrl(dir))) as DirListing;
    this.listings.set(dir, data.entries);
    if (data.truncated) this.truncated.add(dir);
    else this.truncated.delete(dir);
  }

  /** Relê as pastas abertas (e as marcas do git), mantendo o que estava aberto e selecionado. */
  async reloadTree() {
    const base = this.base;
    try {
      const dirs = [...this.expanded];
      this.listings.clear();
      await Promise.all(dirs.map((d) => this.loadDir(d).catch(() => this.expanded.delete(d))));
      if (base !== this.base) return;
      this.marks = new Map();
      if (!this.treeRef) {
        const info = (await this.deps.api('GET', `${this.base}/git`)) as GitInfo;
        if (info.isRepo) this.marks = logic.treeMarks(info.files ?? []);
      }
    } catch (err) {
      if (base === this.base) $('#files-tree').textContent = (err as Error).message;
      return;
    }
    this.renderTree();
  }

  private async setTreeRef(ref: string) {
    if (ref === this.treeRef) return;
    if (this.dirty() && !(await this.deps.confirm('Descartar alterações?', `${this.open!.path} tem alterações não salvas.`))) {
      $<HTMLSelectElement>('#files-ref').value = this.treeRef;
      return;
    }
    this.treeRef = ref;
    this.expanded = new Set(['']);
    this.selected = '';
    this.selectedKind = 'dir';
    this.open = undefined;
    this.showingChanges = false;
    this.closeModels();
    this.showPane('empty');
    this.renderBar();
    await this.reloadTree();
  }

  private renderTree() {
    const rows: string[] = [];
    const walk = (dir: string, depth: number) => {
      for (const e of this.listings.get(dir) ?? []) {
        const p = logic.childPath(dir, e.name);
        const isOpen = e.kind === 'dir' && this.expanded.has(p);
        const mark = this.marks.get(p);
        const cls = ['node', e.kind, p === this.selected ? 'selected' : '', p === this.open?.path ? 'open' : '', mark ? `mk-${mark === '•' ? 'dir' : mark}` : '']
          .filter(Boolean)
          .join(' ');
        rows.push(
          `<button class="${cls}" data-path="${esc(p)}" data-kind="${e.kind}" style="padding-left:${6 + depth * 14}px" title="${esc(p)}">` +
            `<span class="tw">${e.kind === 'dir' ? (isOpen ? '▾' : '▸') : ''}</span><span class="nm">${esc(e.name)}</span>` +
            `${mark ? `<span class="mk">${esc(mark)}</span>` : ''}</button>`,
        );
        if (isOpen) walk(p, depth + 1);
      }
      if (this.truncated.has(dir)) rows.push(`<div class="node more" style="padding-left:${6 + depth * 14}px">… mais itens não mostrados</div>`);
    };
    walk('', 0);
    $('#files-tree').innerHTML = rows.join('') || '<p class="muted empty">Pasta vazia</p>';
    const editable = !this.treeRef;
    for (const id of ['#files-new-file', '#files-new-dir']) $<HTMLButtonElement>(id).disabled = !editable;
    for (const id of ['#files-rename', '#files-delete']) $<HTMLButtonElement>(id).disabled = !editable || !this.selected;
  }

  private async onTreeClick(e: Event) {
    const node = (e.target as HTMLElement).closest<HTMLButtonElement>('button.node');
    if (!node) return;
    const p = node.dataset.path!;
    this.selected = p;
    this.selectedKind = node.dataset.kind as 'dir' | 'file';
    if (this.selectedKind === 'dir') {
      if (this.expanded.has(p)) this.expanded.delete(p);
      else {
        this.expanded.add(p);
        if (!this.listings.has(p)) await this.loadDir(p).catch((err) => this.setBar('', (err as Error).message, 'error'));
      }
      this.renderTree();
    } else {
      this.renderTree();
      this.openFile(p);
    }
  }

  // ---------- editor ----------

  /** Há algo por salvar: o texto do editor não é o do disco. */
  private dirty(): boolean {
    const model = this.editor?.getModel();
    if (!this.open || this.open.ref || !model) return false;
    return model.getAlternativeVersionId() !== this.open.savedAt && model.getValue() !== this.open.saved;
  }

  async openFile(file: string, opts: { force?: boolean } = {}) {
    if (!opts.force && this.open?.path === file && this.open.ref === (this.treeRef || undefined)) return;
    if (!opts.force && this.dirty() && !(await this.deps.confirm('Descartar alterações?', `${this.open!.path} tem alterações não salvas.`))) return;
    const ref = this.treeRef || undefined;
    this.showPane('empty', 'Carregando…');
    this.setBar(file, '');
    let data: FileContent;
    let head: FileContent | undefined;
    try {
      const url = ref ? `${this.base}/history/show?${q({ ref, path: file })}` : `${this.base}/files/read?${q({ path: file })}`;
      // O último commit, para "Ver alterações" e "Desfazer alterações". Sem git, fica sem.
      const headReq = ref ? undefined : (this.deps.api('GET', `${this.base}/files/head?${q({ path: file })}`) as Promise<FileContent>).catch(() => undefined);
      [data, head] = await Promise.all([this.deps.api('GET', url) as Promise<FileContent>, headReq, this.codeEditor()]);
    } catch (err) {
      this.showPane('empty', (err as Error).message);
      return;
    }
    if (data.binary || data.tooLarge) {
      this.open = undefined;
      this.closeModels();
      this.showPane('empty', data.binary ? 'Arquivo binário: não abre no editor.' : 'Arquivo grande demais para o editor (mais de 2 MB).');
      this.setBar(file, '');
      this.renderTree();
      return;
    }
    const m = this.monaco!.monaco;
    this.closeModels();
    const model = m.editor.createModel(data.content, this.monaco!.languageOf(file));
    this.editor!.setModel(model);
    this.editor!.updateOptions({ readOnly: !!ref });
    this.open = {
      path: file,
      ref,
      version: data.version,
      savedAt: model.getAlternativeVersionId(),
      saved: data.content,
      head: !head || head.binary || head.tooLarge ? null : head.missing ? undefined : head.content,
    };
    this.conflict = false;
    this.showingChanges = false;
    this.selected = file;
    this.selectedKind = 'file';
    this.showPane('editor');
    this.renderBar();
    this.renderTree();
    this.editor!.focus();
  }

  /** Fecha o arquivo do editor e o lado "último commit" da tela de alterações. */
  private closeModels() {
    const changes = this.changesEditor?.getModel();
    this.changesEditor?.setModel(null);
    changes?.original.dispose();
    const model = this.editor?.getModel();
    this.editor?.setModel(null);
    model?.dispose();
  }

  /** Relê do disco o arquivo aberto, descartando o que não foi salvo. */
  private reopen() {
    if (this.open) this.openFile(this.open.path, { force: true });
  }

  /** Salva o arquivo aberto. `force` sobrescreve mesmo se ele mudou no disco depois que você abriu. */
  async save(force = false) {
    if (this.mode !== 'files' || !this.open || this.open.ref || !this.editor || this.saving) return;
    if (!this.dirty() && !force) return;
    const open = this.open;
    const model = this.editor.getModel()!;
    const at = model.getAlternativeVersionId();
    const content = model.getValue();
    this.saving = true;
    $<HTMLButtonElement>('#files-save').disabled = true;
    this.setBar(open.path, 'Salvando…');
    try {
      const { version } = (await this.deps.api('PUT', `${this.base}/files/write`, {
        path: open.path,
        content,
        ...(force ? {} : { version: open.version }),
      })) as { version: string };
      open.version = version;
      open.savedAt = at;
      open.saved = content;
      this.conflict = false;
      this.renderBar('Salvo.');
      this.refreshMarks();
    } catch (err) {
      this.conflict = /mudou no disco|apagado/.test((err as Error).message);
      this.renderBar((err as Error).message, 'error');
    } finally {
      this.saving = false;
    }
  }

  /** Troca o texto do editor inteiro, como uma edição: o Ctrl+Z traz o anterior de volta. */
  private replaceText(text: string) {
    const model = this.editor?.getModel();
    if (!model) return;
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    model.pushStackElement();
  }

  /** "Desfazer edição": volta ao que está salvo no disco. */
  private undoEdit() {
    if (!this.open || !this.dirty()) return;
    this.replaceText(this.open.saved);
    this.renderBar('Edição desfeita. Ctrl+Z traz de volta.');
  }

  /** "Desfazer alterações": volta o arquivo inteiro ao último commit e salva. */
  private async restore() {
    const open = this.open;
    if (!open || typeof open.head !== 'string') return;
    const ok = await this.deps.confirm(
      `Desfazer as alterações de ${open.path}?`,
      'O arquivo volta a ser como está no último commit, e é salvo assim. Enquanto ele estiver aberto, Ctrl+Z no editor traz o texto de antes.',
    );
    if (!ok || this.open !== open) return;
    this.replaceText(open.head);
    await this.save();
  }

  /** Alterna entre o editor e o arquivo lado a lado com o último commit. */
  private async toggleChanges() {
    const open = this.open;
    if (!open) return;
    if (this.showingChanges) {
      this.showingChanges = false;
      this.showPane('editor');
      this.renderBar();
      this.editor?.focus();
      return;
    }
    if (typeof open.head !== 'string') return;
    const ed = await this.changesView();
    if (this.open !== open) return;
    const m = this.monaco!.monaco;
    const model = this.editor!.getModel()!;
    const previous = ed.getModel();
    // O lado direito é o mesmo modelo do editor: o que você muda aqui (inclusive pelas setas
    // da margem, que desfazem um bloco) é o que o Ctrl+S salva.
    ed.setModel({ original: m.editor.createModel(open.head, model.getLanguageId()), modified: model });
    previous?.original.dispose();
    this.showingChanges = true;
    this.showPane('changes');
    this.renderBar();
  }

  private async refreshMarks() {
    try {
      const info = (await this.deps.api('GET', `${this.base}/git`)) as GitInfo;
      this.marks = info.isRepo ? logic.treeMarks(info.files ?? []) : new Map();
      this.renderTree();
    } catch {}
  }

  private setBar(path: string, msg: string, kind = '') {
    $('#files-path').textContent = path;
    for (const id of ['#files-save', '#files-undo', '#files-changes-btn', '#files-restore']) $(id).hidden = true;
    const el = $('#files-msg');
    el.className = kind;
    el.textContent = msg;
  }

  private renderBar(msg = '', kind = '') {
    if (this.mode !== 'files') return;
    const open = this.open;
    const dirty = this.dirty();
    $('#files-path').textContent = open ? `${open.path}${dirty ? ' ●' : ''}` : '';
    $('#files-note').textContent = open?.ref ? `só leitura, em ${open.ref}` : this.showingChanges ? 'último commit ← → agora' : '';
    const model = this.editor?.getModel();
    const ui = logic.editorButtons({
      readOnly: !open || !!open.ref,
      dirty,
      head: open && model ? logic.headState(model.getValue(), open.head) : 'unknown',
      showingChanges: this.showingChanges,
    });
    const save = $<HTMLButtonElement>('#files-save');
    save.hidden = !ui.save;
    save.disabled = !dirty;
    $('#files-undo').hidden = !ui.undoEdit;
    const changes = $('#files-changes-btn');
    changes.hidden = !ui.changes;
    changes.textContent = this.showingChanges ? 'Voltar ao editor' : 'Ver alterações';
    $('#files-restore').hidden = !ui.restore;
    const el = $('#files-msg');
    el.className = kind;
    el.innerHTML = esc(msg);
    if (this.conflict) {
      el.innerHTML +=
        ' <button class="btn small ghost" data-act="reload">Recarregar do disco</button> <button class="btn small danger" data-act="force">Salvar mesmo assim</button>';
    }
  }

  // ---------- criar, renomear, apagar ----------

  /** Pasta onde algo novo é criado: a selecionada, ou a do arquivo selecionado. */
  private targetDir() {
    return this.selectedKind === 'dir' ? this.selected : logic.parentPath(this.selected);
  }

  private async create(kind: 'file' | 'dir') {
    const dir = this.targetDir();
    const name = await askName(kind === 'file' ? 'Novo arquivo' : 'Nova pasta', `Em ${dir || 'raiz do projeto'}`, '');
    if (!name) return;
    const p = logic.childPath(dir, name);
    try {
      if (kind === 'file') await this.deps.api('PUT', `${this.base}/files/write`, { path: p, content: '', create: true });
      else await this.deps.api('POST', `${this.base}/files/mkdir`, { path: p });
    } catch (err) {
      this.setBar('', (err as Error).message, 'error');
      return;
    }
    if (dir) this.expanded.add(dir);
    if (kind === 'dir') this.expanded.add(p);
    this.selected = p;
    this.selectedKind = kind;
    await this.reloadTree();
    if (kind === 'file') this.openFile(p);
  }

  private async rename() {
    const from = this.selected;
    if (!from) return;
    const dir = logic.parentPath(from);
    const name = await askName('Renomear', from, from.slice(from.lastIndexOf('/') + 1));
    if (!name) return;
    const to = logic.childPath(dir, name);
    if (to === from) return;
    try {
      await this.deps.api('POST', `${this.base}/files/rename`, { from, to });
    } catch (err) {
      this.setBar('', (err as Error).message, 'error');
      return;
    }
    // Pastas abertas e o arquivo no editor acompanham o nome novo.
    this.expanded = new Set([...this.expanded].map((d) => logic.renamedPath(d, from, to) ?? d));
    if (this.open) {
      const moved = logic.renamedPath(this.open.path, from, to);
      if (moved) this.open.path = moved;
    }
    this.selected = to;
    await this.reloadTree();
    this.renderBar();
  }

  private async remove() {
    const p = this.selected;
    if (!p) return;
    const isDir = this.selectedKind === 'dir';
    const ok = await this.deps.confirm(`Apagar ${p}?`, isDir ? 'A pasta e tudo o que há dentro dela vão para fora do disco (não vão para a lixeira).' : 'O arquivo é apagado do disco (não vai para a lixeira).');
    if (!ok) return;
    try {
      await this.deps.api('POST', `${this.base}/files/delete`, { path: p });
    } catch (err) {
      this.setBar('', (err as Error).message, 'error');
      return;
    }
    if (this.open && logic.removedWith(this.open.path, p)) {
      this.open = undefined;
      this.showingChanges = false;
      this.closeModels();
      this.showPane('empty');
    }
    this.selected = logic.parentPath(p);
    this.selectedKind = 'dir';
    await this.reloadTree();
    this.renderBar();
  }

  // ---------- histórico ----------

  private async loadRefs() {
    const base = this.base;
    try {
      this.refs = (await this.deps.api('GET', `${this.base}/history/refs`)) as GitRef[];
      this.histError = '';
    } catch (err) {
      this.refs = [];
      this.histError = (err as Error).message;
    }
    if (base !== this.base) return;
    const current = this.refs.find((r) => r.current)?.name ?? this.refs[0]?.name ?? '';
    this.histRef ||= current;
    const groups = (sel: HTMLSelectElement, first: [string, string]) => {
      const kinds: [GitRef['kind'], string][] = [
        ['branch', 'Branches'],
        ['remote', 'Remotas'],
        ['tag', 'Tags'],
      ];
      sel.replaceChildren(
        ...(first[1] ? [new Option(first[1], first[0])] : []),
        ...kinds
          .map(([kind, label]) => {
            const g = document.createElement('optgroup');
            g.label = label;
            g.append(...this.refs.filter((r) => r.kind === kind).map((r) => new Option(`${r.name}${r.current ? ' (atual)' : ''}`, r.name)));
            return g;
          })
          .filter((g) => g.children.length),
      );
    };
    groups($<HTMLSelectElement>('#files-ref'), ['', 'Pasta no disco (editável)']);
    $<HTMLSelectElement>('#files-ref').value = this.treeRef;
    groups($<HTMLSelectElement>('#hist-ref'), ['', '']);
    $<HTMLSelectElement>('#hist-ref').value = this.histRef;
    groups($<HTMLSelectElement>('#hist-compare'), ['', 'Comparar com…']);
    $<HTMLSelectElement>('#hist-compare').value = this.compareTo;
    if (this.mode === 'history') this.loadHistory();
    else this.renderHistory();
  }

  private async loadHistory() {
    const base = this.base;
    this.commit = undefined;
    this.comparison = undefined;
    this.log = [];
    this.more = false;
    if (!this.histRef) return this.renderHistory();
    $('#hist-list').innerHTML = '<p class="muted empty">Carregando…</p>';
    try {
      if (this.compareTo) {
        this.comparison = (await this.deps.api('GET', `${this.base}/history/compare?${q({ from: this.histRef, to: this.compareTo })}`)) as RefCompare;
      } else {
        const data = (await this.deps.api('GET', `${this.base}/history/log?${q({ ref: this.histRef })}`)) as CommitLog;
        this.log = data.commits;
        this.more = data.more;
      }
      this.histError = '';
    } catch (err) {
      this.histError = (err as Error).message;
    }
    if (base === this.base) this.renderHistory();
  }

  private async loadMore() {
    try {
      const data = (await this.deps.api('GET', `${this.base}/history/log?${q({ ref: this.histRef, skip: this.log.length })}`)) as CommitLog;
      this.log.push(...data.commits);
      this.more = data.more;
    } catch (err) {
      this.histError = (err as Error).message;
    }
    this.renderHistory();
  }

  private renderHistory() {
    const list = $('#hist-list');
    if (this.histError) {
      list.innerHTML = `<p class="error">${esc(this.histError)}</p>`;
      return;
    }
    if (this.commit) {
      const c = this.commit;
      list.innerHTML = `<button class="btn small ghost hist-back" data-act="back">← ${this.comparison ? 'comparação' : 'commits'}</button>
        <div class="hist-commit">
          <div><code>${esc(c.short)}</code> <span class="muted" title="${esc(c.date)}">${esc(c.author)} · ${esc(c.when)}</span></div>
          <pre>${esc(c.message)}</pre>
        </div>
        <h4>${c.files.length} arquivo${c.files.length === 1 ? '' : 's'}</h4>
        ${fileRows(c.files, this.diff)}`;
      return;
    }
    if (this.comparison) {
      const c = this.comparison;
      list.innerHTML = `<div class="hist-commit">
          <div><b>${esc(c.to)}</b> tem <b>${c.ahead}</b> commit${c.ahead === 1 ? '' : 's'} que <b>${esc(c.from)}</b> não tem${c.behind ? `, e está ${c.behind} atrás` : ''}.</div>
        </div>
        <h4>${c.files.length} arquivo${c.files.length === 1 ? '' : 's'} diferente${c.files.length === 1 ? '' : 's'}</h4>
        ${c.files.length ? fileRows(c.files, this.diff) : '<p class="muted empty">Nenhuma diferença nos arquivos.</p>'}
        ${c.commits.length ? `<h4>Commits</h4>${c.commits.map(commitRow).join('')}` : ''}`;
      return;
    }
    list.innerHTML = this.log.length
      ? this.log.map(commitRow).join('') + (this.more ? '<button class="btn small ghost hist-more" data-act="more">Carregar mais</button>' : '')
      : '<p class="muted empty">Nenhum commit.</p>';
  }

  private async onHistoryClick(e: Event) {
    const el = e.target as HTMLElement;
    const act = el.closest<HTMLButtonElement>('button[data-act]')?.dataset.act;
    if (act === 'more') return this.loadMore();
    if (act === 'back') {
      this.commit = undefined;
      return this.renderHistory();
    }
    const commit = el.closest<HTMLButtonElement>('button.commit-row')?.dataset.hash;
    if (commit) {
      try {
        this.commit = (await this.deps.api('GET', `${this.base}/history/commit?${q({ ref: commit })}`)) as CommitDetail;
        this.histError = '';
      } catch (err) {
        this.histError = (err as Error).message;
      }
      return this.renderHistory();
    }
    const file = el.closest<HTMLButtonElement>('button.file')?.dataset.path;
    if (!file) return;
    if (this.commit) this.openDiff({ path: file, from: this.commit.base, to: this.commit.hash, label: `commit ${this.commit.short}` });
    else if (this.comparison) {
      const c = this.comparison;
      this.openDiff({ path: file, from: c.fromHash, to: c.toHash, label: `${c.from} → ${c.to}` });
    }
  }

  private async openDiff(d: OpenDiff) {
    this.diff = d;
    this.renderHistory();
    this.showPane('empty', 'Carregando…');
    this.renderDiffBar();
    const show = (ref: string) =>
      // Primeiro commit: o lado de antes é a árvore vazia, sem arquivo nenhum.
      ref === EMPTY_TREE ? Promise.resolve({ content: '', missing: true } as FileContent) : (this.deps.api('GET', `${this.base}/history/show?${q({ ref, path: d.path })}`) as Promise<FileContent>);
    let a: FileContent, b: FileContent;
    try {
      [a, b] = await Promise.all([show(d.from), show(d.to), this.diffView()]);
    } catch (err) {
      this.showPane('empty', (err as Error).message);
      return;
    }
    if (this.diff !== d) return;
    if (a.binary || b.binary || a.tooLarge || b.tooLarge) {
      this.showPane('empty', a.binary || b.binary ? 'Arquivo binário: sem diff de linhas.' : 'Arquivo grande demais para o diff (mais de 2 MB).');
      return;
    }
    const m = this.monaco!.monaco;
    const lang = this.monaco!.languageOf(d.path);
    this.disposeDiffModels();
    this.diffEditor!.setModel({ original: m.editor.createModel(a.content, lang), modified: m.editor.createModel(b.content, lang) });
    if (this.mode === 'history') this.showPane('diff');
  }

  private renderDiffBar() {
    if (this.mode !== 'history') return;
    const d = this.diff;
    $('#files-path').textContent = d?.path ?? '';
    $('#files-note').textContent = d?.label ?? '';
    for (const id of ['#files-save', '#files-undo', '#files-changes-btn', '#files-restore']) $(id).hidden = true;
    const el = $('#files-msg');
    el.className = '';
    el.innerHTML = d ? '<button class="btn small ghost" data-act="edit" title="Abrir o arquivo da pasta no editor">Editar na pasta</button>' : '';
  }

  /** Do diff para o editor: o mesmo arquivo, como está na pasta. */
  private async editFromDiff(file: string) {
    if (this.treeRef) await this.setTreeRef('');
    if (this.treeRef) return;
    this.setMode('files');
    for (let dir = logic.parentPath(file); dir; dir = logic.parentPath(dir)) this.expanded.add(dir);
    await this.reloadTree();
    await this.openFile(file);
  }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function commitRow(c: CommitSummary) {
  return `<button class="commit-row" data-hash="${esc(c.hash)}" title="${esc(c.date)}">
    <span class="subj">${esc(c.subject)}</span>
    <span class="meta"><code>${esc(c.short)}</code> ${esc(c.author)} · ${esc(c.when)}</span>
  </button>`;
}

function fileRows(files: FileChange[], open?: OpenDiff) {
  return files
    .map((f) => {
      const slash = f.path.lastIndexOf('/');
      const nums =
        f.additions === undefined
          ? '<span class="muted">bin</span>'
          : `${f.additions ? `<span class="add">+${f.additions}</span>` : ''}${f.deletions ? `<span class="del">−${f.deletions}</span>` : ''}`;
      return `<button class="file${open?.path === f.path ? ' active' : ''}" data-path="${esc(f.path)}" title="${esc(f.path)}">
        <span class="st st-${esc(f.status[0])}">${esc(f.status)}</span><span class="name"><span class="dir">${esc(f.path.slice(0, slash + 1))}</span>${esc(f.path.slice(slash + 1))}</span><span class="nums">${nums}</span>
      </button>`;
    })
    .join('');
}

/** Pergunta um nome de arquivo ou pasta no diálogo #dlg-file-name. Vazio = cancelou. */
function askName(title: string, where: string, value: string): Promise<string> {
  const dlg = $<HTMLDialogElement>('#dlg-file-name');
  const form = dlg.querySelector('form')!;
  const input = form.querySelector<HTMLInputElement>('[name=name]')!;
  const error = dlg.querySelector<HTMLElement>('.error')!;
  $('#file-name-title').textContent = title;
  $('#file-name-where').textContent = where;
  input.value = value;
  error.hidden = true;
  // O Esc fecha sem mexer no returnValue: sem limpar, valeria o "ok" da vez anterior.
  dlg.returnValue = '';
  dlg.showModal();
  // Renomear: seleciona só o nome, sem a extensão, como no VS Code.
  const dot = value.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : value.length);
  return new Promise((resolve) => {
    const onSubmit = (e: SubmitEvent) => {
      if ((e.submitter as HTMLButtonElement | null)?.value !== 'ok') return;
      const problem = logic.fileNameError(input.value);
      if (problem) {
        e.preventDefault();
        error.textContent = problem;
        error.hidden = false;
      }
    };
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener(
      'close',
      () => {
        form.removeEventListener('submit', onSubmit);
        resolve(dlg.returnValue === 'ok' ? input.value.trim() : '');
      },
      { once: true },
    );
  });
}
