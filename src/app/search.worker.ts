/// <reference lib="webworker" />
import { BUILD, KINDS, SOURCES, type KindSpec } from './sources';
import type { Facets, Filters, FromWorker, IndexShard, Row, ToWorker } from './types';

const SHIFT = 20; // ref = (sourceIndex << SHIFT) | rowIndex
const ROW_MASK = (1 << SHIFT) - 1;

interface Loaded {
  si: number;
  id: string;
  kind: KindSpec;
  shard: IndexShard;
  lname: string[];
  lflat: string[]; // name without hyphens, so "getmguser" finds Get-MgUser
  lnoun: string[];
  keys: string[]; // stable row identity; disambiguated by module when a name repeats in a source
  desc: string[] | null;
  ldesc: string[] | null;
}

let loaded: Loaded[] | null = null;
let lastSearch: { id: number; q: string; filters: Filters } | null = null;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);
const encodeRef = (L: Loaded, i: number) => (L.si << SHIFT) | i;
const decodeRef = (ref: number): [Loaded, number] => [loaded![ref >>> SHIFT], ref & ROW_MASK];

async function getJson<T>(file: string): Promise<T> {
  const url = new URL(`/idx/${file}`, self.location.origin);
  url.searchParams.set('v', BUILD); // same build as this worker, so shards never mix across deploys
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.pathname}`);
  return r.json();
}

async function loadSource(si: number): Promise<Loaded> {
  const { id, kind } = SOURCES[si];
  const spec = KINDS[kind];
  const shard = await getJson<IndexShard>(`${id}.json`);
  const lname = shard.n.map(spec.normalize);
  const count = new Map<string, number>();
  for (const n of shard.n) count.set(n, (count.get(n) ?? 0) + 1);
  return {
    si,
    id,
    kind: spec,
    shard,
    lname,
    lflat: lname.map((n) => n.replace(/-/g, '')),
    lnoun: shard.n.map((n) => (n.indexOf('-') > 0 ? n.slice(n.indexOf('-') + 1).toLowerCase() : '')),
    keys: shard.n.map((n, i) => (count.get(n)! > 1 ? `${id}:${n}@${shard.mods[shard.m[i]]}` : `${id}:${n}`)),
    desc: null,
    ldesc: null,
  };
}

async function loadDescriptions(L: Loaded) {
  const desc = await getJson<string[]>(`${L.id}.desc.json`).catch(() => null);
  if (!desc || desc.length !== L.shard.n.length) return; // never pair mismatched shards
  L.desc = desc;
  L.ldesc = desc.map((d) => d.toLowerCase());
}

async function load() {
  loaded = await Promise.all(SOURCES.map((_, si) => loadSource(si)));
  post({ type: 'ready' });
  if (lastSearch) runSearch(lastSearch);

  // Descriptions are bigger and only refine ranking; fetch them after the first result set is out.
  await Promise.all(loaded.map(loadDescriptions));
  post({ type: 'desc-ready' });
  if (lastSearch?.q.trim()) runSearch(lastSearch);
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
  const tt = L.kind.normalize(t);
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
    // Typo tolerance: subsequence with long contiguous runs only.
    const f = fuzzy(tt, name);
    const perfect = (tt.length * (tt.length + 1)) / 2;
    if (f >= perfect * 0.45) return 120 + Math.round((f / perfect) * 80) - Math.min(60, name.length - tt.length);
  }
  if (L.ldesc?.[i].includes(t)) return 60;
  return 0;
}

function passes(L: Loaded, i: number, f: Filters): boolean {
  const s = L.shard;
  return (
    (!f.verb || s.verbs[s.v[i]] === f.verb) &&
    (!f.module || s.mods[s.m[i]] === f.module) &&
    (!f.category || s.cats[s.c[i]] === f.category) &&
    (!f.extra || s.extras[s.x[i]] === f.extra) &&
    (!f.examples || !!s.e[i])
  );
}

function facetsFor(scope: Loaded[], all: boolean): Facets {
  const uniq = (pick: (s: IndexShard) => string[]) =>
    [...new Set(scope.flatMap((L) => pick(L.shard)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    verbs: uniq((s) => s.verbs),
    modules: all ? [] : uniq((s) => s.mods),
    categories: uniq((s) => s.cats),
    extras: all ? [] : uniq((s) => s.extras),
  };
}

function runSearch({ id, q, filters }: { id: number; q: string; filters: Filters }) {
  if (!loaded) return;
  const t0 = performance.now();
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scope = filters.source === 'all' ? loaded : loaded.filter((L) => L.id === filters.source);
  const hits: { ref: number; score: number; len: number }[] = [];
  for (const L of scope) {
    for (let i = 0; i < L.shard.n.length; i++) {
      if (!passes(L, i, filters)) continue;
      let score = tokens.length ? 0 : 1; // no query: everything matches, in index order
      for (const t of tokens) {
        const s = scoreToken(t, L, i);
        if (!s) { score = 0; break; }
        score += s;
      }
      if (score) hits.push({ ref: encodeRef(L, i), score, len: L.shard.n[i].length });
    }
  }
  if (tokens.length) hits.sort((a, b) => b.score - a.score || a.len - b.len || a.ref - b.ref);
  const refs = Int32Array.from(hits, (h) => h.ref);
  post({ type: 'results', id, refs, facets: facetsFor(scope, filters.source === 'all'), ms: performance.now() - t0 }, [refs.buffer]);
}

function rowOf(ref: number): Row {
  const [L, i] = decodeRef(ref);
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
    desc: L.desc?.[i] ?? '',
    dup: L.keys[i].includes('@'),
  };
}

/** Exact key, else the name (an old link, or a module qualifier that no longer applies), else case-insensitive. */
function refOfKey(key: string): number | null {
  const c = key.indexOf(':');
  const L = loaded!.find((x) => x.id === key.slice(0, c));
  if (!L) return null;
  const name = key.slice(c + 1).split('@')[0];
  const lower = name.toLowerCase();
  const candidates = [L.keys.indexOf(key), L.shard.n.indexOf(name), L.shard.n.findIndex((n) => n.toLowerCase() === lower)];
  const i = candidates.find((x) => x >= 0);
  return i === undefined ? null : encodeRef(L, i);
}

function related(key: string): Row[] {
  const ref = refOfKey(key);
  if (ref === null) return [];
  const [L, i] = decodeRef(ref);
  const out: Row[] = [];
  if (L.kind.related === 'neighbours') {
    for (let j = Math.max(0, i - 6); j < Math.min(L.shard.n.length, i + 7); j++) {
      if (j !== i && L.shard.m[j] === L.shard.m[i]) out.push(rowOf(encodeRef(L, j)));
    }
    return out;
  }
  const noun = L.lnoun[i];
  for (let j = 0; noun && j < L.shard.n.length && out.length < 30; j++) {
    if (j !== i && L.lnoun[j] === noun) out.push(rowOf(encodeRef(L, j)));
  }
  return out.sort((a, b) => a.verb.localeCompare(b.verb));
}

function answer(m: Exclude<ToWorker, { type: 'search' }>) {
  switch (m.type) {
    case 'rows': return m.args.refs.map(rowOf);
    case 'related': return related(m.args.key);
    case 'find': {
      const ref = refOfKey(m.args.key);
      return ref === null ? null : rowOf(ref);
    }
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === 'search') {
    lastSearch = m;
    runSearch(m);
    return;
  }
  // Requests only arrive after `ready` (the client waits for it), so `loaded` is set here.
  post({ type: 'reply', id: m.id, reply: answer(m) });
};

load().catch((e) => {
  console.error('[psindex] index load failed', e);
  post({ type: 'load-error', message: String(e?.message ?? e) });
});
