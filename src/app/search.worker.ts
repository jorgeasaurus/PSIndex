/// <reference lib="webworker" />
import { artifactPath } from './artifacts';
import { SOURCES, fetchAsset, queryTokens, scopeOf } from './sources';
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

type Search = { id: number; q: string; filters: Filters };
let lastSearch: Search | null = null;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);
const encodeRef = (L: Loaded, i: number) => (L.si << SHIFT) | i;
const decodeRef = (all: Loaded[], ref: number): [Loaded, number] => [all[ref >>> SHIFT], ref & ROW_MASK];

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

async function loadSource(si: number): Promise<Loaded> {
  const { id } = SOURCES[si];
  const shard = await fetchAsset<IndexShard>(artifactPath.shard(id));
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
  const desc = await fetchAsset<string[]>(artifactPath.desc(L.id)).catch(() => null);
  if (!desc) return; // descriptions only refine ranking; without them names still search
  L.desc = desc;
  L.ldesc = desc.map((d) => d.toLowerCase());
}

/**
 * The loaded index. Every search and request waits on it, so nothing reads a half-loaded index.
 * A failed load is reported once ('load-error'); searches and requests then go unanswered.
 */
const index = Promise.all(SOURCES.map((_, si) => loadSource(si)));

index.then(async (all) => {
  // Descriptions are bigger and only refine ranking; fetch them after the first result set is out.
  await Promise.all(all.map(loadDescriptions));
  // Descriptions refine matching and the rows' text: re-run the latest search under its own id,
  // so its fresh refs replace the current ones and the list re-reads its rows.
  if (lastSearch) runSearch(all, lastSearch);
}, (e) => {
  console.error('[psindex] index load failed', e);
  post({ type: 'load-error', message: e instanceof Error ? e.message : String(e) });
});

/**
 * Literal match of one lower-cased query token (see queryTokens) against row i, best first:
 * whole name, name prefix, noun prefix, anywhere in the name, the name without hyphens
 * ("getmguser"), then the description. 0 when the token does not occur.
 */
function literalScore(tt: string, L: Loaded, i: number): number {
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
  if (L.ldesc?.[i].includes(tt)) return 60;
  return 0;
}

/** Edits a typo may contain: none below 5 letters, one up to 10, two beyond. */
const typoBudget = (len: number) => (len < 5 ? 0 : len <= 10 ? 1 : 2);

/**
 * Fewest edits (insert, delete, substitute, swap neighbours) turning `t` into some prefix of `s`
 * whose length is within `max` of t's, or max + 1 once it is certainly more. One table, so every
 * prefix length is checked in a single pass.
 */
function prefixDistance(t: string, s: string, max: number): number {
  const cols = Math.min(s.length, t.length + max);
  let prev2: number[] = [];
  let prev = Array.from({ length: cols + 1 }, (_, j) => j);
  for (let i = 1; i <= t.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= cols; j++) {
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (t[i - 1] === s[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && t[i - 1] === s[j - 2] && t[i - 2] === s[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      cur.push(d);
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  let best = max + 1;
  for (let j = Math.max(0, t.length - max); j <= cols; j++) best = Math.min(best, prev[j]);
  return best;
}

/**
 * A misspelt token: within the typo budget of the start of the name, the noun, or the name
 * without hyphens. Only used for a token that occurs literally nowhere in scope, so typo matches
 * never crowd out real ones.
 */
function typoScore(tt: string, L: Loaded, i: number): number {
  const max = typoBudget(tt.length);
  if (!max) return 0;
  let best = max + 1;
  for (const s of [L.lname[i], L.lnoun[i], L.lflat[i]]) if (s) best = Math.min(best, prefixDistance(tt, s, max));
  return best > max ? 0 : 300 - 100 * best - Math.min(60, L.lname[i].length - tt.length);
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

function runSearch(all: Loaded[], { id, q, filters }: Search) {
  const t0 = performance.now();
  const tokens = queryTokens(q);
  const { sources, perSourceFacets } = scopeOf(filters.source);
  const scope = all.filter((L) => sources.some((s) => s.id === L.id));
  // A token with no literal match anywhere in scope (under the filters) is treated as a typo.
  const misspelt = tokens.map((t) => !scope.some((L) => L.shard.n.some((_, i) => passes(L, i, filters) && literalScore(t, L, i) > 0)));
  const hits: { ref: number; score: number; len: number }[] = [];
  for (const L of scope) {
    for (let i = 0; i < L.shard.n.length; i++) {
      if (!passes(L, i, filters)) continue;
      let score = tokens.length ? 0 : 1; // no query: everything matches, in index order
      for (let k = 0; k < tokens.length; k++) {
        const s = misspelt[k] ? typoScore(tokens[k], L, i) : literalScore(tokens[k], L, i);
        if (!s) { score = 0; break; }
        score += s;
      }
      if (score) hits.push({ ref: encodeRef(L, i), score, len: L.shard.n[i].length });
    }
  }
  if (tokens.length) hits.sort((a, b) => b.score - a.score || a.len - b.len || a.ref - b.ref);
  const refs = Int32Array.from(hits, (h) => h.ref);
  post({ type: 'results', id, q, refs, facets: facetsFor(scope, perSourceFacets), ms: performance.now() - t0, described: scope.every((L) => L.ldesc) }, [refs.buffer]);
}

function rowOf(all: Loaded[], ref: number): Row {
  const [L, i] = decodeRef(all, ref);
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
    moduleVersion: s.fileVersions[s.f[i]],
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
function refOfKey(all: Loaded[], key: string): number | null {
  // Links are matched case-insensitively throughout: people retype and re-case them.
  const { source, name, module } = parseKey(key.toLowerCase());
  const L = all.find((x) => x.id === source);
  if (!L) return null;
  let first = -1;
  for (let i = 0; i < L.lname.length; i++) {
    if (L.lname[i] !== name) continue;
    if (!module || L.shard.mods[L.shard.m[i]].toLowerCase() === module) return encodeRef(L, i);
    if (first < 0) first = i;
  }
  return first < 0 ? null : encodeRef(L, first);
}

function related(all: Loaded[], key: string): Row[] {
  const ref = refOfKey(all, key);
  if (ref === null) return [];
  const [L, i] = decodeRef(all, ref);
  const out: Row[] = [];
  const noun = L.lnoun[i];
  for (let j = 0; noun && j < L.shard.n.length && out.length < 30; j++) {
    if (j !== i && L.lnoun[j] === noun) out.push(rowOf(all, encodeRef(L, j)));
  }
  return out.sort((a, b) => a.verb.localeCompare(b.verb));
}

/** One handler per request; the compiler checks each reply against Requests in types.ts. */
const handlers: { [K in RequestType]: (all: Loaded[], args: Requests[K]['args']) => Requests[K]['reply'] } = {
  rows: (all, { refs }) => refs.map((ref) => rowOf(all, ref)),
  related: (all, { key }) => related(all, key),
  find: (all, { key }) => {
    const ref = refOfKey(all, key);
    return ref === null ? null : rowOf(all, ref);
  },
};

/** Dispatch a request to its handler. TypeScript can't correlate m.type with m.args across the union, hence the one cast. */
const answer = (all: Loaded[], m: Exclude<ToWorker, { type: 'search' }>) => handlers[m.type](all, m.args as never);

// Messages are handled in arrival order: each waits on the same `index` promise, whose callbacks run in order.
self.onmessage = ({ data: m }: MessageEvent<ToWorker>) => {
  if (m.type === 'search') {
    lastSearch = m;
    // Only the latest search is worth running; older ones that queued behind the load are dropped.
    index.then((all) => { if (m === lastSearch) runSearch(all, m); }, () => {});
    return;
  }
  // After a failed load nothing is answered: the page shows the load error instead.
  index.then((all) => post({ type: 'reply', id: m.id, reply: answer(all, m) }), () => {});
};
