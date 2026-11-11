// Leitura do consumo de tokens. Fontes:
// - Claude Code: os transcripts em ~/.claude/projects (cada resposta traz o `usage`, o modelo,
//   a pasta e a hora). A mesma resposta aparece em várias linhas (uma por bloco): conta uma vez,
//   pelo id da mensagem.
// - Qualquer outra (Codex, Gemini, um script seu): arquivos .jsonl em ~/.ai-office/uso/entrada,
//   um UsageRecord por linha, ou a rota POST /api/uso, que grava nessa mesma pasta.
// A leitura é incremental: guarda até onde leu cada arquivo e só lê o que foi acrescentado.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PRICES, type Price, type UsageRecord, parseRecord } from '../shared/usage.ts';
import { CLAUDE_DIR, DATA_DIR } from './platform.ts';

const USAGE_DIR = path.join(DATA_DIR, 'uso');
export const INBOX_DIR = path.join(USAGE_DIR, 'entrada');
const INDEX_FILE = path.join(USAGE_DIR, 'indice.json');
const PRICES_FILE = path.join(USAGE_DIR, 'precos.json');
/** Versão do índice: mudou o jeito de ler, o índice antigo é descartado e tudo é relido. */
const INDEX_VERSION = 2;
/** Entre duas leituras, no mínimo isso (o painel pode pedir várias vezes seguidas). */
const MIN_SCAN_MS = 10_000;

interface Index {
  version: number;
  /** Até onde cada arquivo foi lido (bytes), e o tamanho na hora. */
  files: Record<string, { offset: number }>;
  records: UsageRecord[];
}

let index: Index | undefined;
let lastScan = 0;
let scanning: Promise<void> | undefined;

function loadIndex(): Index {
  if (index) return index;
  try {
    const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) as Index;
    if (data.version === INDEX_VERSION) return (index = data);
  } catch {}
  return (index = { version: INDEX_VERSION, files: {}, records: [] });
}

/** Todos os registros conhecidos, depois de ler o que é novo nas fontes. */
export async function usageRecords(force = false): Promise<UsageRecord[]> {
  const idx = loadIndex();
  if (force || Date.now() - lastScan > MIN_SCAN_MS) {
    scanning ??= scan(idx).finally(() => {
      scanning = undefined;
      lastScan = Date.now();
    });
    await scanning;
  }
  return idx.records;
}

async function scan(idx: Index) {
  const known = new Set(idx.records.map((r) => `${r.source}\u0000${r.id}`));
  let added = 0;
  const push = (r: UsageRecord | undefined) => {
    if (!r) return;
    const k = `${r.source}\u0000${r.id}`;
    if (known.has(k)) return;
    known.add(k);
    idx.records.push(r);
    added++;
  };
  for (const file of jsonlFiles(path.join(CLAUDE_DIR, 'projects'))) await readNew(idx, file, (line) => push(claudeRecord(line)));
  for (const file of jsonlFiles(INBOX_DIR)) {
    await readNew(idx, file, (line) => {
      try {
        push(parseRecord(JSON.parse(line)));
      } catch {}
    });
  }
  if (added || !fs.existsSync(INDEX_FILE)) {
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(idx));
  }
}

/** Arquivos .jsonl de uma pasta e das de dentro (os subagentes ficam em <sessão>/subagents). */
function jsonlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

/** Lê do ponto em que parou até a última linha completa do arquivo. */
async function readNew(idx: Index, file: string, onLine: (line: string) => void) {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  const state = idx.files[file] ?? { offset: 0 };
  // Arquivo menor que antes: foi reescrito, lê de novo (as respostas repetidas não contam duas vezes).
  if (size < state.offset) state.offset = 0;
  if (size === state.offset) return;
  const fd = fs.openSync(file, 'r');
  try {
    const CHUNK = 4 * 1024 * 1024;
    let pos = state.offset;
    // Trabalha em bytes: um caractere de vários bytes pode cair na divisa entre dois pedaços.
    let carry = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK);
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const data = Buffer.concat([carry, buf.subarray(0, n)]);
      const nl = data.lastIndexOf(10);
      if (nl < 0) {
        carry = data;
        continue;
      }
      for (const l of data.toString('utf8', 0, nl).split('\n')) if (l.trim()) onLine(l);
      carry = Buffer.from(data.subarray(nl + 1));
      // Não deixa o servidor parado: a leitura grande (1 GB na primeira vez) cede a vez a cada pedaço.
      await new Promise((r) => setImmediate(r));
    }
    // A última linha sem quebra pode estar sendo escrita: fica para a próxima leitura.
    state.offset = pos - carry.length;
  } finally {
    fs.closeSync(fd);
  }
  idx.files[file] = state;
}

/** Uma linha de transcript do Claude Code → registro, se ela é uma resposta com uso. */
export function claudeRecord(line: string): UsageRecord | undefined {
  if (!line.includes('"usage"')) return undefined;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return undefined;
  }
  const m = d?.message;
  const u = m?.usage;
  if (d?.type !== 'assistant' || !u || !m.model || m.model === '<synthetic>') return undefined;
  const id = m.id ?? d.requestId;
  const ts = Date.parse(d.timestamp);
  if (!id || !Number.isFinite(ts)) return undefined;
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
  const write = n(u.cache_creation_input_tokens);
  // Sem o detalhe, todo o cache gravado conta como o de 5 min.
  const w1h = u.cache_creation ? n(u.cache_creation.ephemeral_1h_input_tokens) : 0;
  return {
    source: 'claude',
    id: String(id),
    ts,
    cwd: typeof d.cwd === 'string' ? d.cwd : '',
    model: String(m.model),
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheWrite5m: Math.max(0, write - w1h),
    cacheWrite1h: w1h,
    cacheRead: n(u.cache_read_input_tokens),
    ...(typeof d.sessionId === 'string' ? { session: d.sessionId } : {}),
  };
}

/** Grava registros que chegaram pela rota na pasta de entrada (assim sobrevivem ao reinício). */
export function receiveRecords(raw: unknown): { accepted: number; rejected: number } {
  const list = Array.isArray(raw) ? raw : [raw];
  const ok = list.map(parseRecord).filter((r): r is UsageRecord => !!r);
  if (ok.length) {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    fs.appendFileSync(path.join(INBOX_DIR, 'api.jsonl'), ok.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return { accepted: ok.length, rejected: list.length - ok.length };
}

/** Preços: os padrões com os seus por cima. */
export function prices(): Record<string, Price> {
  return { ...DEFAULT_PRICES, ...customPrices() };
}

export function customPrices(): Record<string, Price> {
  try {
    return JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Grava um preço seu (ou apaga, com null: volta ao padrão, se houver). */
export function setPrice(model: string, price: Price | null) {
  const all = customPrices();
  if (price) all[model] = price;
  else delete all[model];
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  fs.writeFileSync(PRICES_FILE, JSON.stringify(all, null, 2));
}

/** Só para os testes: esquece o índice em memória e a hora da última leitura. */
export function resetUsage() {
  index = undefined;
  lastScan = 0;
}
