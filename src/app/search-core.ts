// Ranking and row lookup for one loaded index. The worker and the MCP server both call this,
// so a query cannot rank differently in the browser and over /mcp.
import { flatMatch, queryTokens, scopeOf } from './sources';
import type { Descriptions, Facets, Filters, IndexShard, Row } from './types';

const SHIFT = 20; // ref = (sourceIndex << SHIFT) | rowIndex
const ROW_MASK = (1 << SHIFT) - 1;

export interface Loaded {
  si: number;
  id: string;
  shard: IndexShard;
  lname: string[];
  lflat: string[]; // name without hyphens, so "getmguser" finds Get-MgUser
  lnoun: string[];
  words: number[][]; // where each word of the noun starts in lname (camel case: Get-MgUserLicense -> MgUserLicense, UserLicense, License)
  dup: Uint8Array; // 1 where the name repeats within this source (Entra v1.0/beta, Teams/Skype…)
  desc: string[] | null;
  ldesc: string[] | null;
  descriptions: 'loading' | 'ready' | 'failed';
}

/** Where each word of a cmdlet's noun starts: after the verb's hyphen, and at each camel-case capital. */
function wordStarts(name: string): number[] {
  const verbEnd = name.indexOf('-');
  if (verbEnd <= 0) return [];
  const out = [verbEnd + 1];
  for (let j = verbEnd + 2; j < name.length; j++) if (/[A-Z]/.test(name[j]) && /[a-z0-9]/.test(name[j - 1])) out.push(j);
  return out;
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
    words: shard.n.map(wordStarts),
    dup: Uint8Array.from(shard.n, (n) => (count.get(n)! > 1 ? 1 : 0)),
    desc: null,
    ldesc: null,
    descriptions: 'loading',
  };
}

/** Descriptions refine matching. A missing shard leaves names searchable and says the load failed. */
export function setDescriptions(L: Loaded, desc: string[] | null) {
  if (!desc) { L.descriptions = 'failed'; return; }
  L.desc = desc;
  L.ldesc = desc.map((d) => d.toLowerCase());
  L.descriptions = 'ready';
}

const encodeRef = (L: Loaded, i: number) => (L.si << SHIFT) | i;
const decodeRef = (all: Loaded[], ref: number): [Loaded, number] => [all[ref >>> SHIFT], ref & ROW_MASK];

/**
 * Row identity used in links: `source:name`, qualified as `source:name@module` when the name
 * repeats within its source. Cmdlet names never contain ':' or '@'.
 */
const keyOf = (L: Loaded, i: number) => `${L.id}:${L.shard.n[i]}${L.dup[i] ? '@' + L.shard.mods[L.shard.m[i]] : ''}`;
/** A key without its `source:` prefix (?c=Get-Mailbox, typed by hand) has source ''. */
function parseKey(key: string) {
  const colon = key.indexOf(':');
  const [name, module = ''] = key.slice(colon + 1).split('@');
  return { source: colon < 0 ? '' : key.slice(0, colon), name, module };
}

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
  const fa = flatMatch(name, L.lflat[i], tt);
  if (fa >= 0) return 480 - Math.min(120, fa);
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
  // Within max edits, one of t's first max+1 letters must sit among s's first 2*max+1: a cheap
  // test that rejects almost every candidate before the table is built.
  const head = s.slice(0, 2 * max + 1);
  let near = false;
  for (let k = 0; k <= max && k < t.length && !near; k++) near = head.includes(t[k]);
  if (!near) return max + 1;
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
 * A misspelt token: within the typo budget of the start of the name, of the hyphen-free name, or
 * of any word of the noun ("licnse" ~ the License in Set-MgUserLicense).
 */
function typoScore(tt: string, L: Loaded, i: number): number {
  const max = typoBudget(tt.length);
  if (!max) return 0;
  const name = L.lname[i];
  // Hyphens are compared against the hyphen-free name without them, so a misplaced one costs nothing.
  let best = prefixDistance(tt.replace(/-/g, ''), L.lflat[i], max);
  for (let k = -1; k < L.words[i].length && best > 0; k++) best = Math.min(best, prefixDistance(tt, k < 0 ? name : name.slice(L.words[i][k]), max));
  return best > max ? 0 : 300 - 100 * best - Math.min(60, L.lname[i].length - tt.length);
}

/**
 * The filters as a test of one source's rows. Facet values match case-insensitively, as people
 * type them in links (?verb=get is Get); each is resolved to the shard's value ids once per search.
 */
function filterOf(L: Loaded, f: Filters): (i: number) => boolean {
  const s = L.shard;
  const ids = (values: string[], want: string) => {
    if (!want) return null;
    const w = want.toLowerCase();
    return new Set(values.flatMap((v, k) => (v.toLowerCase() === w ? [k] : [])));
  };
  const verb = ids(s.verbs, f.verb), mod = ids(s.mods, f.module), cat = ids(s.cats, f.category), extra = ids(s.extras, f.extra);
  return (i) =>
    (!verb || verb.has(s.v[i])) &&
    (!mod || mod.has(s.m[i])) &&
    (!cat || cat.has(s.c[i])) &&
    (!extra || extra.has(s.x[i])) &&
    (!f.examples || !!s.e[i]);
}

export interface Hit { ref: number; score: number; len: number }

/** Ranked hits for one query. No query matches everything, in index order, as the page does. */
/**
 * The query's hits under the filters, best first. With `literal`, a token that matches nothing
 * literally gives no hits instead of falling back to typo matching: "the query matches N cmdlets"
 * must not count near misses.
 */
export function searchHits(all: Loaded[], q: string, filters: Filters, { literal = false } = {}): Hit[] {
  const tokens = queryTokens(q);
  const { sources } = scopeOf(filters.source);
  const scope = all.filter((L) => sources.some((s) => s.id === L.id)).map((L) => ({ L, passes: filterOf(L, filters) }));
  // A token with any literal hit in scope (under the filters) matches literally; one with none is
  // read as a typo. Typo matches never mix with real ones, so an exact name isn't buried in near misses.
  const typo = tokens.map((t) => !scope.some(({ L, passes }) => L.shard.n.some((_, i) => passes(i) && literalScore(t, L, i) > 0)));
  if (literal && typo.some(Boolean)) return [];
  const hits: Hit[] = [];
  for (const { L, passes } of scope) {
    for (let i = 0; i < L.shard.n.length; i++) {
      if (!passes(i)) continue;
      let score = tokens.length ? 0 : 1; // no query: everything matches, in index order
      for (let k = 0; k < tokens.length; k++) {
        const s = typo[k] ? typoScore(tokens[k], L, i) : literalScore(tokens[k], L, i);
        if (!s) { score = 0; break; }
        score += s;
      }
      if (score) hits.push({ ref: encodeRef(L, i), score, len: L.shard.n[i].length });
    }
  }
  if (tokens.length) hits.sort((a, b) => b.score - a.score || a.len - b.len || a.ref - b.ref);
  return hits;
}

/** A scope's descriptions: whether any source's are still loading, and which sources' failed. */
export const descriptionsOf = (scope: Loaded[]): Descriptions => ({
  loading: scope.some((L) => L.descriptions === 'loading'),
  failed: scope.filter((L) => L.descriptions === 'failed').map((L) => L.id),
});

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
 * (an old unqualified link, or a module that no longer applies). A key without a source looks in
 * every source, in source order. Names match case-insensitively.
 */
export function refOfKey(all: Loaded[], key: string): number | null {
  // Links are matched case-insensitively throughout: people retype and re-case them.
  const { source, name, module } = parseKey(key.toLowerCase());
  let first: number | null = null;
  for (const L of source ? all.filter((x) => x.id === source) : all) {
    for (let i = 0; i < L.lname.length; i++) {
      if (L.lname[i] !== name) continue;
      if (!module || L.shard.mods[L.shard.m[i]].toLowerCase() === module) return encodeRef(L, i);
      first ??= encodeRef(L, i);
    }
  }
  return first;
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
