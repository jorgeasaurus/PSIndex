// Ranking and row lookup for one loaded index. The worker and the MCP server both call this,
// so a query cannot rank differently in the browser and over /mcp.
import { queryTokens, scopeOf } from './sources';
import type { Facets, Filters, IndexShard, Row } from './types';

const SHIFT = 20; // ref = (sourceIndex << SHIFT) | rowIndex
const ROW_MASK = (1 << SHIFT) - 1;

export interface Loaded {
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

export function prepareSource(si: number, id: string, shard: IndexShard): Loaded {
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

/** Descriptions refine ranking. Names still search when a shard is missing. */
export function setDescriptions(L: Loaded, desc: string[]) {
  L.desc = desc;
  L.ldesc = desc.map((d) => d.toLowerCase());
}

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

export interface Hit { ref: number; score: number; len: number }

/** Ranked hits for one query. No query matches everything, in index order, as the page does. */
export function searchHits(all: Loaded[], q: string, filters: Filters): Hit[] {
  const tokens = queryTokens(q);
  const { sources } = scopeOf(filters.source);
  const scope = all.filter((L) => sources.some((s) => s.id === L.id));
  const hits: Hit[] = [];
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
  return hits;
}

export function facetsFor(scope: Loaded[], perSource: boolean): Facets {
  const uniq = (pick: (s: IndexShard) => string[]) =>
    [...new Set(scope.flatMap((L) => pick(L.shard)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    verbs: uniq((s) => s.verbs),
    modules: perSource ? uniq((s) => s.mods) : [],
    categories: uniq((s) => s.cats),
    extras: perSource ? uniq((s) => s.extras) : [],
  };
}

export function rowOf(all: Loaded[], ref: number): Row {
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
export function refOfKey(all: Loaded[], key: string): number | null {
  const { source, name, module } = parseKey(key);
  const L = all.find((x) => x.id === source);
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

export function related(all: Loaded[], key: string): Row[] {
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

/** Every row with this exact name. `module`, when set, is compared case-insensitively. */
export function rowsNamed(all: Loaded[], name: string, module?: string): Row[] {
  const lower = name.toLowerCase();
  const want = module?.toLowerCase();
  const out: Row[] = [];
  for (const L of all) {
    for (let i = 0; i < L.lname.length; i++) {
      if (L.lname[i] !== lower) continue;
      const row = rowOf(all, encodeRef(L, i));
      if (want && row.module.toLowerCase() !== want) continue;
      out.push(row);
    }
  }
  return out;
}
