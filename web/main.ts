import type { ActivityEvent, Agent, ClientMsg, DiffScope, FileChange, FileDiff, GitInfo, OfficeState, Room, ServerMsg } from '../shared/types.ts';
import type { Cell } from '../shared/building.ts';
import { countChanges, parseDiff, renderDiff } from './diff.ts';
import * as logic from './logic.ts';
import { Office, STATUS_COLOR } from './office.ts';
import { Terminals } from './terminals.ts';
import './styles.css';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const state: OfficeState = { rooms: [], agents: [], activity: [] };
let selectedRoom: string | undefined;
let selectedAgent: string | undefined;
let activityScope: 'room' | 'all' = 'room';
let lastKeyAt = 0;
let selectedAt = 0;
let ws: WebSocket | undefined;

// ---------- WebSocket ----------

function send(msg: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  let wasOpen = false;
  ws.onopen = () => {
    wasOpen = true;
    $('#conn').className = 'conn on';
    terminals.reattachAll();
  };
  ws.onclose = () => {
    $('#conn').className = 'conn off';
    setTimeout(connect, wasOpen ? 500 : 2000);
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerMsg);
}

function handle(msg: ServerMsg) {
  switch (msg.t) {
    case 'state':
      Object.assign(state, msg.state);
      if (!selectedRoom || !state.rooms.some((r) => r.id === selectedRoom)) selectedRoom = state.rooms[0]?.id;
      renderAll();
      refreshGit();
      break;
    case 'room':
      upsert(state.rooms, msg.room);
      renderAll();
      break;
    case 'roomRemoved':
      state.rooms = state.rooms.filter((r) => r.id !== msg.id);
      if (selectedRoom === msg.id) selectedRoom = state.rooms[0]?.id;
      renderAll();
      break;
    case 'agent': {
      const prev = state.agents.find((a) => a.id === msg.agent.id);
      upsert(state.agents, msg.agent);
      onAgentChanged(prev, msg.agent);
      renderAll(false);
      break;
    }
    case 'agentRemoved':
      state.agents = state.agents.filter((a) => a.id !== msg.id);
      terminals.remove(msg.id);
      if (selectedAgent === msg.id) selectAgent(roomAgents(selectedRoom)[0]?.id);
      renderAll();
      break;
    case 'activity':
      state.activity.push(msg.event);
      if (state.activity.length > 300) state.activity.shift();
      appendActivity(msg.event);
      if (msg.event.agentId === selectedAgent && msg.event.kind !== 'prompt') scheduleGitRefresh();
      break;
    case 'out':
      terminals.output(msg.id, msg.data);
      break;
    case 'replay':
      terminals.replay(msg.id, msg.data);
      break;
  }
}

function upsert<T extends { id: string }>(list: T[], item: T) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

// ---------- seleção ----------

const office = new Office($('#office'), {
  onSelectAgent: (id) => selectAgent(id),
  onAddAgent: (roomId) => openAgentDialog(roomId),
  onSelectRoom: (roomId) => selectRoom(roomId),
  onNewRoom: (cell) => openRoomDialog(cell),
});

$('#map-zoom-in').addEventListener('click', () => office.zoom(1));
$('#map-zoom-out').addEventListener('click', () => office.zoom(-1));
$('#map-fit').addEventListener('click', () => office.fit());

const terminals = new Terminals($('#terminals'), {
  attach: (id) => send({ t: 'attach', id }),
  input: (id, data) => send({ t: 'in', id, data }),
  userActivity: (id) => {
    lastKeyAt = Date.now();
    markSeen(id);
  },
  resize: (id, cols, rows) => send({ t: 'resize', id, cols, rows }),
});

function roomAgents(roomId?: string) {
  return logic.roomAgents(state.agents, roomId);
}

function selectRoom(roomId: string) {
  if (selectedRoom === roomId) return;
  selectedRoom = roomId;
  const first = roomAgents(roomId).find((a) => a.status !== 'exited') ?? roomAgents(roomId)[0];
  selectAgent(first?.id);
}

function selectAgent(id?: string) {
  // Quem terminou só sai da fila quando você responde ou troca de aba depois de olhar.
  if (selectedAgent && selectedAgent !== id) markSeen(selectedAgent);
  if (id !== selectedAgent) {
    selectedAt = Date.now();
    closeDiff();
  }
  selectedAgent = id;
  const agent = state.agents.find((a) => a.id === id);
  if (agent) {
    selectedRoom = agent.roomId;
    office.reveal(agent.roomId);
  }
  // Mesmo encerrado o terminal aparece: o que o processo mostrou ao sair fica visível.
  if (agent) terminals.show(agent.id);
  else terminals.hideAll();
  renderAll();
  refreshGit();
}

function markSeen(id: string) {
  const agent = state.agents.find((a) => a.id === id);
  if (agent?.status === 'done') send({ t: 'seen', id });
}

// ---------- fila de atenção ----------

function attentionQueue() {
  return logic.attentionQueue(state.agents);
}

function onAgentChanged(prev: Agent | undefined, agent: Agent) {
  if (logic.becameAttention(prev, agent)) {
    const msg = agent.status === 'done' ? `${agent.name} terminou` : `${agent.name} precisa de aprovação`;
    const room = state.rooms.find((r) => r.id === agent.roomId)?.name ?? '';
    if (agent.id !== selectedAgent || document.hidden) {
      toast(`${msg} · ${room}`, agent.status, () => selectAgent(agent.id));
      notify(`${msg}`, `${room}: ${agent.activity}`, agent.id);
    }
  }
}

const autoFocusOpt = $<HTMLInputElement>('#opt-autofocus');
try {
  autoFocusOpt.checked = localStorage.getItem('autofocus') !== 'off';
} catch {}
autoFocusOpt.addEventListener('change', () => {
  try {
    localStorage.setItem('autofocus', autoFocusOpt.checked ? 'on' : 'off');
  } catch {}
});

// Abre sozinho o terminal de quem terminou primeiro, mas só quando o agente atual não
// precisa de você: está trabalhando, encerrado ou parado há um tempo sem você digitar.
setInterval(() => {
  const next = logic.nextAutoFocus({
    agents: state.agents,
    selectedId: selectedAgent,
    enabled: autoFocusOpt.checked,
    now: Date.now(),
    lastKeyAt,
    selectedAt,
  });
  if (next) selectAgent(next);
}, 1000);

$('#btn-inbox').addEventListener('click', () => {
  const next = attentionQueue().find((a) => a.id !== selectedAgent) ?? attentionQueue()[0];
  if (next) selectAgent(next.id);
});

// ---------- render ----------

function renderAll(full = true) {
  office.selectedAgent = selectedAgent;
  office.selectedRoom = selectedRoom;
  // Terminais comuns não são funcionários: só aparecem nas abas.
  office.update(state.rooms, logic.officeAgents(state.agents));
  renderTabs();
  renderRoomInfo();
  renderInbox();
  renderExited();
  if (full) renderActivity();
}

function renderTabs() {
  const nav = $('#tabs');
  nav.replaceChildren();
  for (const a of roomAgents(selectedRoom)) {
    const tab = document.createElement('button');
    tab.className = `tab ${a.id === selectedAgent ? 'active' : ''} ${a.status}`;
    tab.title = a.activity;
    tab.innerHTML =
      a.kind === 'shell'
        ? `<span class="prompt-icon">&gt;_</span>`
        : `<span class="dot" style="background:${STATUS_COLOR[a.status]}"></span>`;
    const name = document.createElement('span');
    name.textContent = a.name;
    tab.appendChild(name);
    if (a.worktreeBranch) {
      const b = document.createElement('small');
      b.textContent = '⎇';
      b.title = a.worktreeBranch;
      tab.appendChild(b);
    }
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.title = a.kind === 'shell' ? 'Fechar terminal' : 'Demitir (encerra a sessão)';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      if (a.kind === 'shell') closeShell(a);
      else fireAgent(a);
    });
    tab.appendChild(close);
    tab.addEventListener('click', () => selectAgent(a.id));
    nav.appendChild(tab);
  }
  if (selectedRoom) {
    const add = document.createElement('button');
    add.className = 'tab add';
    add.textContent = '+';
    add.title = 'Contratar agente';
    add.addEventListener('click', () => openAgentDialog(selectedRoom!));
    const shell = document.createElement('button');
    shell.className = 'tab add';
    shell.textContent = '>_';
    shell.title = 'Novo terminal (Alt+T)';
    shell.addEventListener('click', () => openShell(selectedRoom!));
    nav.append(add, shell);
  }
  $('#placeholder').hidden = !!selectedAgent;
}

function renderExited() {
  const agent = state.agents.find((a) => a.id === selectedAgent);
  const box = $('#exited');
  box.hidden = agent?.status !== 'exited';
  if (agent?.status === 'exited') {
    $('#btn-resume').textContent = logic.resumeLabel(agent);
    $('#exited-text').textContent = logic.exitedMessage(agent);
  }
}

function renderInbox() {
  const q = attentionQueue();
  const btn = $('#btn-inbox');
  btn.hidden = q.length === 0;
  btn.textContent = `🔔 ${q.length} ${q.length === 1 ? 'aguardando' : 'aguardando'}`;
  document.title = q.length ? `(${q.length}) AI Office` : 'AI Office';
}

function renderRoomInfo() {
  const box = $('#room-info');
  const room = state.rooms.find((r) => r.id === selectedRoom);
  box.replaceChildren();
  if (!room) return;
  const agent = state.agents.find((a) => a.id === selectedAgent);
  box.innerHTML = `
    <div class="room-title"></div>
    <div class="room-path"></div>
    <div class="agent-line"></div>
    <div class="room-actions">
      <button class="btn small" data-act="hire">+ Agente</button>
      <button class="btn small" data-act="shell">&gt;_ Terminal</button>
      <button class="btn small ghost" data-act="remove">Fechar sala</button>
    </div>`;
  box.querySelector('.room-title')!.textContent = room.name;
  box.querySelector('.room-path')!.textContent = agent?.worktreeBranch ? agent.cwd : room.path;
  box.querySelector('.agent-line')!.textContent = agent ? `${agent.name}: ${agent.activity}` : '';
  box.querySelector('[data-act=hire]')!.addEventListener('click', () => openAgentDialog(room.id));
  box.querySelector('[data-act=shell]')!.addEventListener('click', () => openShell(room.id));
  box.querySelector('[data-act=remove]')!.addEventListener('click', () => closeRoom(room));
}

// ---------- atividade ----------

function activityVisible(e: ActivityEvent) {
  return activityScope === 'all' || e.roomId === selectedRoom;
}

function activityItem(e: ActivityEvent) {
  const li = document.createElement('li');
  li.className = e.kind;
  const agent = state.agents.find((a) => a.id === e.agentId);
  const room = state.rooms.find((r) => r.id === e.roomId);
  const time = new Date(e.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  li.innerHTML = `<time></time><b></b><span></span>`;
  li.querySelector('time')!.textContent = time;
  li.querySelector('b')!.textContent = activityScope === 'all' && room ? `${agent?.name ?? '?'} · ${room.name}` : (agent?.name ?? '?');
  li.querySelector('span')!.textContent = e.text;
  if (agent) li.addEventListener('click', () => selectAgent(agent.id));
  return li;
}

function renderActivity() {
  const list = $('#activity');
  list.replaceChildren(...state.activity.filter(activityVisible).slice(-150).reverse().map(activityItem));
}

function appendActivity(e: ActivityEvent) {
  if (!activityVisible(e)) return;
  const list = $('#activity');
  list.prepend(activityItem(e));
  while (list.children.length > 150) list.lastChild!.remove();
}

document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    activityScope = b.dataset.scope as 'room' | 'all';
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    renderActivity();
  }),
);

// ---------- git ----------

let gitTimer: number | undefined;
function scheduleGitRefresh() {
  clearTimeout(gitTimer);
  gitTimer = window.setTimeout(refreshGit, 1500);
}

/** Pasta do git mostrado: a do agente selecionado (o worktree dele, se houver) ou a da sala. */
function gitBase(): string {
  return selectedAgent ? `/api/agents/${selectedAgent}` : selectedRoom ? `/api/rooms/${selectedRoom}` : '';
}

let lastGit: { base: string; info: GitInfo } | undefined;

async function refreshGit() {
  const box = $('#git');
  const base = gitBase();
  if (!base) {
    box.replaceChildren();
    lastGit = undefined;
    return;
  }
  try {
    const info = (await (await fetch(`${base}/git`)).json()) as GitInfo;
    // Você pode ter trocado de agente enquanto a resposta vinha.
    if (base !== gitBase()) return;
    lastGit = { base, info };
    renderGit(info);
  } catch {
    if (base === gitBase()) box.textContent = 'Não foi possível ler o git.';
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function fileRows(files: FileChange[], scope: DiffScope) {
  return files
    .map((f) => {
      const slash = f.path.lastIndexOf('/');
      const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
      const name = f.path.slice(slash + 1);
      const nums =
        f.additions === undefined
          ? '<span class="muted">bin</span>'
          : `${f.additions ? `<span class="add">+${f.additions}</span>` : ''}${f.deletions ? `<span class="del">−${f.deletions}</span>` : ''}`;
      const active = diffOpen?.scope === scope && diffOpen.path === f.path ? ' active' : '';
      return `<button class="file${active}" data-scope="${scope}" data-path="${esc(f.path)}" title="${esc(f.path)}">
        <span class="st st-${esc(f.status[0])}">${esc(f.status)}</span><span class="name"><span class="dir">${esc(dir)}</span>${esc(name)}</span><span class="nums">${nums}</span>
      </button>`;
    })
    .join('');
}

function renderGit(info: GitInfo) {
  const box = $('#git');
  if (!info.isRepo) {
    box.innerHTML = '<p class="muted">Esta pasta não é um repositório git.</p>';
    return;
  }
  const sync = [info.ahead ? `↑${info.ahead}` : '', info.behind ? `↓${info.behind}` : ''].filter(Boolean).join(' ');
  const files = info.files ?? [];
  const branchFiles = info.branchFiles ?? [];
  const total = (list: FileChange[]) => {
    const add = list.reduce((n, f) => n + (f.additions ?? 0), 0);
    const del = list.reduce((n, f) => n + (f.deletions ?? 0), 0);
    return `${add ? `<span class="add">+${add}</span>` : ''}${del ? `<span class="del">−${del}</span>` : ''}`;
  };
  box.innerHTML = `
    <div class="branch">⎇ ${esc(info.branch ?? '?')} <span class="muted">${sync}</span></div>
    <div class="git-section">
      <h4>Não commitado <span class="count">${files.length}</span>${files.length ? `<span class="nums">${total(files)}</span>` : ''}</h4>
      ${files.length ? fileRows(files, 'working') : '<div class="muted empty">Nada modificado</div>'}
    </div>
    ${
      info.base
        ? `<div class="git-section">
      <h4>Na branch, desde <code>${esc(info.base)}</code> <span class="count">${info.branchCommits ?? 0} commit${info.branchCommits === 1 ? '' : 's'}</span>${branchFiles.length ? `<span class="nums">${total(branchFiles)}</span>` : ''}</h4>
      ${branchFiles.length ? fileRows(branchFiles, 'branch') : '<div class="muted empty">Nenhum arquivo diferente da base</div>'}
    </div>`
        : ''
    }
    <details>
      <summary>Últimos commits</summary>
      ${(info.commits ?? []).map((c) => `<div class="commit"><code>${esc(c.hash)}</code> ${esc(c.subject)} <span class="muted">${esc(c.when)}</span></div>`).join('')}
    </details>`;
}

$('#git').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.file');
  if (btn) openDiff(btn.dataset.scope as DiffScope, btn.dataset.path!);
});

// ---------- visualizador de diff ----------

let diffOpen: { scope: DiffScope; path: string } | undefined;

/** Arquivos do mesmo escopo, na ordem do painel: para os botões anterior/próximo. */
function diffSiblings(scope: DiffScope): FileChange[] {
  return (scope === 'branch' ? lastGit?.info.branchFiles : lastGit?.info.files) ?? [];
}

async function openDiff(scope: DiffScope, file: string) {
  const base = gitBase();
  if (!base) return;
  diffOpen = { scope, path: file };
  const view = $('#diff-view');
  view.hidden = false;
  $('#diff-path').textContent = file;
  $('#diff-scope').textContent = scope === 'branch' ? `na branch, desde ${lastGit?.info.base ?? 'a base'}` : 'não commitado';
  $('#diff-stats').replaceChildren();
  $('#diff-body').innerHTML = '<p class="diff-msg">Carregando…</p>';
  const siblings = diffSiblings(scope);
  const i = siblings.findIndex((f) => f.path === file);
  $<HTMLButtonElement>('#diff-prev').disabled = i <= 0;
  $<HTMLButtonElement>('#diff-next').disabled = i < 0 || i >= siblings.length - 1;
  $('#diff-pos').textContent = i >= 0 ? `${i + 1} de ${siblings.length}` : '';
  if (lastGit) renderGit(lastGit.info);

  try {
    const res = await fetch(`${base}/diff?scope=${scope}&path=${encodeURIComponent(file)}`);
    const data = await res.json();
    if (diffOpen?.path !== file || diffOpen.scope !== scope) return;
    if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
    const fd = data as FileDiff;
    renderDiff($('#diff-body'), fd);
    const { additions, deletions } = countChanges(parseDiff(fd.diff));
    $('#diff-stats').innerHTML = fd.binary ? '<span class="muted">binário</span>' : `<span class="add">+${additions}</span><span class="del">−${deletions}</span>`;
    $('#diff-body').scrollTop = 0;
  } catch (err) {
    $('#diff-body').innerHTML = '';
    $('#diff-body').append(Object.assign(document.createElement('p'), { className: 'diff-msg', textContent: (err as Error).message }));
  }
}

function closeDiff() {
  if (!diffOpen) return;
  diffOpen = undefined;
  $('#diff-view').hidden = true;
  if (lastGit) renderGit(lastGit.info);
  if (selectedAgent) terminals.show(selectedAgent);
}

function stepDiff(delta: number) {
  if (!diffOpen) return;
  const siblings = diffSiblings(diffOpen.scope);
  const next = siblings[siblings.findIndex((f) => f.path === diffOpen!.path) + delta];
  if (next) openDiff(diffOpen.scope, next.path);
}

$('#diff-close').addEventListener('click', closeDiff);
$('#diff-prev').addEventListener('click', () => stepDiff(-1));
$('#diff-next').addEventListener('click', () => stepDiff(1));
window.addEventListener('keydown', (e) => {
  if (!diffOpen || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') closeDiff();
  else if (e.key === 'ArrowDown' && e.altKey) stepDiff(1);
  else if (e.key === 'ArrowUp' && e.altKey) stepDiff(-1);
  else return;
  e.preventDefault();
});

$('#btn-git-refresh').addEventListener('click', refreshGit);
setInterval(() => !document.hidden && refreshGit(), 15000);

// ---------- ações ----------

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
  return data;
}

function formDialog(dlg: HTMLDialogElement, onSubmit: (data: FormData) => Promise<void>) {
  const form = dlg.querySelector('form')!;
  const error = dlg.querySelector<HTMLElement>('.error')!;
  form.addEventListener('submit', async (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== 'ok') return;
    e.preventDefault();
    error.hidden = true;
    try {
      await onSubmit(new FormData(form));
      dlg.close();
      form.reset();
    } catch (err) {
      error.textContent = (err as Error).message;
      error.hidden = false;
    }
  });
}

const dlgRoom = $<HTMLDialogElement>('#dlg-room');
/** Vaga do prédio escolhida no "+" do mapa; sem ela, o servidor escolhe uma encostada no prédio. */
let newRoomCell: Cell | undefined;
formDialog(dlgRoom, async (data) => {
  const room = (await api('POST', '/api/rooms', { path: data.get('path'), name: data.get('name'), pos: newRoomCell })) as Room;
  upsert(state.rooms, room);
  selectedRoom = room.id;
  selectedAgent = undefined;
  renderAll();
  office.reveal(room.id);
});
$('#btn-add-room').addEventListener('click', () => openRoomDialog());

async function openRoomDialog(cell?: Cell) {
  newRoomCell = cell;
  $('#dlg-room-where').textContent = cell ? 'A sala vai ocupar a vaga que você clicou no prédio.' : 'A sala vai para uma vaga livre encostada no prédio.';
  dlgRoom.querySelector<HTMLElement>('.error')!.hidden = true;
  dlgRoom.showModal();
  try {
    const projects = (await api('GET', '/api/projects')) as { path: string }[];
    $('#projects').replaceChildren(
      ...projects.map((p) => {
        const o = document.createElement('option');
        o.value = p.path;
        return o;
      }),
    );
  } catch {}
}

// O servidor abre o seletor de pastas nativo do sistema e devolve o caminho escolhido.
$('#btn-browse').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('#btn-browse');
  const input = dlgRoom.querySelector<HTMLInputElement>('input[name=path]')!;
  const error = dlgRoom.querySelector<HTMLElement>('.error')!;
  btn.disabled = true;
  btn.textContent = 'Aguardando…';
  error.hidden = true;
  try {
    const { path } = (await api('POST', '/api/pick-folder', { start: input.value || undefined })) as { path: string | null };
    if (path) {
      input.value = path;
      const name = dlgRoom.querySelector<HTMLInputElement>('input[name=name]')!;
      if (!name.value) name.placeholder = path.split(/[\\/]/).filter(Boolean).pop() ?? '';
    }
  } catch (err) {
    error.textContent = (err as Error).message;
    error.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '📁 Procurar…';
  }
});

const dlgAgent = $<HTMLDialogElement>('#dlg-agent');
let agentRoom = '';
formDialog(dlgAgent, async (data) => {
  const agent = (await api('POST', '/api/agents', {
    roomId: agentRoom,
    name: data.get('name'),
    worktree: data.get('worktree') === 'on',
  })) as Agent;
  upsert(state.agents, agent);
  selectAgent(agent.id);
});
function openAgentDialog(roomId: string) {
  agentRoom = roomId;
  $('#dlg-agent-room').textContent = `Sala: ${state.rooms.find((r) => r.id === roomId)?.name ?? ''}`;
  dlgAgent.querySelector<HTMLElement>('.error')!.hidden = true;
  dlgAgent.showModal();
}

function confirmDialog(title: string, text: string): Promise<boolean> {
  const dlg = $<HTMLDialogElement>('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

async function openShell(roomId: string) {
  const shell = (await api('POST', '/api/shells', { roomId })) as Agent;
  upsert(state.agents, shell);
  selectAgent(shell.id);
}

/** Fecha direto se o shell está parado; pergunta se tem algo rodando nele (ex.: npm run dev). */
async function closeShell(a: Agent) {
  if (a.status !== 'exited') {
    const { busy } = (await api('GET', `/api/agents/${a.id}/busy`)) as { busy: boolean };
    if (busy && !(await confirmDialog(`Fechar ${a.name}?`, 'Tem um programa rodando nesse terminal. Ele será encerrado.'))) return;
  }
  await api('DELETE', `/api/agents/${a.id}`);
}

async function fireAgent(a: Agent) {
  const running = a.status !== 'exited';
  const ok = await confirmDialog(
    `Demitir ${a.name}?`,
    `${running ? 'A sessão será encerrada. ' : ''}O histórico da conversa continua em ~/.claude.${a.worktreeBranch ? ` O worktree (${a.worktreeBranch}) não é apagado.` : ''}`,
  );
  if (ok) await api('DELETE', `/api/agents/${a.id}`);
}

async function closeRoom(room: Room) {
  const n = roomAgents(room.id).filter((a) => a.status !== 'exited').length;
  const ok = await confirmDialog(`Fechar a sala ${room.name}?`, n ? `${n} agente(s) em atividade serão encerrados. Os arquivos do projeto não são tocados.` : 'Os arquivos do projeto não são tocados.');
  if (ok) await api('DELETE', `/api/rooms/${room.id}`);
}

$('#btn-resume').addEventListener('click', async () => {
  if (!selectedAgent) return;
  const id = selectedAgent;
  terminals.remove(id);
  await api('POST', `/api/agents/${id}/resume`);
  selectAgent(id);
});

// ---------- avisos ----------

function toast(text: string, kind: string, onClick: () => void) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  el.addEventListener('click', () => {
    onClick();
    el.remove();
  });
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function notify(title: string, body: string, agentId: string) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag: agentId });
  n.onclick = () => {
    window.focus();
    selectAgent(agentId);
    n.close();
  };
}

$('#btn-notify').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('Este navegador não suporta notificações', 'idle', () => {});
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'Notificações ativadas' : 'Notificações bloqueadas pelo navegador', 'idle', () => {});
});

// Atalhos: Alt+1..9 troca de aba, Alt+N vai para o próximo da fila.
window.addEventListener(
  'keydown',
  (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^Digit[1-9]$/.test(e.code)) {
      const a = roomAgents(selectedRoom)[Number(e.code.slice(5)) - 1];
      if (a) {
        e.preventDefault();
        selectAgent(a.id);
      }
    } else if (e.code === 'KeyT' && selectedRoom) {
      e.preventDefault();
      openShell(selectedRoom);
    } else if (e.code === 'KeyN') {
      e.preventDefault();
      $('#btn-inbox').click();
    }
  },
  true,
);

// ---------- divisor entre escritório e terminal ----------

const officeEl = $('#office');
try {
  const h = localStorage.getItem('officeHeight');
  if (h) officeEl.style.height = h;
} catch {}
$('#splitter').addEventListener('pointerdown', (e) => {
  const startY = e.clientY;
  const startH = officeEl.getBoundingClientRect().height;
  const move = (ev: PointerEvent) => {
    officeEl.style.height = `${Math.max(80, Math.min(window.innerHeight - 200, startH + ev.clientY - startY))}px`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    try {
      localStorage.setItem('officeHeight', officeEl.style.height);
    } catch {}
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
});

document.fonts?.ready.then(() => renderAll());
connect();
