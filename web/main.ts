import type { ActivityEvent, Agent, ClientMsg, Project, DiffScope, FileChange, FileDiff, Floor, GitInfo, Incident, MemoryStatus, OfficeState, Room, ServerMsg, WorktreeStatus } from '../shared/types.ts';
import { type MentionSuggestion, type Participant, applyMention, mentionQuery, mentionSuggestions } from '../shared/incident.ts';
import { windowsSteps } from '../shared/memory.ts';
import { type PendingRequest, alwaysLabel, requestSummary } from '../shared/permissions.ts';
import { MODEL_SUGGESTIONS, modelsLabel } from '../shared/models.ts';
import { FLOOR_COLORS, type Cell } from '../shared/building.ts';
import { countChanges, parseDiff, renderDiff } from './diff.ts';
import { Explorer, type ExplorerTarget } from './files.ts';
import * as logic from './logic.ts';
import { Office, STATUS_COLOR, hash } from './office.ts';
import { characterFor, type Manifest } from './sprites.ts';
import { Terminals, uiFontSize } from './terminals.ts';
import { UsagePanel } from './usage.ts';
import { type UsageSummary, formatTokens, formatUsd } from '../shared/usage.ts';
import './styles.css';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const state: OfficeState = { floors: [], rooms: [], agents: [], activity: [], incidents: [] };
/** Pedidos (permissões e perguntas) esperando resposta no escritório. */
let requests: PendingRequest[] = [];
/** Andar na tela: o id de um Floor, ou logic.TERREO. */
let currentFloor: string = (() => {
  try {
    return localStorage.getItem('floor') ?? '';
  } catch {
    return '';
  }
})();
let selectedRoom: string | undefined;
let selectedAgent: string | undefined;
/** Consumo da janela do plano, para a linha do projeto no painel da direita (atualizado a cada minuto). */
let windowUsage: UsageSummary | undefined;
/** Projeto escolhido em cada sala: é o que o git, o explorador e o terminal da sala mostram. */
const roomProjectSel = new Map<string, string>();
/** Sala de guerra selecionada no andar da tela: as abas viram os participantes e o painel vira o chat. */
let selectedWar: number | undefined;
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
      if (!state.floors.some((f) => f.id === currentFloor) && currentFloor !== logic.TERREO) currentFloor = state.floors[0]?.id ?? logic.TERREO;
      if (!selectedRoom || !state.rooms.some((r) => r.id === selectedRoom)) selectedRoom = floorRooms()[0]?.id;
      renderAll();
      refreshGit();
      break;
    case 'memory':
      memory = msg.memory;
      renderMemory();
      break;
    case 'floor':
      upsert(state.floors, msg.floor);
      state.floors.sort((a, b) => a.order - b.order);
      renderAll();
      break;
    case 'floorRemoved':
      state.floors = state.floors.filter((f) => f.id !== msg.id);
      if (currentFloor === msg.id) goToFloor(state.floors[0]?.id ?? logic.TERREO);
      renderAll();
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
      if (selectedAgent === msg.id) selectAgent(currentTabs()[0]?.id);
      renderAll();
      break;
    case 'incident':
      upsert(state.incidents, msg.incident);
      renderAll(false);
      break;
    case 'incidentRemoved':
      state.incidents = state.incidents.filter((i) => i.id !== msg.id);
      renderAll(false);
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
    case 'requests':
      requests = msg.requests;
      renderRequestCard();
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
  onSelectWarRoom: (slot) => selectWar(slot),
  onAddWarRoom: () => addWarRoom(),
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

// Explorador (aba 📁 da sala): arquivos com editor e histórico do git.
const explorer = new Explorer({
  api,
  confirm: confirmDialog,
  onShow: () => {
    closeDiff();
    // O modo Git do explorador mostra o git da pasta dele, com o diff na área principal.
    $('#git-main').append($('#diff-view'));
    renderWarPanel();
    refreshGit();
  },
  onHide: () => {
    closeDiff();
    $('#terminals').before($('#diff-view'));
    renderWarPanel();
    if (selectedAgent) terminals.show(selectedAgent);
    refreshGit();
  },
  onTabChange: renderTabs,
  // O diff aberto é o do modo Git: fora dele, nem Esc nem Alt+↑/↓ mexem nele.
  onModeChange: (mode) => {
    if (mode !== 'git') closeDiff();
    // A pasta pode ter mudado (outra aba de explorador) ou ter arquivos salvos no editor.
    refreshGit();
  },
});

/** A pasta da sala selecionada ou, com `worktree`, a do worktree do agente selecionado, se ele tem um. */
function explorerTarget(worktree: boolean): ExplorerTarget | undefined {
  const agent = worktree ? state.agents.find((a) => a.id === selectedAgent && a.worktreeBranch) : undefined;
  const room = state.rooms.find((r) => r.id === (agent?.roomId ?? selectedRoom));
  if (!room) return undefined;
  if (agent) {
    return { base: `/api/agents/${agent.id}`, roomId: room.id, tab: `Arquivos · ${agent.name}`, label: `${room.name} · worktree de ${agent.name} (${agent.worktreeBranch})` };
  }
  // Com um agente da sala selecionado, a pasta é a do projeto dele; senão, a do projeto escolhido.
  const selected = state.agents.find((a) => a.id === selectedAgent && a.roomId === room.id);
  const folder = logic.roomFolder(room, selected?.projectId ?? roomProjectSel.get(room.id));
  const multi = (room.projects?.length ?? 0) > 1;
  const project = logic.roomProject(room, selected?.projectId ?? roomProjectSel.get(room.id));
  return { base: folder.base, roomId: room.id, tab: multi && project ? `Arquivos · ${project.name}` : 'Arquivos', label: folder.label };
}

function roomAgents(roomId?: string) {
  return logic.roomAgents(state.agents, roomId);
}

function floorRooms(floorId = currentFloor) {
  return logic.roomsOnFloor(state.rooms, floorId);
}

/** Pega o elevador: mostra outro andar. A sala e o agente selecionados continuam os mesmos. */
function goToFloor(floorId: string) {
  if (floorId === currentFloor) return;
  currentFloor = floorId;
  // A sala de guerra selecionada era a do outro andar.
  selectedWar = undefined;
  try {
    localStorage.setItem('floor', floorId);
  } catch {}
  renderAll();
}

function selectRoom(roomId: string) {
  if (selectedRoom === roomId && selectedWar === undefined) return;
  selectedRoom = roomId;
  selectedWar = undefined;
  // A aba do explorador é de outra sala: a sala nova mostra o terminal dela.
  if (explorer.tab()?.roomId !== roomId) explorer.hide();
  const floor = state.rooms.find((r) => r.id === roomId)?.floorId;
  if (floor && floor !== currentFloor) goToFloor(floor);
  const first = roomAgents(roomId).find((a) => a.status !== 'exited') ?? roomAgents(roomId)[0];
  selectAgent(first?.id);
}

function selectAgent(id?: string) {
  // Quem terminou só sai da fila quando você responde ou troca de aba depois de olhar.
  if (selectedAgent && selectedAgent !== id) markSeen(selectedAgent);
  if (id !== selectedAgent) {
    selectedAt = Date.now();
    closeDiff();
    explorer.hide();
  }
  selectedAgent = id;
  const agent = state.agents.find((a) => a.id === id);
  if (agent) {
    selectedRoom = agent.roomId;
    // Agente de outro andar (pelas abas, avisos ou "aguardando"): o elevador leva até lá.
    const floor = logic.floorOfAgent(agent, state.rooms);
    if (floor && floor !== currentFloor) goToFloor(floor);
    // Quem está num incidente está na sala de guerra: as abas e o painel são os de lá.
    const incident = state.incidents.find((i) => i.id === agent.incidentId);
    selectedWar = incident?.floorId === currentFloor ? incident.slot : undefined;
    if (selectedWar !== undefined) office.revealWar(selectedWar);
    else office.reveal(agent.roomId);
  }
  // Mesmo encerrado o terminal aparece: o que o processo mostrou ao sair fica visível.
  if (agent) terminals.show(agent.id);
  else terminals.hideAll();
  renderAll();
  refreshGit();
}

/** Abas da tela: os participantes da sala de guerra selecionada, ou os agentes da sala. */
function currentTabs(): Agent[] {
  if (selectedWar !== undefined) return logic.warTabs(currentIncident(), state.agents);
  return logic.roomTabs(state.agents, selectedRoom);
}

function currentIncident(): Incident | undefined {
  return selectedWar === undefined ? undefined : logic.incidentAt(state.incidents, currentFloor, selectedWar);
}

function selectWar(slot: number) {
  selectedWar = slot;
  selectedRoom = undefined;
  const people = logic.incidentAgents(currentIncident(), state.agents);
  const first = people.find((a) => a.status !== 'exited') ?? people[0];
  if (first) selectAgent(first.id);
  else {
    if (selectedAgent) markSeen(selectedAgent);
    selectedAgent = undefined;
    terminals.hideAll();
    renderAll();
  }
  office.revealWar(slot);
}

/** "+" em cima da última sala de guerra: o andar ganha mais uma. */
async function addWarRoom() {
  const floor = state.floors.find((f) => f.id === currentFloor);
  if (!floor) return;
  const n = logic.warRoomsOf(floor);
  const updated = (await api('PATCH', `/api/floors/${floor.id}`, { warRooms: n + 1 })) as Floor;
  upsert(state.floors, updated);
  selectWar(n);
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
  // Só dentro do andar em que você está: os outros andares só avisam (bolinha no elevador).
  const next = logic.nextAutoFocus({
    agents: logic.agentsOnFloor(state.agents, state.rooms, currentFloor),
    selectedId: selectedAgent,
    enabled: autoFocusOpt.checked,
    now: Date.now(),
    lastKeyAt,
    selectedAt,
    exploring: explorer.isShown(),
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
  office.selectedRoom = selectedWar === undefined ? selectedRoom : undefined;
  office.selectedWar = selectedWar;
  // Terminais comuns não são funcionários: só aparecem nas abas.
  const floor = state.floors.find((f) => f.id === currentFloor);
  office.update(
    floor ? { id: floor.id, kind: 'andar', color: floor.color, warRooms: logic.warRoomsOf(floor) } : { id: logic.TERREO, kind: 'terreo', color: '#7aa2f7' },
    floorRooms(),
    logic.officeAgents(logic.agentsOnFloor(state.agents, state.rooms, currentFloor)),
    state.incidents,
  );
  renderWarPanel();
  renderElevator();
  renderCounters();
  renderDirectory();
  renderTabs();
  renderRoomInfo();
  renderModelsPanel();
  renderRoomUsage();
  renderAgentDetails();
  renderSquadBoard();
  renderInbox();
  renderExited();
  renderRequestCard();
  renderTermKeys();
  if (full) renderActivity();
}

/** O que as abas mostram (sem a atividade, que vai no title e muda o tempo todo). */
let tabsKey = '';

/**
 * Botões à direita das abas: contratar, terminal e arquivos (git e histórico). Na sala de guerra,
 * o "+" chama mais gente e o terminal é o da sala de guerra. Os botões são fixos (só mudam o
 * texto e o que fazem), para um clique nunca cair num botão que acabou de ser trocado.
 */
function renderTabActions() {
  const war = selectedWar !== undefined;
  const incident = war ? currentIncident() : undefined;
  const room = !war && !!selectedRoom;
  const hire = $<HTMLButtonElement>('#act-hire');
  const shell = $<HTMLButtonElement>('#act-shell');
  const files = $<HTMLButtonElement>('#act-files');
  $('#tab-actions').hidden = !room && !incident;
  hire.querySelector('.lbl')!.textContent = war ? ' Chamar' : ' Agente';
  hire.title = war ? 'Chamar mais gente para a sala de guerra' : 'Contratar agente';
  shell.title = war ? 'Novo terminal da sala de guerra (Alt+T)' : 'Novo terminal (Alt+T)';
  files.hidden = !room;
  // Com um agente num worktree selecionado, os arquivos e o git são os do worktree dele.
  const wt = state.agents.find((a) => a.id === selectedAgent && a.worktreeBranch);
  files.title = wt ? `Arquivos, histórico e git do worktree de ${wt.name}` : 'Arquivos e histórico da sala';
}

$('#act-hire').addEventListener('click', () => {
  if (selectedWar !== undefined) return void (currentIncident() && openIncidentDialog('call'));
  if (selectedRoom) openAgentDialog(selectedRoom);
});
$('#act-shell').addEventListener('click', () => {
  const incident = selectedWar !== undefined ? currentIncident() : undefined;
  if (incident) void openWarShell(incident.id);
  else if (selectedRoom && selectedWar === undefined) void openShell(selectedRoom);
});
$('#act-files').addEventListener('click', () => explorer.show(explorerTarget(true)));

function renderTabs() {
  renderTabActions();
  const nav = $('#tabs');
  const tabs = currentTabs();
  const files = explorer.tab();
  // Só recria os botões quando algo das abas muda: recriar a cada atualização de agente fazia um
  // clique cair num botão que acabou de ser trocado (e não pegar).
  const key = JSON.stringify([
    tabs.map((a) => [a.id, a.name, a.status, a.kind, a.worktreeBranch, a.projectId]),
    selectedAgent,
    selectedRoom,
    selectedWar,
    currentIncident()?.id,
    explorer.isShown(),
    files && [files.roomId, files.tab, files.label],
  ]);
  if (key === tabsKey) {
    for (const a of tabs) {
      const tab = nav.querySelector<HTMLElement>(`.tab[data-id="${a.id}"]`);
      if (tab) tab.title = a.activity;
    }
    return;
  }
  tabsKey = key;
  nav.replaceChildren();
  for (const a of tabs) {
    const tab = document.createElement('button');
    tab.className = `tab ${a.id === selectedAgent && !explorer.isShown() ? 'active' : ''} ${a.status}`;
    tab.dataset.id = a.id;
    tab.title = a.activity;
    tab.innerHTML =
      a.kind === 'shell'
        ? `<span class="prompt-icon">&gt;_</span>`
        : `<span class="dot" style="background:${STATUS_COLOR[a.status]}"></span>`;
    const name = document.createElement('span');
    name.textContent = a.name;
    tab.appendChild(name);
    // Numa sala com vários projetos, a aba diz em qual o agente trabalha.
    const tabRoom = state.rooms.find((r) => r.id === a.roomId);
    if (a.kind !== 'shell' && (tabRoom?.projects?.length ?? 0) > 1) {
      const p = document.createElement('small');
      p.className = 'tab-project';
      p.textContent = logic.agentProject(tabRoom, a)?.name ?? '';
      tab.appendChild(p);
    }
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
    tab.addEventListener('click', () => {
      explorer.hide();
      selectAgent(a.id);
    });
    nav.appendChild(tab);
  }
  if (files && selectedWar === undefined && files.roomId === selectedRoom) {
    const tab = document.createElement('button');
    tab.className = `tab files ${explorer.isShown() ? 'active' : ''}`;
    tab.title = files.label;
    tab.innerHTML = '<span class="files-icon">📁</span>';
    const name = document.createElement('span');
    name.textContent = files.tab;
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Fechar o explorador';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      explorer.closeTab();
    });
    tab.append(name, close);
    tab.addEventListener('click', () => explorer.show());
    nav.appendChild(tab);
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
  btn.innerHTML = `🔔 ${q.length}<span class="lbl"> aguardando</span>`;
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
    <div class="room-projects"></div>
    <div class="agent-line"></div>
    <div class="room-actions">
      <button class="btn small ghost" data-act="projects" title="Resumo do sistema e fichas dos projetos">Projetos</button>
      <button class="btn small ghost" data-act="remove">Fechar sala</button>
    </div>
    <label class="move-room">Andar <select data-act="move"></select></label>`;
  box.querySelector('.room-title')!.textContent = room.name;
  const agentProject = agent?.kind !== 'shell' ? logic.agentProject(room, agent) : undefined;
  const shown = agentProject ?? logic.roomProject(room, roomProjectSel.get(room.id));
  box.querySelector('.room-path')!.textContent = agent?.worktreeBranch ? agent.cwd : agent ? agent.cwd : (shown?.path ?? room.path);
  // Os projetos da sala: o escolhido é o que o git, o explorador e o terminal mostram.
  const chips = box.querySelector<HTMLElement>('.room-projects')!;
  const projects = room.projects ?? [];
  chips.hidden = projects.length < 2;
  for (const p of projects) {
    const chip = document.createElement('button');
    chip.className = `chip${p.id === shown?.id ? ' active' : ''}`;
    chip.textContent = p.name;
    chip.title = p.summary || p.path;
    chip.addEventListener('click', () => {
      roomProjectSel.set(room.id, p.id);
      // Escolher um projeto mostra a pasta dele, e não a do agente que estava selecionado.
      if (selectedAgent) selectedAgent = undefined;
      renderAll();
    });
    chips.appendChild(chip);
  }
  const where = agentProject && projects.length > 1 ? ` (${agentProject.name})` : '';
  box.querySelector('.agent-line')!.textContent = agent ? `${agent.name}${where}: ${agent.activity}` : '';
  box.querySelector('[data-act=projects]')!.addEventListener('click', () => openProjectsDialog(room.id));
  box.querySelector('[data-act=remove]')!.addEventListener('click', () => closeRoom(room));
  const move = box.querySelector<HTMLSelectElement>('[data-act=move]')!;
  move.replaceChildren(...state.floors.map((f) => new Option(f.name, f.id, false, f.id === room.floorId)));
  move.addEventListener('change', async () => {
    const moved = (await api('POST', `/api/rooms/${room.id}/move`, { floorId: move.value })) as Room;
    upsert(state.rooms, moved);
    goToFloor(moved.floorId!);
    office.reveal(moved.id);
  });
}

// ---------- pedidos respondidos pelo escritório ----------

/** Pedido mostrado no cartão: redesenha só quando muda, para não apagar o que você está digitando. */
let requestKey = '';

function renderRequestCard() {
  const card = $('#request-card');
  const req = selectedWar === undefined ? logic.requestFor(selectedAgent, requests) : undefined;
  card.hidden = !req;
  if (!req) {
    requestKey = '';
    return;
  }
  if (req.id === requestKey) return;
  requestKey = req.id;
  const agent = state.agents.find((a) => a.id === req.agentId);
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const input = req.toolInput as Record<string, unknown>;
  const detail =
    req.kind === 'question'
      ? (req.questions ?? [])
          .map(
            (q, qi) => `<fieldset class="req-q" data-q="${qi}">
              <legend>${q.header ? `<b>${esc(q.header)}</b> · ` : ''}${esc(q.question)}</legend>
              ${q.options
                .map(
                  (o) => `<label class="req-opt"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q${qi}" value="${esc(o.label)}" />
                    <span>${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`,
                )
                .join('')}
              <input class="req-other" placeholder="Outra resposta (opcional)" />
            </fieldset>`,
          )
          .join('')
      : `<pre class="req-cmd">${esc(requestSummary(req))}</pre>${typeof input.description === 'string' ? `<p class="muted">${esc(input.description)}</p>` : ''}`;
  const always = req.kind === 'permission' ? alwaysLabel(req) : undefined;
  card.innerHTML = `
    <header><span class="req-hand">✋</span> <b>${esc(agent?.name ?? 'Agente')}</b> ${req.kind === 'question' ? 'tem uma pergunta' : 'pede permissão'}
      <small class="muted">também dá para responder no terminal; vale o que vier primeiro</small></header>
    ${detail}
    <div class="req-actions">
      <button class="btn small" data-act="allow">${req.kind === 'question' ? 'Responder' : 'Permitir'}</button>
      ${always ? `<button class="btn small ghost" data-act="always">${esc(always)}</button>` : ''}
      <button class="btn small ghost" data-act="deny">Negar…</button>
      <button class="btn small ghost" data-act="terminal" title="Tira o pedido do escritório; ele continua no terminal">Responder no terminal</button>
    </div>
    <div class="req-deny" hidden>
      <input class="req-reason" placeholder="Por quê? (opcional: vai para o agente)" />
      <label class="check"><input type="checkbox" class="req-interrupt" /> <span>Interromper o agente</span></label>
      <button class="btn small danger" data-act="deny-send">Negar</button>
    </div>
    <p class="error" hidden></p>`;
}

$('#request-card').addEventListener('click', async (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  const req = requests.find((r) => r.id === requestKey);
  if (!act || !req) return;
  const card = $('#request-card');
  const error = card.querySelector<HTMLElement>('.error')!;
  if (act === 'deny') {
    card.querySelector<HTMLElement>('.req-deny')!.hidden = false;
    card.querySelector<HTMLInputElement>('.req-reason')!.focus();
    return;
  }
  let body: unknown;
  if (act === 'terminal') {
    await api('DELETE', `/api/pedidos/${req.id}`).catch(() => undefined);
    return;
  }
  if (act === 'deny-send') {
    body = { behavior: 'deny', message: card.querySelector<HTMLInputElement>('.req-reason')!.value, interrupt: card.querySelector<HTMLInputElement>('.req-interrupt')!.checked };
  } else if (req.kind === 'question') {
    const chosen: Record<string, string[]> = {};
    const other: Record<string, string> = {};
    (req.questions ?? []).forEach((q, qi) => {
      const box = card.querySelector<HTMLElement>(`.req-q[data-q="${qi}"]`)!;
      chosen[q.question] = [...box.querySelectorAll<HTMLInputElement>('input[name^=q]:checked')].map((i) => i.value);
      other[q.question] = box.querySelector<HTMLInputElement>('.req-other')!.value;
    });
    const answers = logic.questionAnswers(req.questions ?? [], chosen, other);
    if (Object.keys(answers).length < (req.questions?.length ?? 0)) {
      error.textContent = 'Responda todas as perguntas (ou use Negar / Responder no terminal).';
      error.hidden = false;
      return;
    }
    body = { behavior: 'allow', answers };
  } else {
    body = { behavior: 'allow', always: act === 'always' };
  }
  try {
    await api('POST', `/api/pedidos/${req.id}/resposta`, body);
    // Volta o foco para o terminal: o agente continua dali.
    if (selectedAgent) terminals.show(selectedAgent);
  } catch (err) {
    error.textContent = (err as Error).message;
    error.hidden = false;
  }
});

// ---------- consumo ----------

const usagePanel = new UsagePanel(api, (roomId) => {
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room) return;
  if (room.floorId) goToFloor(room.floorId);
  selectRoom(room.id);
  office.reveal(room.id);
});

async function refreshWindowUsage() {
  try {
    windowUsage = (await api('GET', `/api/uso?from=${Date.now() - 5 * 3600_000}`)) as UsageSummary;
    renderRoomUsage();
  } catch {}
}
setInterval(() => !document.hidden && refreshWindowUsage(), 60_000);
void refreshWindowUsage();

// Esc fecha o painel de consumo (fora dos diálogos).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && usagePanel.isShown() && !document.querySelector('dialog[open]')) usagePanel.hide();
});

function renderRoomUsage() {
  const t = modelsTarget();
  const box = $('#room-usage');
  const u = t && logic.projectWindowUsage(windowUsage, t.project.id);
  box.hidden = !u;
  if (!u || !t) return;
  const until = new Date(u.end).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const name = (t.room.projects?.length ?? 0) > 1 ? t.project.name : 'esta sala';
  // Com o número oficial: quanto do plano já foi, e a parte deste projeto na janela.
  const plan = logic.planView(windowUsage?.plan, Date.now());
  const official = plan?.fiveHour ? `Plano: <b>${plan.fiveHour.pct}%</b> da janela de 5 h${plan.sevenDay ? ` · ${plan.sevenDay.pct}% da semana` : ''}. ` : '';
  box.innerHTML = `${official}Janela (até ${until}): <b>${formatTokens(u.tokens)}</b> tokens em ${name} · ${Math.round(u.share * 100)}% dela`;
}

// ---------- detalhes do agente ----------

interface AgentDetails {
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  cost: number;
  model?: string;
  replies: number;
  branch?: string;
  files: number;
  linesAdded: number;
  linesRemoved: number;
}
/** Detalhes que vêm do servidor (tokens, custo, git), por agente; lidos ao selecionar e a cada 30 s. */
const details = new Map<string, { at: number; data: AgentDetails }>();
let detailsLoading = '';

async function loadDetails(id: string) {
  if (detailsLoading === id) return;
  detailsLoading = id;
  try {
    details.set(id, { at: Date.now(), data: (await api('GET', `/api/agents/${id}/detalhes`)) as AgentDetails });
    renderAgentDetails();
  } catch {
  } finally {
    detailsLoading = '';
  }
}
setInterval(() => selectedAgent && !document.hidden && loadDetails(selectedAgent), 30_000);

/** Estado, pedido, tarefas com progresso, ajudantes, modelo, branch, linhas e tokens do agente. */
function renderAgentDetails() {
  const box = $('#agent-details');
  const a = selectedWar === undefined ? state.agents.find((x) => x.id === selectedAgent && x.kind !== 'shell') : undefined;
  box.hidden = !a;
  if (!a) return;
  const d = details.get(a.id);
  if (!d || Date.now() - d.at > 30_000) void loadDetails(a.id);
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const task = [...state.activity].reverse().find((e) => e.agentId === a.id && e.kind === 'prompt')?.text.replace(/^Pedido:\s*/, '');
  const todos = a.todos ?? [];
  const done = todos.filter((t) => t.status === 'completed').length;
  const shell = logic.shellBubble(a, Date.now());
  const row = (k: string, v: string) => `<div class="ad-row"><span>${k}</span><span>${v}</span></div>`;
  const info = d?.data;
  box.innerHTML = `
    <h3>${esc(a.name)} <small class="muted">${esc(logic.STATUS_TEXT[a.status])}</small></h3>
    ${task ? `<div>📝 ${esc(task)}</div>` : ''}
    ${shell ? `<div>⏳ ${esc(shell.long.replace(/^Esperando o shell: /, ''))}</div>` : ''}
    ${todos.length ? `<div class="ad-row"><span>Tarefas</span><span>${done}/${todos.length}</span></div><div class="ad-progress"><i style="width:${(done / todos.length) * 100}%"></i></div>
      <ul>${todos.map((t) => `<li class="${t.status}">${esc(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</li>`).join('')}</ul>` : ''}
    ${a.helpers?.length ? row('Ajudantes', esc(a.helpers.join(' · '))) : ''}
    ${row('Modelo', esc(info?.model ?? a.models ?? 'padrão da conta'))}
    ${info?.branch ? row('Branch', `${esc(info.branch)}${a.worktreeBranch ? ' (worktree)' : ''}`) : ''}
    ${info ? row('Alterado agora', info.files ? `${info.files} arquivo(s), <span style="color:var(--done)">+${info.linesAdded}</span> <span style="color:var(--danger)">−${info.linesRemoved}</span>` : 'nada') : ''}
    ${info ? row('Sessão', `${formatTokens(info.tokens.input + info.tokens.output + info.tokens.cacheWrite + info.tokens.cacheRead)} tokens · ${formatUsd(info.cost)} · ${info.replies} respostas`) : ''}`;
}

// ---------- modelos por projeto ----------

/** Projeto que o painel de modelos mostra: o do agente selecionado ou o escolhido na sala. */
function modelsTarget(): { room: Room; project: Project } | undefined {
  if (selectedWar !== undefined) return undefined;
  const room = state.rooms.find((r) => r.id === selectedRoom);
  if (!room) return undefined;
  const agent = state.agents.find((a) => a.id === selectedAgent && a.roomId === room.id && a.kind !== 'shell');
  const project = (agent && logic.agentProject(room, agent)) ?? logic.roomProject(room, roomProjectSel.get(room.id));
  return project && { room, project };
}

let modelsKey = '';
$('#model-suggestions').replaceChildren(...MODEL_SUGGESTIONS.map((m) => new Option('', m)));

function renderModelsPanel() {
  const t = modelsTarget();
  const panel = $('#models-panel');
  panel.hidden = !t;
  if (!t) return;
  const { room, project } = t;
  const form = $<HTMLFormElement>('#models-form');
  // Só preenche o formulário quando muda o projeto ou o que está salvo: não apaga o que você está digitando.
  const key = JSON.stringify([project.id, project.models]);
  if (key !== modelsKey && !form.contains(document.activeElement)) {
    modelsKey = key;
    $('#models-project').textContent = (room.projects?.length ?? 0) > 1 ? `· ${project.name}` : '';
    const m = project.models;
    const mode = m?.mode ?? 'padrao';
    form.querySelector<HTMLInputElement>(`input[name=mode][value=${mode}]`)!.checked = true;
    form.querySelector<HTMLInputElement>('input[name=model]')!.value = m?.model ?? '';
    form.querySelector<HTMLInputElement>('input[name=reasoning]')!.value = m?.reasoning ?? '';
    form.querySelector<HTMLInputElement>('input[name=execution]')!.value = m?.execution ?? '';
    $('#models-msg').textContent = '';
    showModelFields();
  }
  const stale = logic.staleModelAgents(room, project, state.agents);
  const note = $('#models-stale');
  note.hidden = !stale.length;
  note.textContent = stale.length
    ? `${stale.map((a) => a.name).join(', ')} ${stale.length === 1 ? 'abriu' : 'abriram'} com outros modelos (${stale[0].models ?? 'padrão da conta'}): a troca vale quando retomarem.`
    : '';
}

function showModelFields() {
  const mode = $<HTMLFormElement>('#models-form').querySelector<HTMLInputElement>('input[name=mode]:checked')?.value ?? 'padrao';
  for (const f of document.querySelectorAll<HTMLElement>('#models-form .models-field')) f.hidden = f.dataset.for !== mode;
}
$('#models-form').addEventListener('change', showModelFields);

$('#models-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = modelsTarget();
  if (!t) return;
  const data = new FormData(e.target as HTMLFormElement);
  const mode = String(data.get('mode') ?? 'padrao');
  const models =
    mode === 'unico'
      ? { mode, model: data.get('model') }
      : mode === 'duplo'
        ? { mode, reasoning: data.get('reasoning'), execution: data.get('execution') }
        : null;
  const msg = $('#models-msg');
  try {
    const room = (await api('PATCH', `/api/rooms/${t.room.id}/projects/${t.project.id}`, { models })) as Room;
    upsert(state.rooms, room);
    modelsKey = '';
    (document.activeElement as HTMLElement | null)?.blur();
    renderModelsPanel();
    msg.textContent = `Salvo: ${modelsLabel(logic.roomProject(room, t.project.id)?.models)}`;
  } catch (err) {
    msg.textContent = (err as Error).message;
  }
});

// ---------- quem está fazendo o quê ----------

/** Quadro da sala selecionada: cada agente com o projeto, o estado, o que está fazendo e há quanto tempo. */
function renderSquadBoard() {
  const room = selectedWar === undefined ? state.rooms.find((r) => r.id === selectedRoom) : undefined;
  const groups = room ? logic.squadBoard(room, state.agents, state.activity, Date.now()) : [];
  const box = $('#squad-board');
  box.hidden = !groups.length;
  const list = $('#squad-list');
  list.replaceChildren();
  for (const g of groups) {
    if (g.project) {
      const h = document.createElement('div');
      h.className = 'squad-project';
      h.textContent = g.project.name;
      h.title = g.project.path;
      list.appendChild(h);
    }
    for (const r of g.rows) {
      const a = r.agent;
      const row = document.createElement('div');
      row.className = `squad-row ${a.status}${a.id === selectedAgent ? ' selected' : ''}`;
      row.dataset.id = a.id;
      row.innerHTML = `
        <span class="dot" style="background:${STATUS_COLOR[a.status]}"></span>
        <span class="squad-main">
          <span class="squad-top"><b class="squad-name"></b><span class="squad-status"></span><span class="squad-since"></span></span>
          <span class="squad-task"></span>
          <span class="squad-doing"></span>
        </span>`;
      row.querySelector('.squad-name')!.textContent = a.name + (a.worktreeBranch ? ' ⎇' : '');
      row.querySelector('.squad-status')!.textContent = r.status;
      row.querySelector('.squad-since')!.textContent = r.since;
      row.querySelector('.squad-task')!.textContent = r.task;
      row.querySelector('.squad-doing')!.textContent = r.doing;
      row.title = [a.worktreeBranch && `Worktree: ${a.worktreeBranch}`, a.subagents ? `${a.subagents} ajudante(s)` : ''].filter(Boolean).join(' · ');
      list.appendChild(row);
    }
  }
}
// O quadro é redesenhado a cada atualização: o clique é pego no pointerdown, pela lista, para não se perder.
$('#squad-list').addEventListener('pointerdown', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.squad-row');
  if (row?.dataset.id) selectAgent(row.dataset.id);
});
// "há 3 min" anda sozinho.
setInterval(() => !document.hidden && renderSquadBoard(), 30_000);

// ---------- sala de guerra ----------

let warChatKey = '';

function renderWarPanel() {
  const floor = state.floors.find((f) => f.id === currentFloor);
  const war = selectedWar !== undefined && !!floor;
  $('#war-panel').hidden = !war;
  $('#room-info').hidden = war;
  if (!war) {
    warChatKey = '';
    return;
  }
  const slot = selectedWar!;
  const incident = currentIncident();
  const n = logic.warRoomsOf(floor);
  $('#war-title').textContent = incident ? incident.title : `Sala de guerra${n > 1 ? ` ${slot + 1}` : ''} · livre`;
  $('#war-desc').textContent = incident
    ? incident.description
    : 'Abra um incidente quando um problema atravessar projetos deste andar: cada agente investiga no próprio repositório e vocês conversam aqui.';
  $('#war-file').textContent = incident ? `Registro: ${incident.file}` : '';
  $('#war-file').title = incident?.file ?? '';
  $('#war-form').hidden = !incident;
  $('#war-open').hidden = !!incident;
  $('#war-call').hidden = !incident;
  $('#war-close').hidden = !incident;
  $('#war-remove').hidden = !logic.canRemoveWarRoom(floor, slot, state.incidents);

  const people = $('#war-people');
  people.replaceChildren(
    ...logic.incidentAgents(incident, state.agents).map((a) => {
      const b = document.createElement('button');
      b.className = `war-person${a.id === selectedAgent ? ' current' : ''}`;
      b.title = a.activity;
      b.innerHTML = `<span class="dot" style="background:${STATUS_COLOR[a.status]}"></span><span></span>`;
      b.lastElementChild!.textContent = `${a.name} · ${state.rooms.find((r) => r.id === a.roomId)?.name ?? '?'}`;
      b.addEventListener('click', () => selectAgent(a.id));
      return b;
    }),
  );

  // O chat só é redesenhado quando chega mensagem: senão o botão de repassar some debaixo do clique.
  const key = JSON.stringify([incident?.id, incident?.messages.at(-1)?.id, incident?.participants, state.agents.filter((a) => incident?.participants.includes(a.id)).map((a) => a.name)]);
  if (key === warChatKey) return;
  warChatKey = key;
  const chat = $('#war-chat');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.replaceChildren(
    ...(incident?.messages ?? []).map((m) => {
      const li = document.createElement('li');
      li.className = `msg ${m.kind}`;
      li.dataset.msg = String(m.id);
      const head = document.createElement('div');
      head.className = 'msg-head';
      const who = document.createElement('b');
      const to = m.to.length && m.kind === 'voce' ? ` → ${m.to.map((id) => state.agents.find((a) => a.id === id)?.name ?? '?').join(', ')}` : '';
      who.textContent = logic.chatAuthor(m, state.agents, state.rooms) + to;
      const time = document.createElement('time');
      time.textContent = new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      head.append(who, time);
      // Resposta de agente: só o card. O texto você lê no terminal dele (e fica no registro).
      if (m.kind === 'agente') {
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'msg-open';
        open.title = 'Abrir o terminal para ler a resposta';
        open.textContent = who.textContent;
        open.addEventListener('click', () => m.agentId && selectAgent(m.agentId));
        who.replaceChildren(open);
        li.append(head);
      } else {
        const text = document.createElement('div');
        text.className = 'msg-text';
        text.textContent = m.text;
        li.append(head, text);
      }
      if (incident && logic.canShare(m, incident)) {
        const share = document.createElement('button');
        share.className = 'btn small ghost share';
        share.textContent = 'Compartilhar com a sala';
        share.title = 'Repassa esta resposta para os outros agentes';
        share.addEventListener('click', async () => {
          share.disabled = true;
          await warAction(() => api('POST', `/api/incidents/${incident.id}/messages/${m.id}/share`));
        });
        li.append(share);
      }
      return li;
    }),
  );
  if (atBottom || !incident) chat.scrollTop = chat.scrollHeight;
}

/** Ações do painel: o erro (ex.: "@fulano" que não está na sala) aparece embaixo do chat. */
async function warAction(fn: () => Promise<unknown>) {
  const error = $('#war-error');
  error.hidden = true;
  try {
    await fn();
    return true;
  } catch (err) {
    error.textContent = (err as Error).message;
    error.hidden = false;
    return false;
  }
}

const warInput = $<HTMLTextAreaElement>('#war-input');
$('#war-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const incident = currentIncident();
  const text = warInput.value.trim();
  if (!incident || !text) return;
  if (await warAction(() => api('POST', `/api/incidents/${incident.id}/messages`, { text }))) warInput.value = '';
});
// ---------- auto-complete das menções (@agente, @projeto) ----------

const mentionBox = $('#war-mentions');
let mentionItems: MentionSuggestion[] = [];
let mentionIndex = 0;

function warPeople(): Participant[] {
  return logic.incidentAgents(currentIncident(), state.agents).map((a) => ({ id: a.id, name: a.name, project: state.rooms.find((r) => r.id === a.roomId)?.name ?? '?' }));
}

function updateMentions() {
  const q = mentionQuery(warInput.value, warInput.selectionStart ?? 0);
  mentionItems = q ? mentionSuggestions(warPeople(), q.query) : [];
  mentionIndex = Math.min(mentionIndex, Math.max(0, mentionItems.length - 1));
  mentionBox.hidden = !mentionItems.length;
  mentionBox.replaceChildren(
    ...mentionItems.map((m, i) => {
      const li = document.createElement('li');
      li.className = i === mentionIndex ? 'active' : '';
      li.setAttribute('role', 'option');
      li.innerHTML = '<b></b><small></small>';
      li.firstElementChild!.textContent = `@${m.key}`;
      li.lastElementChild!.textContent = m.label === m.key ? m.hint : `${m.label} · ${m.hint}`;
      // mousedown: escolhe antes de o campo perder o foco.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickMention(i);
      });
      return li;
    }),
  );
}

function pickMention(i: number) {
  const q = mentionQuery(warInput.value, warInput.selectionStart ?? 0);
  const item = mentionItems[i];
  if (!q || !item) return;
  const done = applyMention(warInput.value, q.start, warInput.selectionStart ?? 0, item.key);
  warInput.value = done.text;
  warInput.setSelectionRange(done.caret, done.caret);
  mentionIndex = 0;
  updateMentions();
}

warInput.addEventListener('input', () => {
  mentionIndex = 0;
  updateMentions();
});
warInput.addEventListener('click', updateMentions);
warInput.addEventListener('blur', () => (mentionBox.hidden = true));
warInput.addEventListener('keydown', (e) => {
  if (!mentionBox.hidden && mentionItems.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : -1) + mentionItems.length) % mentionItems.length;
      updateMentions();
      return;
    }
    if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Tab') {
      e.preventDefault();
      pickMention(mentionIndex);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      mentionBox.hidden = true;
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $<HTMLFormElement>('#war-form').requestSubmit();
  }
});
$('#war-open').addEventListener('click', () => openIncidentDialog('open'));
$('#war-call').addEventListener('click', () => openIncidentDialog('call'));
$('#war-close').addEventListener('click', () => {
  const dlg = $<HTMLDialogElement>('#dlg-close-incident');
  dlg.querySelector<HTMLElement>('.error')!.hidden = true;
  dlg.showModal();
});
$('#war-remove').addEventListener('click', async () => {
  const floor = state.floors.find((f) => f.id === currentFloor);
  if (!floor) return;
  await warAction(async () => {
    const updated = (await api('PATCH', `/api/floors/${floor.id}`, { warRooms: logic.warRoomsOf(floor) - 1 })) as Floor;
    upsert(state.floors, updated);
    selectWar(0);
  });
});

const dlgIncident = $<HTMLDialogElement>('#dlg-incident');
let incidentMode: 'open' | 'call' = 'open';
/** Abrir um incidente (título, descrição e quem entra) ou chamar mais gente para o aberto. */
function openIncidentDialog(mode: 'open' | 'call') {
  incidentMode = mode;
  $('#incident-heading').textContent = mode === 'open' ? 'Abrir incidente' : 'Chamar para a sala de guerra';
  $('#incident-submit').textContent = mode === 'open' ? 'Abrir' : 'Chamar';
  $('#incident-fields').hidden = mode !== 'open';
  const rooms = floorRooms().sort((a, b) => a.name.localeCompare(b.name));
  const agents = logic.incidentCandidates(state.agents, state.rooms, currentFloor);
  const box = $('#incident-who');
  box.replaceChildren();
  const group = (title: string, items: HTMLElement[]) => {
    if (!items.length) return;
    const h = document.createElement('h4');
    h.textContent = title;
    box.append(h, ...items);
  };
  const check = (name: string, value: string, label: string, hint: string) => {
    const l = document.createElement('label');
    l.className = 'check';
    l.innerHTML = `<input type="checkbox" name="${name}" /><span><b></b><br /><small></small></span>`;
    l.querySelector('input')!.value = value;
    l.querySelector('b')!.textContent = label;
    l.querySelector('small')!.textContent = hint;
    return l;
  };
  group('Projetos: entra um agente novo, na pasta do projeto', rooms.map((r) => check('room', r.id, r.name, r.path)));
  group(
    'Agentes que já estão trabalhando: levam o contexto que já têm',
    agents.map((a) => check('agent', a.id, `${a.name} · ${state.rooms.find((r) => r.id === a.roomId)?.name ?? ''}`, a.activity)),
  );
  if (!rooms.length && !agents.length) box.innerHTML = '<p class="muted">Este andar ainda não tem projetos.</p>';
  dlgIncident.querySelector<HTMLElement>('.error')!.hidden = true;
  dlgIncident.showModal();
}
formDialog(dlgIncident, async (data) => {
  const roomIds = data.getAll('room').map(String);
  const agentIds = data.getAll('agent').map(String);
  if (incidentMode === 'call') {
    const incident = currentIncident();
    if (!incident) throw new Error('O incidente já foi encerrado');
    await api('POST', `/api/incidents/${incident.id}/participants`, { roomIds, agentIds });
    return;
  }
  const slot = selectedWar ?? 0;
  const incident = (await api('POST', '/api/incidents', {
    floorId: currentFloor,
    slot,
    title: data.get('title'),
    description: data.get('description'),
    roomIds,
    agentIds,
  })) as Incident;
  upsert(state.incidents, incident);
  selectWar(slot);
});
formDialog($<HTMLDialogElement>('#dlg-close-incident'), async (data) => {
  const incident = currentIncident();
  if (!incident) return;
  await api('POST', `/api/incidents/${incident.id}/close`, { resolution: data.get('resolution') });
});

// ---------- memória dos agentes (ai-memory) ----------

let memory: MemoryStatus | undefined;

async function refreshMemory() {
  try {
    memory = (await api('GET', '/api/memory')) as MemoryStatus;
    renderMemory();
  } catch {}
}

/** Indicador do topo e, se aberto, o diálogo. O progresso da instalação chega pelo WebSocket. */
function renderMemory() {
  const view = logic.memoryView(memory);
  const btn = $('#btn-memory');
  btn.textContent = view.label;
  btn.className = `memory ${view.tone}`;
  const dlg = $<HTMLDialogElement>('#dlg-memory');
  if (!memory || !dlg.open) return;
  const st = memory;
  const checks: [boolean, string][] = [
    [st.running, `Servidor no ar (${st.url})`],
    [st.hooks, 'Sessões do Claude sendo guardadas (hooks)'],
    [st.mcp, 'Claude consultando a memória (MCP)'],
  ];
  $('#mem-checks').innerHTML = checks.map(([ok, text]) => `<li class="${ok ? 'ok' : ''}">${esc(text)}</li>`).join('');
  $('#mem-dir').textContent = st.dataDir;
  $('#mem-version').textContent = st.version;
  $('#mem-plan').hidden = !view.canInstall || !st.docker;
  $('#mem-no-docker').hidden = !st.autoInstall || st.docker || !view.canInstall;
  $('#mem-steps').hidden = !view.showSteps;
  if (view.showSteps) $('#mem-steps-text').textContent = windowsSteps(st.version);
  const job = st.job;
  $('#mem-progress').hidden = !job;
  if (job) {
    $('#mem-step').textContent = job.error ? `Não deu certo: ${job.error}` : job.step;
    $('#mem-step').classList.toggle('error', !!job.error);
    $('#mem-log').textContent = job.log.join('\n');
    if (job.error) $<HTMLDetailsElement>('#mem-log-box').open = true;
  }
  const web = $('#mem-web');
  web.hidden = !st.running;
  web.innerHTML = `Para ver a memória no navegador: <a href="${esc(st.url)}/web" target="_blank" rel="noopener">${esc(st.url)}/web</a> (qualquer usuário; a senha é o conteúdo de <code>auth-tokens/default</code> na pasta dos dados).`;
  $<HTMLButtonElement>('#mem-install').hidden = !view.canInstall;
  $<HTMLButtonElement>('#mem-install').disabled = !st.docker;
  $<HTMLButtonElement>('#mem-install').textContent = st.outdated ? `Atualizar para ${st.version}` : st.hooks || st.mcp ? 'Instalar de novo' : 'Instalar';
  $<HTMLButtonElement>('#mem-uninstall').hidden = !view.canUninstall;
}

/** Erros das ações do diálogo aparecem nele, embaixo. */
async function memoryAction(fn: () => Promise<unknown>) {
  const error = $('#dlg-memory .error');
  error.hidden = true;
  try {
    await fn();
  } catch (err) {
    error.textContent = (err as Error).message;
    error.hidden = false;
  }
}

$('#btn-memory').addEventListener('click', async () => {
  $<HTMLDialogElement>('#dlg-memory').showModal();
  $('#dlg-memory .error').hidden = true;
  renderMemory();
  await refreshMemory();
});
$('#mem-install').addEventListener('click', () =>
  memoryAction(async () => {
    memory = { ...memory!, job: (await api('POST', '/api/memory/install')) as MemoryStatus['job'] };
    renderMemory();
  }),
);
$('#mem-uninstall').addEventListener('click', async () => {
  const dlg = $<HTMLDialogElement>('#dlg-memory');
  dlg.close();
  const ok = await confirmDialog('Desinstalar o ai-memory?', 'Tira os hooks e o MCP do Claude Code e remove o container. Os dados continuam na pasta, para uma instalação futura.');
  dlg.showModal();
  if (!ok) return renderMemory();
  await memoryAction(async () => {
    memory = { ...memory!, job: (await api('POST', '/api/memory/uninstall')) as MemoryStatus['job'] };
    renderMemory();
  });
});
$('#mem-open').addEventListener('click', () => memoryAction(() => api('POST', '/api/memory/open')));
$('#mem-copy').addEventListener('click', () => navigator.clipboard?.writeText($('#mem-steps-text').textContent ?? ''));
refreshMemory();
setInterval(() => !document.hidden && refreshMemory(), 60_000);

// ---------- contadores e lista do escritório ----------

function renderCounters() {
  const c = logic.officeCounters(state.rooms, state.agents);
  const items: [keyof logic.Counters, string][] = [
    ['salas', 'salas'],
    ['agentes', 'agentes'],
    ['trabalhando', 'trabalhando'],
    ['ajudantes', 'ajudantes'],
    ['terminais', 'terminais'],
  ];
  $('#counters').innerHTML = items.map(([k, label]) => `<div class="counter ${k}" title="${label}"><b>${c[k]}</b><span>${label}</span></div>`).join('');
}

/** Primeiro quadro do "parado" de cada personagem, para o avatar da lista. */
let avatars: { names: string[]; parado: Record<string, { arquivo: string; w: number; h: number; cabecaY: number }> } = { names: [], parado: {} };
fetch('sprites/manifest.json')
  .then((r) => r.json() as Promise<Manifest>)
  .then((m) => {
    avatars = {
      names: Object.keys(m.personagens),
      parado: Object.fromEntries(Object.entries(m.personagens).map(([k, v]) => [k, v.parado])),
    };
    directoryKey = '';
    renderDirectory();
  })
  .catch(() => {});

function avatarStyle(agentId: string): string {
  const who = characterFor(hash(agentId), avatars.names);
  const a = who ? avatars.parado[who] : undefined;
  if (!a) return '';
  // Mostra cabeça e tronco num quadradinho de 30 px.
  const scale = 0.9;
  const x = -(a.w * scale - 30) / 2;
  const y = -(a.cabecaY * scale - 2);
  return `background-image:url('sprites/${a.arquivo}');background-size:auto ${a.h * scale}px;background-position:${x}px ${y}px`;
}

let directoryKey = '';
const dirSearch = $<HTMLInputElement>('#dir-search');
dirSearch.addEventListener('input', () => renderDirectory());

/** Lista do escritório: andares → salas → agentes. Clicar leva até o andar, a sala ou o agente. */
function renderDirectory() {
  // Escondida no computador não redesenha; no celular e no tablet ela é uma gaveta, sempre pronta.
  if (document.body.classList.contains('dir-hidden') && !compactDir.matches) return;
  const tree = logic.directoryTree(state.floors, state.rooms, state.agents, dirSearch.value);
  const attention = logic.attentionByFloor(state.agents, state.rooms);
  // Só redesenha quando algo visível muda (mesma razão do elevador: clique em botão trocado).
  const key = JSON.stringify([
    dirSearch.value,
    currentFloor,
    selectedRoom,
    selectedAgent,
    avatars.names.length,
    tree.map((f) => [f.floor.id, f.floor.name, f.floor.color, attention.get(f.floor.id), f.rooms.map((r) => [r.room.id, r.room.name, r.agents.map((a) => [a.id, a.name, a.status, a.activity])])]),
  ]);
  if (key === directoryKey) return;
  directoryKey = key;

  const box = $('#dir-tree');
  box.replaceChildren();
  for (const { floor, rooms } of tree) {
    const wrap = document.createElement('div');
    wrap.className = 'dir-floor';
    const head = document.createElement('button');
    head.className = `dir-floor-head${floor.id === currentFloor ? ' current' : ''}`;
    head.style.setProperty('--floor-color', floor.color);
    head.dataset.floor = floor.id;
    head.textContent = floor.name;
    const n = attention.get(floor.id) ?? 0;
    if (n) {
      const badge = document.createElement('span');
      badge.className = 'floor-badge';
      badge.textContent = String(n);
      head.append(badge);
    }
    head.addEventListener('click', () => goToFloor(floor.id));
    wrap.append(head);
    if (!rooms.length) {
      const empty = document.createElement('div');
      empty.className = 'dir-empty';
      empty.textContent = dirSearch.value ? 'Nada aqui' : 'Sem salas ainda';
      wrap.append(empty);
    }
    for (const { room, agents } of rooms) {
      const r = document.createElement('div');
      r.className = 'dir-room';
      const rh = document.createElement('button');
      rh.className = `dir-room-head${room.id === selectedRoom ? ' current' : ''}`;
      rh.dataset.room = room.id;
      rh.textContent = room.name;
      rh.addEventListener('click', () => {
        goToFloor(room.floorId!);
        selectRoom(room.id);
        office.reveal(room.id);
      });
      r.append(rh);
      for (const a of agents) {
        const b = document.createElement('button');
        b.className = `dir-agent${a.id === selectedAgent ? ' current' : ''}`;
        b.dataset.agent = a.id;
        b.title = a.activity;
        b.innerHTML = `<span class="avatar" style="${avatarStyle(a.id)}"></span><span class="who"><b></b><small></small></span><span class="dot" style="background:${STATUS_COLOR[a.status]}"></span>`;
        b.querySelector('b')!.textContent = a.name;
        b.querySelector('small')!.textContent = a.activity;
        b.addEventListener('click', () => selectAgent(a.id));
        r.append(b);
      }
      wrap.append(r);
    }
    box.append(wrap);
  }
  if (!tree.length) box.innerHTML = '<p class="dir-empty">Nada encontrado.</p>';
}

// Lista e atividade: mostrar/esconder, lembrando a escolha.
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function recall(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
if (recall('directory') === 'hidden') document.body.classList.add('dir-hidden');
$('#btn-directory').addEventListener('click', () => {
  // Celular e tablet: a lista é uma gaveta por cima da tela (e não fica lembrada como escondida).
  if (compactDir.matches) return setDrawer('dir', !document.body.classList.contains('dir-open'));
  const hidden = document.body.classList.toggle('dir-hidden');
  remember('directory', hidden ? 'hidden' : 'shown');
  directoryKey = '';
  renderDirectory();
});
/** Esconde ou mostra o painel da direita (sala e git), e lembra a escolha. */
function setSidebarHidden(hidden: boolean) {
  document.body.classList.toggle('side-hidden', hidden);
  const btn = $('#btn-sidebar');
  btn.textContent = hidden ? '⇤' : '⇥';
  btn.title = hidden ? 'Mostrar o painel da direita' : 'Esconder o painel da direita';
}
setSidebarHidden(recall('sidebar') === 'hidden');
$('#btn-sidebar').addEventListener('click', () => {
  if (compactSide.matches) return setDrawer('side', !document.body.classList.contains('side-open'));
  const hidden = !document.body.classList.contains('side-hidden');
  setSidebarHidden(hidden);
  remember('sidebar', hidden ? 'hidden' : 'shown');
});
if (recall('activity') === 'collapsed') $('#activity-float').classList.add('collapsed');
$('#activity-toggle').addEventListener('click', () => {
  const collapsed = $('#activity-float').classList.toggle('collapsed');
  remember('activity', collapsed ? 'collapsed' : 'open');
});

// ---------- celular e tablet: gavetas, elevador e teclas do terminal ----------

/** Até 1100 px a lista de salas é gaveta; até 900 px o painel da direita também. */
const compactDir = matchMedia('(max-width: 1100px)');
const compactSide = matchMedia('(max-width: 900px)');
/** Toque (celular, tablet): mostra a barra de teclas que o teclado da tela não tem. */
const coarse = matchMedia('(pointer: coarse)');
/** Celular: elevador recolhido e botões só com ícone. */
const phone = matchMedia('(max-width: 640px)');

function setDrawer(which: 'dir' | 'side', open: boolean) {
  document.body.classList.toggle(`${which}-open`, open);
  // Uma gaveta por vez: a outra fecha.
  if (open) document.body.classList.remove(which === 'dir' ? 'side-open' : 'dir-open');
  if (open && which === 'dir') {
    directoryKey = '';
    renderDirectory();
  }
}
function closeDrawers() {
  document.body.classList.remove('dir-open', 'side-open');
}
$('#drawer-backdrop').addEventListener('click', closeDrawers);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.matches('.dir-open, .side-open') && !document.querySelector('dialog[open]')) closeDrawers();
});
// Escolher alguém na lista (ou no quadro da sala) já fecha a gaveta: o terminal aparece.
$('#dir-tree').addEventListener('click', (e) => {
  if (compactDir.matches && (e.target as HTMLElement).closest('.dir-agent, .dir-room-head')) closeDrawers();
});
$('#squad-list').addEventListener('click', () => compactSide.matches && closeDrawers());
// Voltou a ser uma tela larga: as gavetas somem e vale o painel de sempre.
for (const q of [compactDir, compactSide]) {
  q.addEventListener('change', () => {
    closeDrawers();
    directoryKey = '';
    renderDirectory();
  });
}

const TERM_KEYS: Record<string, string> = {
  esc: '\x1b',
  tab: '\t',
  stab: '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  ctrlc: '\x03',
  enter: '\r',
};
$('#term-keys').addEventListener('pointerdown', (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.key;
  if (!key || !selectedAgent) return;
  // Não tira o foco do terminal: o teclado da tela continua aberto.
  e.preventDefault();
  send({ t: 'in', id: selectedAgent, data: TERM_KEYS[key] });
  lastKeyAt = Date.now();
});
// A escala da interface mudou (janela em outro monitor, ou redimensionada): letra nova nos terminais.
let lastFont = uiFontSize();
window.addEventListener('resize', () => {
  const f = uiFontSize();
  if (f === lastFont) return;
  lastFont = f;
  terminals.setFontSize(f);
});

function renderTermKeys() {
  $('#term-keys').hidden = !(coarse.matches && selectedAgent && selectedWar === undefined && !explorer.isShown());
}

// ---------- elevador ----------

/** Painel do elevador: um botão por andar (de cima para baixo), com quantos precisam de você. */
let elevatorKey = '';

function renderElevator() {
  const panel = $('#elevator');
  const attention = logic.attentionByFloor(state.agents, state.rooms);
  const stops = logic.elevatorStops(state.floors).reverse();
  // Só redesenha quando algo do painel muda: recriar os botões a cada atualização de agente
  // fazia um clique cair num botão que acabou de ser trocado (e não pegar).
  const key = JSON.stringify([currentFloor, state.floors.map((f) => [f.id, f.name, f.color]), [...attention]]);
  if (key === elevatorKey) return;
  elevatorKey = key;
  panel.replaceChildren(
    ...stops.map((id) => {
      const floor = state.floors.find((f) => f.id === id);
      const btn = document.createElement('button');
      btn.className = `floor${id === currentFloor ? ' current' : ''}`;
      btn.dataset.floor = id;
      btn.style.setProperty('--floor-color', floor?.color ?? '#a9b1d6');
      btn.title = floor ? `${floor.name} (Alt+PageUp / Alt+PageDown)` : 'Térreo: recepção e entrada';
      const label = document.createElement('span');
      label.className = 'floor-name';
      label.textContent = floor ? floor.name : 'Térreo';
      btn.append(label);
      const n = attention.get(id) ?? 0;
      if (n) {
        const badge = document.createElement('span');
        badge.className = 'floor-badge';
        badge.textContent = String(n);
        badge.title = `${n} ${n === 1 ? 'agente precisa' : 'agentes precisam'} de você`;
        btn.append(badge);
      }
      btn.addEventListener('click', () => {
        // Celular: o elevador fica recolhido no andar atual; tocar nele abre a lista de andares.
        if (phone.matches && id === currentFloor) return void panel.classList.toggle('open');
        panel.classList.remove('open');
        goToFloor(id);
      });
      return btn;
    }),
  );
  const add = document.createElement('button');
  add.className = 'floor add';
  add.textContent = '+ andar';
  add.title = 'Novo andar (empresa, pessoal, freelance…)';
  add.addEventListener('click', () => openFloorDialog());
  panel.prepend(add);
  if (state.floors.some((f) => f.id === currentFloor)) {
    const edit = document.createElement('button');
    edit.className = 'floor edit';
    edit.textContent = '✎';
    edit.title = 'Renomear, trocar a cor, mudar os padrões dos agentes ou apagar este andar';
    edit.addEventListener('click', () => openFloorDialog(state.floors.find((f) => f.id === currentFloor)));
    panel.append(edit);
  }
}

const dlgFloor = $<HTMLDialogElement>('#dlg-floor');
let editingFloor: Floor | undefined;

function openFloorDialog(floor?: Floor) {
  editingFloor = floor;
  const form = dlgFloor.querySelector('form')!;
  form.reset();
  $('#dlg-floor-title').textContent = floor ? `Andar ${floor.name}` : 'Novo andar';
  dlgFloor.querySelector<HTMLInputElement>('input[name=name]')!.value = floor?.name ?? '';
  dlgFloor.querySelector<HTMLInputElement>('input[name=coAuthor]')!.checked = floor?.defaults?.coAuthor !== false;
  dlgFloor.querySelector<HTMLTextAreaElement>('textarea[name=instructions]')!.value = floor?.defaults?.instructions ?? '';
  const colors = $('#floor-colors');
  const chosen = floor?.color ?? FLOOR_COLORS[state.floors.length % FLOOR_COLORS.length];
  colors.replaceChildren(
    ...FLOOR_COLORS.map((c) => {
      const label = document.createElement('label');
      label.className = 'swatch';
      label.style.setProperty('--swatch', c);
      label.innerHTML = `<input type="radio" name="color" value="${c}"${c === chosen ? ' checked' : ''} />`;
      return label;
    }),
  );
  $('#floor-delete').hidden = !floor;
  dlgFloor.querySelector<HTMLElement>('.error')!.hidden = true;
  dlgFloor.showModal();
}

formDialog(dlgFloor, async (data) => {
  const defaults = { coAuthor: data.get('coAuthor') === 'on', instructions: data.get('instructions') };
  const body = { name: data.get('name'), color: data.get('color'), defaults };
  const floor = (editingFloor ? await api('PATCH', `/api/floors/${editingFloor.id}`, body) : await api('POST', '/api/floors', body)) as Floor;
  upsert(state.floors, floor);
  state.floors.sort((a, b) => a.order - b.order);
  goToFloor(floor.id);
});

$('#floor-delete').addEventListener('click', async () => {
  if (!editingFloor) return;
  const error = dlgFloor.querySelector<HTMLElement>('.error')!;
  try {
    await api('DELETE', `/api/floors/${editingFloor.id}`);
    dlgFloor.close();
  } catch (err) {
    error.textContent = (err as Error).message;
    error.hidden = false;
  }
});

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
  // O git só aparece no modo Git do explorador: é o da pasta dele (o projeto, ou o worktree de um agente).
  return explorer.isShown() ? (explorer.tab()?.base ?? '') : '';
}

let lastGit: { base: string; info: GitInfo } | undefined;
/** Situação do worktree do agente selecionado, quando ele tem um (botões de PR, merge e encerrar). */
let lastWorktree: WorktreeStatus | undefined;
/** Erro da última ação do worktree, mostrado na seção até a próxima ação. */
let worktreeError = '';
/** Último HTML do painel de git. */
let gitHtml = '';
/** Seções do painel de git que você abriu ou recolheu (guardado entre recarregamentos). */
const gitSections: Partial<Record<logic.GitSection, boolean>> = (() => {
  try {
    return JSON.parse(localStorage.getItem('gitSections') ?? '{}');
  } catch {
    return {};
  }
})();
/** `open` da seção, para o HTML: sem ele, cada atualização com mudança fechava o que você abriu. */
const secOpen = (sec: logic.GitSection) => (logic.gitSectionOpen(gitSections, sec) ? ' open' : '');

/**
 * Troca o painel de git só se mudou: a atualização a cada 15 s recriava os botões (o clique
 * que caía no meio se perdia) e fechava o "Últimos commits".
 */
function setGitHtml(html: string) {
  if (html === gitHtml) return;
  gitHtml = html;
  $('#git').innerHTML = html;
}

async function refreshGit() {
  const base = gitBase();
  if (!base) {
    setGitHtml('');
    lastGit = undefined;
    lastWorktree = undefined;
    return;
  }
  const agent = state.agents.find((a) => a.id === selectedAgent);
  try {
    const [info, wt] = await Promise.all([
      fetch(`${base}/git`).then((r) => r.json() as Promise<GitInfo>),
      agent?.worktreeBranch && base === `/api/agents/${agent.id}` ? fetch(`${base}/worktree`).then((r) => (r.ok ? (r.json() as Promise<WorktreeStatus>) : undefined)) : undefined,
    ]);
    // Você pode ter trocado de agente enquanto a resposta vinha.
    if (base !== gitBase()) return;
    if (lastGit?.base !== base) worktreeError = '';
    lastGit = { base, info };
    lastWorktree = wt;
    renderGit(info);
  } catch {
    if (base === gitBase()) setGitHtml('Não foi possível ler o git.');
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
  if (!info.isRepo) {
    setGitHtml('<p class="muted">Esta pasta não é um repositório git.</p>');
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
  setGitHtml(`
    <div class="branch">⎇ ${esc(info.branch ?? '?')} <span class="muted">${sync}</span></div>
    ${lastWorktree ? worktreeSection(lastWorktree) : ''}
    <details class="git-section" data-sec="working"${secOpen('working')}>
      <summary><h4>Não commitado <span class="count">${files.length}</span>${files.length ? `<span class="nums">${total(files)}</span>` : ''}</h4></summary>
      ${files.length ? fileRows(files, 'working') : '<div class="muted empty">Nada modificado</div>'}
    </details>
    ${
      info.base
        ? `<details class="git-section" data-sec="branch"${secOpen('branch')}>
      <summary><h4>Na branch, desde <code>${esc(info.base)}</code> <span class="count">${info.branchCommits ?? 0} commit${info.branchCommits === 1 ? '' : 's'}</span>${branchFiles.length ? `<span class="nums">${total(branchFiles)}</span>` : ''}</h4></summary>
      ${branchFiles.length ? fileRows(branchFiles, 'branch') : '<div class="muted empty">Nenhum arquivo diferente da base</div>'}
    </details>`
        : ''
    }
    <details data-sec="commits"${secOpen('commits')}>
      <summary>Últimos commits</summary>
      ${(info.commits ?? []).map((c) => `<div class="commit"><code>${esc(c.hash)}</code> ${esc(c.subject)} <span class="muted">${esc(c.when)}</span></div>`).join('')}
    </details>`);
}

/** Seção do worktree: onde a branch está em relação à sala e os botões de PR, merge e encerrar. */
function worktreeSection(st: WorktreeStatus): string {
  const ui = logic.worktreeActions(st);
  const button = (action: string, b: logic.WorktreeButton, cls = '') =>
    `<button class="btn small ${cls}" data-wt="${action}"${b.disabled ? ` disabled title="${esc(b.disabled)}"` : ''}>${esc(b.label)}</button>`;
  return `<details class="git-section worktree" data-sec="worktree"${secOpen('worktree')}>
      <summary><h4>Worktree <span class="count">${esc(ui.summary)}</span></h4></summary>
      ${st.pr ? `<a class="wt-pr" href="${esc(st.pr)}" target="_blank" rel="noopener">PR aberto ↗</a>` : ''}
      ${ui.warnings.map((w) => `<p class="wt-warn">${esc(w)}</p>`).join('')}
      <div class="wt-actions">${button('pr', ui.pr)}${button('merge', ui.merge)}${button('remove', ui.remove, 'ghost')}</div>
      ${worktreeError ? `<p class="error">${esc(worktreeError)}</p>` : ''}
    </details>`;
}

// Abrir ou recolher uma seção: guarda a escolha (o "toggle" não borbulha, por isso a captura).
$('#git').addEventListener(
  'toggle',
  (e) => {
    const sec = (e.target as HTMLElement).dataset.sec as logic.GitSection | undefined;
    if (!sec) return;
    gitSections[sec] = (e.target as HTMLDetailsElement).open;
    remember('gitSections', JSON.stringify(gitSections));
  },
  true,
);

$('#git').addEventListener('click', (e) => {
  const wt = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-wt]');
  if (wt) return worktreeAction(wt.dataset.wt!, wt);
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.file');
  if (btn) openDiff(btn.dataset.scope as DiffScope, btn.dataset.path!);
});

async function worktreeAction(action: string, btn: HTMLButtonElement) {
  const st = lastWorktree;
  const agent = state.agents.find((a) => a.id === selectedAgent);
  if (!st || !agent) return;
  const dlgPr = $<HTMLDialogElement>('#dlg-pr');
  if (action === 'pr' && !st.pr) {
    dlgPr.querySelector<HTMLElement>('.error')!.hidden = true;
    $('#pr-info').textContent = `Sobe ${st.branch} para o origin e abre o PR com o GitHub CLI (gh).${st.dirty ? ' Arquivos não commitados ficam de fora.' : ''}`;
    dlgPr.querySelector<HTMLInputElement>('[name=title]')!.value = st.suggestion.title;
    dlgPr.querySelector<HTMLTextAreaElement>('[name=body]')!.value = st.suggestion.body;
    dlgPr.showModal();
    return;
  }
  if (action === 'remove') {
    const dlg = $<HTMLDialogElement>('#dlg-worktree-end');
    const opt = logic.deleteBranchOption(st);
    dlg.querySelector<HTMLElement>('.error')!.hidden = true;
    $('#wt-end-title').textContent = `Encerrar o worktree de ${agent.name}?`;
    $('#wt-end-text').textContent = `${agent.status !== 'exited' ? 'A sessão é encerrada e ' : ''}${agent.name} sai do escritório. A pasta do worktree é apagada; o histórico da conversa continua em ~/.claude.`;
    $('#wt-end-branch').textContent = st.branch;
    $('#wt-end-hint').textContent = opt.hint;
    const box = dlg.querySelector<HTMLInputElement>('[name=deleteBranch]')!;
    box.checked = false;
    box.disabled = !opt.allowed;
    dlg.showModal();
    return;
  }
  if (action === 'merge') {
    const ok = await confirmDialog(
      `Trazer ${st.branch} para ${st.target}?`,
      `Faz o merge dos ${st.ahead} commit(s) na pasta da sala, na branch ${st.target}. Nada é enviado para o GitHub.`,
    );
    if (!ok) return;
  }
  // Merge, ou enviar commits novos para o PR já aberto.
  worktreeError = '';
  btn.disabled = true;
  btn.textContent = action === 'merge' ? 'Trazendo…' : 'Enviando…';
  // A tela já não bate com o HTML guardado: a próxima atualização redesenha, mesmo sem mudança.
  gitHtml = '';
  try {
    if (action === 'merge') await api('POST', `/api/agents/${agent.id}/worktree/merge`);
    else await api('POST', `/api/agents/${agent.id}/worktree/pr`, {});
  } catch (err) {
    worktreeError = (err as Error).message;
  }
  await refreshGit();
}

formDialog($<HTMLDialogElement>('#dlg-pr'), async (data) => {
  const { url } = (await api('POST', `/api/agents/${selectedAgent}/worktree/pr`, { title: data.get('title'), body: data.get('body') })) as { url: string };
  worktreeError = '';
  await refreshGit();
  window.open(url, '_blank', 'noopener');
});

formDialog($<HTMLDialogElement>('#dlg-worktree-end'), async (data) => {
  await api('POST', `/api/agents/${selectedAgent}/worktree/remove`, { deleteBranch: data.get('deleteBranch') === 'on' });
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
  if (selectedAgent && !explorer.isShown()) terminals.show(selectedAgent);
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
    // Pode demorar (ex.: subir a branch e abrir o PR): o botão fica desligado para não enviar duas vezes.
    submitter.disabled = true;
    try {
      await onSubmit(new FormData(form));
      dlg.close();
      form.reset();
    } catch (err) {
      error.textContent = (err as Error).message;
      error.hidden = false;
    } finally {
      submitter.disabled = false;
    }
  });
}

const dlgRoom = $<HTMLDialogElement>('#dlg-room');
/** Vaga do prédio escolhida no "+" do mapa; sem ela, o servidor escolhe uma encostada no prédio. */
let newRoomCell: Cell | undefined;
formDialog(dlgRoom, async (data) => {
  const floorId = String(data.get('floor') ?? '');
  // A vaga clicada no "+" só vale para o andar em que ela foi clicada.
  const pos = floorId === currentFloor ? newRoomCell : undefined;
  const room = (await api('POST', '/api/rooms', { path: data.get('path'), name: data.get('name'), floorId, pos })) as Room;
  upsert(state.rooms, room);
  selectedRoom = room.id;
  selectedAgent = undefined;
  if (room.floorId && room.floorId !== currentFloor) goToFloor(room.floorId);
  renderAll();
  office.reveal(room.id);
});
$('#btn-add-room').addEventListener('click', () => openRoomDialog());

async function openRoomDialog(cell?: Cell) {
  newRoomCell = cell;
  // Começa no andar da tela; no térreo (que não tem salas), no primeiro andar.
  const defaultFloor = state.floors.some((f) => f.id === currentFloor) ? currentFloor : state.floors[0]?.id;
  $('#room-floor').replaceChildren(...state.floors.map((f) => new Option(f.name, f.id, false, f.id === defaultFloor)));
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
    projectId: data.get('project') || undefined,
    name: data.get('name'),
    worktree: data.get('worktree') === 'on',
  })) as Agent;
  upsert(state.agents, agent);
  selectAgent(agent.id);
});
function openAgentDialog(roomId: string) {
  agentRoom = roomId;
  const room = state.rooms.find((r) => r.id === roomId);
  $('#dlg-agent-room').textContent = `Sala: ${room?.name ?? ''}`;
  const projects = room?.projects ?? [];
  const current = logic.roomProject(room, roomProjectSel.get(roomId))?.id;
  $('#agent-project').replaceChildren(...projects.map((p) => new Option(p.name, p.id, false, p.id === current)));
  $('#agent-project-row').hidden = projects.length < 2;
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

async function openWarShell(incidentId: string) {
  const shell = (await api('POST', `/api/incidents/${incidentId}/shells`)) as Agent;
  upsert(state.agents, shell);
  selectAgent(shell.id);
}

async function openShell(roomId: string) {
  // Numa sala com vários projetos, o terminal abre na pasta do projeto escolhido.
  const room = state.rooms.find((r) => r.id === roomId);
  const projectId = (room?.projects?.length ?? 0) > 1 ? logic.roomProject(room, roomProjectSel.get(roomId))?.id : undefined;
  const shell = (await api('POST', '/api/shells', { roomId, projectId })) as Agent;
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
    `${running ? 'A sessão será encerrada. ' : ''}O histórico da conversa continua em ~/.claude.${a.worktreeBranch ? ` O worktree (${a.worktreeBranch}) não é apagado; para apagar, use "Encerrar worktree" no painel de git.` : ''}`,
  );
  if (ok) await api('DELETE', `/api/agents/${a.id}`);
}

// ---------- projetos da sala ----------

const dlgProjects = $<HTMLDialogElement>('#dlg-projects');
let projectsRoom = '';

/** Uma linha por projeto: nome, pasta, ficha editável, refazer o rascunho e tirar da sala. */
function renderProjectsList() {
  const room = state.rooms.find((r) => r.id === projectsRoom);
  const list = $('#projects-list');
  list.replaceChildren();
  for (const p of room?.projects ?? []) {
    const row = document.createElement('fieldset');
    row.className = 'project-row';
    row.dataset.id = p.id;
    row.innerHTML = `
      <legend><input class="project-name" autocomplete="off" /> <small class="muted project-path"></small></legend>
      <textarea class="project-summary" rows="3" placeholder="O que este projeto faz, o que expõe e o que consome."></textarea>
      <div class="project-actions">
        <small class="muted project-auto"></small>
        <button type="button" class="btn small ghost" data-act="redraft" title="Refaz o rascunho a partir do README">Refazer rascunho</button>
        <button type="button" class="btn small ghost" data-act="remove">Tirar da sala</button>
      </div>`;
    row.querySelector<HTMLInputElement>('.project-name')!.value = p.name;
    row.querySelector('.project-path')!.textContent = p.path;
    row.querySelector<HTMLTextAreaElement>('.project-summary')!.value = p.summary;
    row.querySelector('.project-auto')!.textContent = p.summaryEdited ? 'ficha editada por você' : 'rascunho automático';
    row.querySelector('[data-act=redraft]')!.addEventListener('click', () => projectAction(() => api('PATCH', `/api/rooms/${projectsRoom}/projects/${p.id}`, { redraft: true })));
    row.querySelector('[data-act=remove]')!.addEventListener('click', () => projectAction(() => api('DELETE', `/api/rooms/${projectsRoom}/projects/${p.id}`)));
    list.appendChild(row);
  }
}

/** Ação de um projeto no diálogo: atualiza a sala e a lista, ou mostra o erro sem fechar. */
async function projectAction(fn: () => Promise<unknown>) {
  const error = dlgProjects.querySelector<HTMLElement>('.error')!;
  error.hidden = true;
  try {
    upsert(state.rooms, (await fn()) as Room);
    renderProjectsList();
    renderAll();
  } catch (err) {
    error.textContent = (err as Error).message;
    error.hidden = false;
  }
}

function openProjectsDialog(roomId: string) {
  projectsRoom = roomId;
  const room = state.rooms.find((r) => r.id === roomId);
  $('#dlg-projects-title').textContent = `Projetos da sala ${room?.name ?? ''}`;
  $<HTMLTextAreaElement>('#projects-brief').value = room?.brief ?? '';
  $<HTMLInputElement>('#projects-room-name').value = room?.name ?? '';
  $<HTMLInputElement>('#project-new-path').value = '';
  dlgProjects.querySelector<HTMLElement>('.error')!.hidden = true;
  renderProjectsList();
  dlgProjects.showModal();
}

// O seletor de pastas do sistema já abre na raiz da sala.
$('#btn-project-browse').addEventListener('click', async () => {
  const room = state.rooms.find((r) => r.id === projectsRoom);
  if (!room) return;
  const btn = $<HTMLButtonElement>('#btn-project-browse');
  const error = dlgProjects.querySelector<HTMLElement>('.error')!;
  btn.disabled = true;
  btn.textContent = 'Aguardando…';
  error.hidden = true;
  try {
    const { path } = (await api('POST', '/api/pick-folder', { start: room.path })) as { path: string | null };
    if (path) $<HTMLInputElement>('#project-new-path').value = logic.pathInRoot(room.path, path);
  } catch (err) {
    error.textContent = (err as Error).message;
    error.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '📁 Procurar…';
  }
});

$('#btn-project-add').addEventListener('click', () => {
  const input = $<HTMLInputElement>('#project-new-path');
  if (!input.value.trim()) return;
  void projectAction(async () => {
    const room = await api('POST', `/api/rooms/${projectsRoom}/projects`, { path: input.value.trim() });
    input.value = '';
    return room;
  });
});

// Salvar: o resumo da sala e o nome e a ficha de cada projeto que mudou.
formDialog(dlgProjects, async (data) => {
  const room = state.rooms.find((r) => r.id === projectsRoom);
  if (!room) return;
  let updated = room;
  const brief = String(data.get('brief') ?? '').trim();
  const roomName = String(data.get('roomName') ?? '').trim();
  const roomPatch: Record<string, string> = {};
  if (brief !== (room.brief ?? '')) roomPatch.brief = brief;
  if (roomName && roomName !== room.name) roomPatch.name = roomName;
  if (Object.keys(roomPatch).length) updated = (await api('PATCH', `/api/rooms/${room.id}`, roomPatch)) as Room;
  for (const row of $('#projects-list').querySelectorAll<HTMLElement>('.project-row')) {
    const p = room.projects?.find((x) => x.id === row.dataset.id);
    if (!p) continue;
    const name = row.querySelector<HTMLInputElement>('.project-name')!.value.trim();
    const summary = row.querySelector<HTMLTextAreaElement>('.project-summary')!.value.trim();
    const patch: Record<string, string> = {};
    if (name && name !== p.name) patch.name = name;
    if (summary !== p.summary) patch.summary = summary;
    if (Object.keys(patch).length) updated = (await api('PATCH', `/api/rooms/${room.id}/projects/${p.id}`, patch)) as Room;
  }
  upsert(state.rooms, updated);
  renderAll();
});

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
      // As abas que estão na tela: as da sala de guerra, quando ela está selecionada.
      const a = currentTabs()[Number(e.code.slice(5)) - 1];
      if (a) {
        e.preventDefault();
        selectAgent(a.id);
      }
    } else if (e.code === 'KeyT' && currentIncident()) {
      e.preventDefault();
      openWarShell(currentIncident()!.id);
    } else if (e.code === 'KeyT' && selectedRoom) {
      e.preventDefault();
      openShell(selectedRoom);
    } else if (e.code === 'PageUp' || e.code === 'PageDown') {
      e.preventDefault();
      goToFloor(logic.nextStop(state.floors, currentFloor, e.code === 'PageUp' ? 1 : -1));
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

// Versão em uso, ao lado do nome: leva às notas da release no GitHub.
api('GET', '/api/versao')
  .then((v) => {
    const { version, commit, branch } = v as { version: string; commit?: string; branch?: string };
    const el = $<HTMLAnchorElement>('#version');
    el.textContent = version;
    el.title = [commit && `commit ${commit}`, branch && `branch ${branch}`, version.includes('+') && 'com commits depois da release', version.endsWith('*') && 'com mudanças não commitadas'].filter(Boolean).join(' · ');
    const tag = /^v\d+\.\d+(\.\d+)?/.exec(version)?.[0];
    if (tag) el.href = `https://github.com/davidosanjoss/ai-office/releases/tag/${tag}`;
    el.hidden = false;
  })
  .catch(() => undefined);

document.fonts?.ready.then(() => renderAll());
connect();
