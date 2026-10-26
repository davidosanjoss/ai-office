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
