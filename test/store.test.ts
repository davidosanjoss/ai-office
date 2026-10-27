import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, ServerMsg } from '../shared/types.ts';
import { Store } from '../server/store.ts';
import { tempDir, waitFor } from './helpers.ts';

const agent = (patch: Partial<Agent> = {}): Agent => ({
  id: 'a1',
  roomId: 'r1',
  name: 'Ana',
  cwd: '/tmp',
  sessionId: 's1',
  status: 'working',
  activity: 'Lendo x',
  subagents: 2,
  createdAt: 1,
  ...patch,
});

describe('Store', () => {
  it('salva salas e agentes e carrega de volta', async () => {
    const file = path.join(tempDir('store'), 'state.json');
    const s1 = new Store(file);
    s1.putRoom({ id: 'r1', name: 'app', path: '/app', createdAt: 1 });
    s1.putAgent(agent());
    await waitFor(() => fs.existsSync(file), 2000, 'state.json');

    const s2 = new Store(file);
    s2.load();
    expect(s2.rooms.get('r1')?.name).toBe('app');
    // Processos não sobrevivem ao reinício: o agente volta como "fora do escritório".
    expect(s2.agents.get('a1')).toMatchObject({ status: 'exited', subagents: 0, sessionId: 's1' });
  });

  it('state.json corrompido não derruba o servidor', () => {
    const file = path.join(tempDir('store'), 'state.json');
    fs.writeFileSync(file, '{ quebrado');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = new Store(file);
    expect(() => s.load()).not.toThrow();
    expect(s.rooms.size).toBe(0);
    spy.mockRestore();
  });

  it('emite mensagens para o WebSocket a cada mudança', () => {
    const s = new Store(path.join(tempDir('store'), 'state.json'));
    const msgs: ServerMsg[] = [];
    s.on('msg', (m) => msgs.push(m));
    s.putAgent(agent());
    s.patchAgent('a1', { status: 'done' });
    s.log('a1', 'oi', 'system');
    s.output('a1', 'saída');
    s.removeAgent('a1');
    expect(msgs.map((m) => m.t)).toEqual(['agent', 'agent', 'activity', 'out', 'agentRemoved']);
  });

  it('patch de agente inexistente é ignorado', () => {
    const s = new Store(path.join(tempDir('store'), 'state.json'));
    s.patchAgent('nada', { status: 'done' });
    expect(s.agents.size).toBe(0);
  });

  it('a atividade guarda no máximo 300 eventos', () => {
    const s = new Store(path.join(tempDir('store'), 'state.json'));
    s.putAgent(agent());
    for (let i = 0; i < 350; i++) s.log('a1', `evento ${i}`, 'tool');
    expect(s.activity).toHaveLength(300);
    expect(s.activity[0].text).toBe('evento 50');
  });
});

describe('andares no store', () => {
  it('salas de antes dos andares vão para o andar "Geral", mantendo a vaga', () => {
    const file = path.join(tempDir('store'), 'state.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        rooms: [
          { id: 'r1', name: 'api', path: '/api', createdAt: 1, pos: { x: -1, y: 0 } },
          { id: 'r2', name: 'site', path: '/site', createdAt: 2 },
        ],
        agents: [],
      }),
    );
    const s = new Store(file);
    s.load();
    expect([...s.floors.values()].map((f) => f.name)).toEqual(['Geral']);
    expect(s.rooms.get('r1')).toMatchObject({ floorId: 'geral', pos: { x: -1, y: 0 } });
    expect(s.rooms.get('r2')?.floorId).toBe('geral');
    expect(s.rooms.get('r2')?.pos).toBeDefined();
  });

  it('salas que apontam para um andar que não existe mais também vão para o "Geral"', () => {
    const file = path.join(tempDir('store'), 'state.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        floors: [{ id: 'f1', name: 'Empresa', color: '#7aa2f7', order: 1, createdAt: 1 }],
        rooms: [
          { id: 'ok', name: 'a', path: '/a', createdAt: 1, floorId: 'f1', pos: { x: 2, y: 0 } },
          { id: 'orfa', name: 'b', path: '/b', createdAt: 2, floorId: 'sumiu', pos: { x: 2, y: 0 } },
        ],
        agents: [],
      }),
    );
    const s = new Store(file);
    s.load();
    expect(s.rooms.get('ok')?.floorId).toBe('f1');
    expect(s.rooms.get('orfa')?.floorId).toBe('geral');
  });

  it('sala que vai para o "Geral" não fica em cima de outra que já está na mesma vaga', () => {
    const file = path.join(tempDir('store'), 'state.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        floors: [{ id: 'geral', name: 'Geral', color: '#7aa2f7', order: 1, createdAt: 1 }],
        rooms: [
          { id: 'dona', name: 'a', path: '/a', createdAt: 1, floorId: 'geral', pos: { x: 2, y: 0 } },
          { id: 'orfa', name: 'b', path: '/b', createdAt: 2, floorId: 'sumiu', pos: { x: 2, y: 0 } },
        ],
        agents: [],
      }),
    );
    const s = new Store(file);
    s.load();
    expect(s.rooms.get('dona')?.pos).toEqual({ x: 2, y: 0 });
    expect(s.rooms.get('orfa')?.pos).not.toEqual({ x: 2, y: 0 });
    expect(s.rooms.get('orfa')?.pos).toBeDefined();
  });

  it('salas na coluna em cima do elevador mudam de vaga: ali agora ficam as salas de guerra', () => {
    const file = path.join(tempDir('store'), 'state.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        floors: [{ id: 'geral', name: 'Geral', color: '#7aa2f7', order: 1, createdAt: 1 }],
        rooms: [
          { id: 'na-coluna', name: 'a', path: '/a', createdAt: 1, floorId: 'geral', pos: { x: 0, y: 1 } },
          { id: 'fora', name: 'b', path: '/b', createdAt: 2, floorId: 'geral', pos: { x: 1, y: 1 } },
        ],
        agents: [],
      }),
    );
    const s = new Store(file);
    s.load();
    expect(s.rooms.get('fora')?.pos).toEqual({ x: 1, y: 1 });
    const moved = s.rooms.get('na-coluna')?.pos;
    expect(moved).toBeDefined();
    expect(moved!.x).not.toBe(0);
  });

  it('incidentes abertos sobrevivem ao reinício', async () => {
    const file = path.join(tempDir('store'), 'state.json');
    const s1 = new Store(file);
    s1.putIncident({ id: 'i1', floorId: 'geral', slot: 0, title: '503', description: '', createdAt: 1, participants: ['a1'], messages: [], file: '/x.md' });
    await waitFor(() => fs.existsSync(file), 2000, 'state.json');
    const s2 = new Store(file);
    s2.load();
    expect(s2.incidents.get('i1')).toMatchObject({ title: '503', participants: ['a1'] });
    expect(s2.snapshot().incidents).toHaveLength(1);
    expect(s2.warRoomsOf('geral')).toBe(1);
  });

  it('o estado enviado ao navegador traz os andares em ordem', () => {
    const s = new Store(path.join(tempDir('store'), 'state.json'));
    s.putFloor({ id: 'b', name: 'B', color: '#000000', order: 2, createdAt: 0 });
    s.putFloor({ id: 'a', name: 'A', color: '#000000', order: 1, createdAt: 0 });
    expect(s.snapshot().floors.map((f) => f.id)).toEqual(['a', 'b']);
    expect(s.roomsOn('a')).toEqual([]);
  });
});
