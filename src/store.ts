import type Anthropic from '@anthropic-ai/sdk';
import type { Mode } from './prompt';
import type { SkillMap } from './markdown';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: Anthropic.Beta.BetaContentBlockParam[] | string;
  ts?: number;
}

export interface Usage { input: number; output: number; cacheWrite: number; cacheRead: number; cost: number }

export interface Session {
  id: string;
  title: string;
  mode: Mode;
  created: number;
  updated: number;
  messages: StoredMessage[];
  usage: Usage;
  skillmap?: SkillMap | null;
}

export interface Settings {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  speechLang: string;
  penOnly: boolean;
  fontScale: number;
}

const SETTINGS_KEY = 'mt.settings.v1';
export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'claude-opus-5-5',
  effort: 'medium',
  speechLang: navigator.language || 'en-US',
  penOnly: false,
  fontScale: 1,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export function saveSettings(s: Settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function uiPref<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem('mt.ui.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function setUiPref(key: string, v: unknown) {
  try { localStorage.setItem('mt.ui.' + key, JSON.stringify(v)); } catch { /* ignore */ }
}

// ---------- IndexedDB ----------
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('math-tutor', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('boards')) d.createObjectStore('boards', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r ? (r.result as T) : (undefined as T));
    t.onerror = () => reject(t.error);
  }));
}

export const listSessions = () => tx<Session[]>('sessions', 'readonly', (s) => s.getAll())
  .then((all) => all.sort((a, b) => b.updated - a.updated));
export const getSession = (id: string) => tx<Session | undefined>('sessions', 'readonly', (s) => s.get(id));
export const putSession = (sess: Session) => tx('sessions', 'readwrite', (s) => { s.put(sess); });
export const deleteSession = async (id: string) => {
  await tx('sessions', 'readwrite', (s) => { s.delete(id); });
  await tx('boards', 'readwrite', (s) => { s.delete(id); });
};

export interface BoardRecord { id: string; data: unknown }
export const getBoard = (id: string) => tx<BoardRecord | undefined>('boards', 'readonly', (s) => s.get(id));
export const putBoard = (rec: BoardRecord) => tx('boards', 'readwrite', (s) => { s.put(rec); });

export function newSession(mode: Mode): Session {
  const now = Date.now();
  return {
    id: crypto.randomUUID?.() ?? String(now) + Math.random().toString(36).slice(2),
    title: 'New session', mode, created: now, updated: now, messages: [],
    usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
  };
}

export async function exportAll(): Promise<string> {
  const sessions = await listSessions();
  return JSON.stringify({ app: 'math-tutor', version: 1, exported: new Date().toISOString(), sessions }, null, 1);
}

export async function importAll(json: string): Promise<number> {
  const data = JSON.parse(json);
  const sessions: Session[] = Array.isArray(data) ? data : data.sessions;
  if (!Array.isArray(sessions)) throw new Error('Not a Math Tutor export file');
  let n = 0;
  for (const s of sessions) {
    if (s && typeof s.id === 'string' && Array.isArray(s.messages)) { await putSession(s); n++; }
  }
  return n;
}
