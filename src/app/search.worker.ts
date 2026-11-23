/// <reference lib="webworker" />
import { SOURCES, assetUrl, queryTokens, scopeOf } from './sources';
import type { Facets, Filters, FromWorker, IndexShard, RequestType, Requests, Row, ToWorker } from './types';

const SHIFT = 20; // ref = (sourceIndex << SHIFT) | rowIndex
const ROW_MASK = (1 << SHIFT) - 1;

interface Loaded {
  si: number;
  id: string;
  shard: IndexShard;
  lname: string[];
  lflat: string[]; // name without hyphens, so "getmguser" finds Get-MgUser
  lnoun: string[];
  dup: Uint8Array; // 1 where the name repeats within this source (Entra v1.0/beta, Teams/Skype…)
  desc: string[] | null;
  ldesc: string[] | null;
}

let loaded: Loaded[] | null = null;
let lastSearch: { id: number; q: string; filters: Filters } | null = null;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);
const encodeRef = (L: Loaded, i: number) => (L.si << SHIFT) | i;
const decodeRef = (ref: number): [Loaded, number] => [loaded![ref >>> SHIFT], ref & ROW_MASK];

/**
 * Row identity used in links: `source:name`, qualified as `source:name@module` when the name
 * repeats within its source. Cmdlet names never contain ':' or '@'.
 */
const keyOf = (L: Loaded, i: number) => `${L.id}:${L.shard.n[i]}${L.dup[i] ? '@' + L.shard.mods[L.shard.m[i]] : ''}`;
function parseKey(key: string) {
  const [source, rest = ''] = key.split(':');
  const [name, module = ''] = rest.split('@');
  return { source, name, module };
}

async function getJson<T>(file: string): Promise<T> {
  const url = new URL(assetUrl(`idx/${file}`), self.location.origin);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.pathname}`);
  return r.json();
}

async function loadSource(si: number): Promise<Loaded> {
  const { id } = SOURCES[si];
  const shard = await getJson<IndexShard>(`${id}.json`);
  const lname = shard.n.map((n) => n.toLowerCase());
  const count = new Map<string, number>();
  for (const n of shard.n) count.set(n, (count.get(n) ?? 0) + 1);
  return {
    si,
    id,
    shard,
    lname,
    lflat: lname.map((n) => n.replace(/-/g, '')),
    lnoun: lname.map((n) => (n.indexOf('-') > 0 ? n.slice(n.indexOf('-') + 1) : '')),
    dup: Uint8Array.from(shard.n, (n) => (count.get(n)! > 1 ? 1 : 0)),
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
  // Descriptions refine matching and the rows' text: let the client drop its cached rows,
  // then re-run the latest search under its own id so its results replace the current ones.
  post({ type: 'desc-ready' });
  if (lastSearch) runSearch(lastSearch);
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

/** `t` is a lower-cased query token (see queryTokens). */
function scoreToken(tt: string, L: Loaded, i: number): number {
  const name = L.lname[i];
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
  if (L.ldesc?.[i].includes(tt)) return 60;
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

function facetsFor(scope: Loaded[], perSource: boolean): Facets {
  const uniq = (pick: (s: IndexShard) => string[]) =>
    [...new Set(scope.flatMap((L) => pick(L.shard)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    verbs: uniq((s) => s.verbs),
    modules: perSource ? uniq((s) => s.mods) : [],
    categories: uniq((s) => s.cats),
    extras: perSource ? uniq((s) => s.extras) : [],
  };
}

function runSearch({ id, q, filters }: { id: number; q: string; filters: Filters }) {
  if (!loaded) return;
  const t0 = performance.now();
  const tokens = queryTokens(q);
  const { sources, perSourceFacets } = scopeOf(filters.source);
  const scope = loaded.filter((L) => sources.some((s) => s.id === L.id));
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
  post({ type: 'results', id, refs, facets: facetsFor(scope, perSourceFacets), ms: performance.now() - t0 }, [refs.buffer]);
}

function rowOf(ref: number): Row {
  const [L, i] = decodeRef(ref);
  const s = L.shard;
  return {
    key: keyOf(L, i),
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
    dup: !!L.dup[i],
  };
}

/**
 * Resolve a link key: the row with that name and module, else the first row with that name
 * (an old unqualified link, or a module that no longer applies). Names match case-insensitively.
 */
function refOfKey(key: string): number | null {
  const { source, name, module } = parseKey(key);
  const L = loaded!.find((x) => x.id === source);
  if (!L) return null;
  const lower = name.toLowerCase();
  let first = -1;
  for (let i = 0; i < L.lname.length; i++) {
    if (L.lname[i] !== lower) continue;
    if (!module || L.shard.mods[L.shard.m[i]] === module) return encodeRef(L, i);
    if (first < 0) first = i;
  }
  return first < 0 ? null : encodeRef(L, first);
}

function related(key: string): Row[] {
  const ref = refOfKey(key);
  if (ref === null) return [];
  const [L, i] = decodeRef(ref);
  const out: Row[] = [];
  const noun = L.lnoun[i];
  for (let j = 0; noun && j < L.shard.n.length && out.length < 30; j++) {
    if (j !== i && L.lnoun[j] === noun) out.push(rowOf(encodeRef(L, j)));
  }
  return out.sort((a, b) => a.verb.localeCompare(b.verb));
}

/** One handler per request; the compiler checks each reply against Requests in types.ts. */
const handlers: { [K in RequestType]: (args: Requests[K]['args']) => Requests[K]['reply'] } = {
  rows: ({ refs }) => refs.map(rowOf),
  related: ({ key }) => related(key),
  find: ({ key }) => {
    const ref = refOfKey(key);
    return ref === null ? null : rowOf(ref);
  },
};

/** Dispatch a request to its handler. TypeScript can't correlate m.type with m.args across the union, hence the one cast. */
const answer = (m: Exclude<ToWorker, { type: 'search' }>) => handlers[m.type](m.args as never);

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
