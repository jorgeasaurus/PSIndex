/// <reference lib="webworker" />
import type { Facets, Filters, FromWorker, IndexShard, Row, SourceId, ToWorker } from './types';

const ORDER: SourceId[] = ['graph', 'az', 'entra', 'exchange', 'mecm', 'errors'];
const SHIFT = 20; // ref = (sourceIndex << SHIFT) | rowIndex

interface Loaded {
  id: SourceId;
  si: number;
  shard: IndexShard;
  lname: string[];
  lflat: string[]; // name without hyphens, so "getmguser" finds Get-MgUser
  lnoun: string[];
  keys: string[]; // stable row identity; disambiguated by module when a name repeats in a source
  ldesc: string[] | null;
  desc: string[] | null;
  isError: boolean;
}

const loaded: (Loaded | undefined)[] = [];
let lastSearch: { id: number; q: string; filters: Filters } | null = null;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

const normCode = (s: string) => s.toLowerCase().replace(/^0x/, '').replace(/^-/, '');

async function getJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.pathname}`);
  return r.json();
}

async function load() {
  const base = new URL('/idx/', self.location.origin);
  const { build } = await getJson<{ build: string }>(new URL('sources.json', base), { cache: 'no-cache' });
  const shardUrl = (file: string) => { const u = new URL(file, base); u.searchParams.set('v', build); return u; };
  await Promise.all(
    ORDER.map(async (id, si) => {
      const shard = await getJson<IndexShard>(shardUrl(`${id}.json`));
      const isError = id === 'errors';
      const lname = shard.n.map((n) => (isError ? normCode(n) : n.toLowerCase()));
      const lnoun = shard.n.map((n) => {
        const i = n.indexOf('-');
        return i > 0 ? n.slice(i + 1).toLowerCase() : '';
      });
      const lflat = lname.map((n) => n.replace(/-/g, ''));
      const seen = new Map<string, number>();
      for (const n of shard.n) seen.set(n, (seen.get(n) ?? 0) + 1);
      const keys = shard.n.map((n, i) => (seen.get(n)! > 1 ? `${id}:${n}@${shard.mods[shard.m[i]]}` : `${id}:${n}`));
      loaded[si] = { id, si, shard, lname, lflat, lnoun, keys, ldesc: null, desc: null, isError };
    }),
  );
  post({ type: 'ready', sources: ORDER });
  if (lastSearch) runSearch(lastSearch.id, lastSearch.q, lastSearch.filters);

  // Descriptions are bigger and only refine ranking; fetch them after the first result set is out.
  await Promise.all(
    loaded.map(async (L) => {
      if (!L) return;
      const desc = await getJson<string[]>(shardUrl(`${L.id}.desc.json`)).catch(() => null);
      if (!desc || desc.length !== L.shard.n.length) return; // never pair mismatched shards
      L.desc = desc;
      L.ldesc = desc.map((d) => d.toLowerCase());
    }),
  );
  post({ type: 'desc-ready' });
  if (lastSearch && lastSearch.q.trim()) runSearch(lastSearch.id, lastSearch.q, lastSearch.filters);
}

function fuzzy(t: string, s: string): number {
  // Subsequence match; rewards contiguous runs. Returns 0 when not a subsequence.
  let si = 0, run = 0, score = 0;
  for (let ti = 0; ti < t.length; ti++) {
    const ch = t.charCodeAt(ti);
    let found = false;
    while (si < s.length) {
      if (s.charCodeAt(si++) === ch) { found = true; break; }
      run = 0;
    }
    if (!found) return 0;
    run++;
    score += run;
  }
  return score;
}

function scoreToken(t: string, L: Loaded, i: number): number {
  const name = L.lname[i];
  const tt = L.isError ? normCode(t) : t;
  if (name === tt) return 1000;
  if (name.startsWith(tt)) return 800 - Math.min(100, name.length - tt.length);
  const noun = L.lnoun[i];
  if (noun && noun.startsWith(tt)) return 700 - Math.min(100, noun.length - tt.length);
  const at = name.indexOf(tt);
  if (at >= 0) return 520 - Math.min(120, at);
  const flatT = tt.replace(/-/g, '');
  if (flatT !== tt || flatT.length >= 4) {
    const fa = L.lflat[i].indexOf(flatT);
    if (fa >= 0) return 480 - Math.min(120, fa);
  }
  if (tt.length >= 4) {
    // Typo tolerance: subsequence with long contiguous runs only (score ≥ ~70% of a perfect run).
    const f = fuzzy(tt, name);
    const perfect = (tt.length * (tt.length + 1)) / 2;
    if (f >= perfect * 0.45) return 120 + Math.round((f / perfect) * 80) - Math.min(60, name.length - tt.length);
  }
  if (L.ldesc && L.ldesc[i].includes(t)) return 60;
  return 0;
}

function passes(L: Loaded, i: number, f: Filters): boolean {
  const s = L.shard;
  if (f.verb && s.verbs[s.v[i]] !== f.verb) return false;
  if (f.module && s.mods[s.m[i]] !== f.module) return false;
  if (f.category && s.cats[s.c[i]] !== f.category) return false;
  if (f.extra && s.extras[s.x[i]] !== f.extra) return false;
  if (f.examples && !s.e[i]) return false;
  return true;
}

function facetsFor(f: Filters): Facets {
  const pick = f.source === 'all' ? loaded.filter(Boolean) as Loaded[] : (loaded.filter((L) => L?.id === f.source) as Loaded[]);
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    verbs: uniq(pick.flatMap((L) => L.shard.verbs)),
    modules: f.source === 'all' ? [] : uniq(pick.flatMap((L) => L.shard.mods)),
    categories: uniq(pick.flatMap((L) => L.shard.cats)),
    extras: f.source === 'all' ? [] : uniq(pick.flatMap((L) => L.shard.extras)),
  };
}

function runSearch(id: number, q: string, filters: Filters) {
  const t0 = performance.now();
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { ref: number; score: number; len: number }[] = [];
  const plain: number[] = [];
  for (const L of loaded) {
    if (!L) continue;
    if (filters.source !== 'all' && filters.source !== L.id) continue;
    const n = L.shard.n.length;
    for (let i = 0; i < n; i++) {
      if (!passes(L, i, filters)) continue;
      const ref = (L.si << SHIFT) | i;
      if (!tokens.length) { plain.push(ref); continue; }
      let score = 0;
      for (const t of tokens) {
        const s = scoreToken(t, L, i);
        if (!s) { score = 0; break; }
        score += s;
      }
      if (score) hits.push({ ref, score, len: L.shard.n[i].length });
    }
  }
  let refs: Int32Array;
  if (tokens.length) {
    hits.sort((a, b) => b.score - a.score || a.len - b.len || a.ref - b.ref);
    refs = Int32Array.from(hits, (h) => h.ref);
  } else {
    refs = Int32Array.from(plain);
  }
  post({ type: 'results', id, refs, total: refs.length, facets: facetsFor(filters), ms: performance.now() - t0 }, [refs.buffer]);
}

function rowOf(ref: number): Row {
  const L = loaded[ref >>> SHIFT]!;
  const i = ref & ((1 << SHIFT) - 1);
  const s = L.shard;
  return {
    key: L.keys[i],
    source: L.id,
    name: s.n[i],
    verb: s.verbs[s.v[i]],
    module: s.mods[s.m[i]],
    category: s.cats[s.c[i]],
    extra: s.extras[s.x[i]],
    file: s.files[s.f[i]],
    perms: s.p[i],
    examples: !!s.e[i],
    desc: L.desc ? L.desc[i] : '',
    dup: L.keys[i].includes('@'),
  };
}

function refOfKey(key: string): number {
  const c = key.indexOf(':');
  const id = key.slice(0, c) as SourceId;
  const L = loaded.find((x) => x?.id === id);
  if (!L) return -1;
  const exact = L.keys.indexOf(key);
  if (exact >= 0) return (L.si << SHIFT) | exact;
  const name = key.slice(c + 1).split('@')[0]; // old link, or a module qualifier that no longer applies
  const i = L.shard.n.indexOf(name);
  if (i < 0) {
    const j = L.shard.n.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    return j < 0 ? -1 : (L.si << SHIFT) | j;
  }
  return (L.si << SHIFT) | i;
}

function related(key: string): Row[] {
  const ref = refOfKey(key);
  if (ref < 0) return [];
  const L = loaded[ref >>> SHIFT]!;
  const i = ref & ((1 << SHIFT) - 1);
  if (L.isError) {
    // Neighbouring codes in the same product & category.
    const out: Row[] = [];
    for (let j = Math.max(0, i - 6); j < Math.min(L.shard.n.length, i + 7); j++) {
      if (j !== i && L.shard.m[j] === L.shard.m[i]) out.push(rowOf((L.si << SHIFT) | j));
    }
    return out;
  }
  const noun = L.lnoun[i];
  if (!noun) return [];
  const out: Row[] = [];
  for (let j = 0; j < L.shard.n.length && out.length < 30; j++) {
    if (j !== i && L.lnoun[j] === noun) out.push(rowOf((L.si << SHIFT) | j));
  }
  return out.sort((a, b) => a.verb.localeCompare(b.verb));
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'search':
      lastSearch = m;
      if (loaded.filter(Boolean).length === ORDER.length) runSearch(m.id, m.q, m.filters);
      break;
    case 'rows':
      post({ type: 'rows', id: m.id, rows: m.refs.map(rowOf) });
      break;
    case 'related':
      post({ type: 'related', id: m.id, rows: related(m.key) });
      break;
    case 'find': {
      const ref = refOfKey(m.key);
      post({ type: 'found', id: m.id, row: ref < 0 ? null : rowOf(ref) });
      break;
    }
  }
};

load().catch((e) => {
  console.error('[psindex] index load failed', e);
  post({ type: 'load-error', message: String(e?.message ?? e) });
});
