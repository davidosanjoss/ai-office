import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMsg } from '../shared/types.ts';

export const PORT = Number(process.env.AI_OFFICE_PORT);
export const BASE = `http://127.0.0.1:${PORT}`;

/** Espera uma condição ficar verdadeira (ou devolver um valor), checando a cada 50 ms. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeout = 8000, what = 'condição'): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Tempo esgotado esperando ${what}${last ? `: ${String(last)}` : ''}`);
}

/** Pasta temporária nova dentro da pasta do teste atual. */
export function tempDir(name: string): string {
  const dir = path.join(process.env.AI_OFFICE_TMP!, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Repositório git com um commit na branch main. */
export function makeRepo(name: string): string {
  const dir = tempDir(name);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# teste\n');
  git('add', '.');
  git('commit', '-q', '-m', 'primeiro commit');
  return dir;
}

export async function api<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json().catch(() => undefined)) as T };
}

/** Cliente WebSocket que guarda todas as mensagens e a saída de cada terminal. */
export class WsClient {
  ws: WebSocket;
  messages: ServerMsg[] = [];
  output = new Map<string, string>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      this.messages.push(msg);
      if (msg.t === 'out') {
        this.output.set(msg.id, (this.output.get(msg.id) ?? '') + msg.data);
        // Responde como um terminal de verdade (o xterm do navegador faz isso sozinho): no Windows
        // o ConPTY pergunta a posição do cursor ao abrir e segura a entrada até ter resposta.
        if (msg.data.includes('\x1b[6n')) this.send({ t: 'in', id: msg.id, data: '\x1b[1;1R' });
      }
      if (msg.t === 'replay') this.output.set(msg.id, msg.data);
    });
  }

  static async connect(): Promise<WsClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new WsClient(ws);
  }

  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }

  type(id: string, text: string) {
    this.send({ t: 'in', id, data: text });
  }

  out(id: string) {
    return this.output.get(id) ?? '';
  }

  close() {
    this.ws.close();
  }
}
