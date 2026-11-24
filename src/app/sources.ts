import generated from '../sources.generated.json';
import type { SourceId, SourceMeta } from './types';

/** The source list, bundled at build time into both the page and the worker (see scripts/build-index.ts). */
export const SOURCES: SourceMeta[] = generated.sources;
export const TOTAL = generated.total;

const fmt = new Intl.NumberFormat('en-US');
/** "40,931" — the one number format the site uses. */
export const formatCount = (n: number) => fmt.format(n);
const list = new Intl.ListFormat('en', { type: 'conjunction' });
/** "Graph and MECM": names joined as running copy. */
export const formatList = (items: string[]) => list.format(items);

/** "Graph, Az, Entra, Exchange, and MECM" — for copy that names every source. */
export const SOURCE_NAMES = list.format(SOURCES.map((s) => s.short));
export const SOURCE_LABELS = list.format(SOURCES.map((s) => s.label));

/**
 * URL of a build artifact (idx/… shards, data/… module files). The build id is in the path and is
 * a hash of the artifacts, so a page and its worker only ever read files from their own build.
 */
export const assetUrl = (path: string) => `/a/${generated.build}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** A request that takes longer than this has stalled: it fails instead of loading forever. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Fetch a build artifact as JSON (page or worker). Failures carry a message written for the
 * reader, by cause: no answer, an artifact this build no longer has (the page is from an older
 * deploy), a server error, or a damaged file.
 */
export async function fetchAsset<T>(path: string): Promise<T> {
  const noAnswer = () => new AssetError('The server didn’t answer. Check your connection.', 'retry');
  let r: Response;
  try {
    r = await fetch(assetUrl(path), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw noAnswer();
  }
  if (r.status === 404) throw new AssetError('This page is out of date: a newer version of PSIndex has been published.', 'reload');
  if (!r.ok) throw new AssetError(`The server answered with an error (HTTP ${r.status}).`, 'retry');
  try {
    return await r.json();
  } catch (e) {
    // The timeout can also cut the body off mid-read: that is no answer, not a damaged file.
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw noAnswer();
    throw new AssetError('The server sent a damaged file.', 'reload');
  }
}

/**
 * A failed artifact fetch, with the one action that can fix it: `retry` the same request (no
 * answer, a server error) or `reload` the page (this build's file is gone or damaged, so the same
 * request fails again).
 */
export class AssetError extends Error {
  constructor(message: string, readonly fix: 'retry' | 'reload') { super(message); }
}

/** The extra value a source flags as a caution, e.g. Graph's "beta" API. */
export const isWarnExtra = (s: SourceMeta, extra: string) => !!extra && extra === s.extra?.warn;

/**
 * The query's words as typed: split on whitespace, each trimmed of the punctuation around it, so a
 * name pasted from a script or doc ('"Get-MgUser",') matches literally. Hyphens stay: they are part
 * of names ("get-") and mark parameters ("-UserId"). A word needs a letter or digit ("--" is none).
 */
export const queryWords = (q: string) =>
  q.split(/\s+/).map((w) => w.replace(/^[^a-z0-9-]+|[^a-z0-9-]+$/gi, '')).filter((w) => /[a-z0-9]/i.test(w));

/** A parameter as written on a command line ("-All", "-UserId"): no cmdlet name starts with one. */
const isParameter = (w: string) => /^-[a-z]/i.test(w);

/**
 * Query tokens as both the worker and the highlighter match them: the words, lower-cased, without
 * parameters. A pasted 'Get-MgUser -All' searches for Get-MgUser; "-all" would otherwise match
 * inside unrelated names (InstalledApp) through the hyphen-free comparison.
 */
export const queryTokens = (q: string) => queryWords(q).filter((w) => !isParameter(w)).map((w) => w.toLowerCase());

/** The text of a query that searches something: trimmed, or '' when it has no token ("", "--", "-All"). */
export const searchText = (q: string) => (queryTokens(q).length ? q.trim() : '');

/**
 * The first word shaped like a cmdlet name ("Get-MgUser": letters, a hyphen, then the noun), or
 * undefined. Words are split where PowerShell ends a command, so a pipeline pasted without spaces
 * ('Get-MgUser|Select-Object') yields its first cmdlet, never the whole run.
 */
export const cmdletNameIn = (words: string[]) =>
  words.flatMap((w) => w.split(/[|;&(){}]/)).find((w) => /^[a-z]+-[a-z0-9]+$/i.test(w));

/**
 * Where a token matches a lower-cased cmdlet name with every hyphen ignored ("getmguser" in
 * get-mguser): the index in the hyphen-free name, or -1. The ranker and the highlighter both call
 * this, so a name is only ever marked where it matched. A short hyphen-free token ("thi") never
 * matches this way: across the verb/noun join it would hit nearly every name ("Get-HistoricalSearch"
 * as "t-Hi"). A match that runs from the verb into the noun must take at least two letters of the
 * noun, so an ordinary word like "removes" doesn't match every Remove-S* cmdlet as "remove" + "s".
 */
export function flatMatch(lname: string, lflat: string, token: string): number {
  if (!token.includes('-') && token.length < 4) return -1;
  const flatT = token.replace(/-/g, '');
  if (!flatT) return -1;
  const verbEnd = lname.indexOf('-'); // = the noun's start in the hyphen-free name
  for (let at = lflat.indexOf(flatT); at >= 0; at = lflat.indexOf(flatT, at + 1)) {
    const crosses = verbEnd > 0 && at < verbEnd && at + flatT.length > verbEnd;
    if (!crosses || at + flatT.length - verbEnd >= 2) return at;
  }
  return -1;
}

/**
 * What the UI is searching: one source, or every source ("all"). Everything that differs
 * between the two is a property here, so callers never special-case "all".
 */
export interface Scope {
  id: SourceId;
  color: string;
  placeholder: string;
  /** " in Graph", or '' for every source. */
  inLabel: string;
  /** Label of the source's extra facet; null for sources without one and for "all". */
  extraLabel: string | null;
  sources: SourceMeta[];
  /** Module and extra facets only make sense within one source. */
  perSourceFacets: boolean;
}

export const ALL: Scope = {
  id: 'all',
  color: '#b9c3d6',
  placeholder: `Search ${formatCount(TOTAL)} cmdlets`,
  inLabel: '',
  extraLabel: null,
  sources: SOURCES,
  perSourceFacets: false,
};

const SCOPES = new Map<SourceId, Scope>([
  [ALL.id, ALL],
  ...SOURCES.map((s): [SourceId, Scope] => [s.id, {
    id: s.id,
    color: s.color,
    placeholder: `Search ${formatCount(s.count)} ${s.short} cmdlets`,
    inLabel: ` in ${s.short}`,
    extraLabel: s.extra?.label ?? null,
    sources: [s],
    perSourceFacets: true,
  }]),
]);

/** A URL's source id, read case-insensitively ("?s=Graph"); unknown or stale ids mean every source. */
export const parseScope = (raw: string | null): SourceId => {
  const id = raw?.trim().toLowerCase();
  return id && SCOPES.has(id) ? id : ALL.id;
};
/** Scope ids in app state are always valid (they come from parseScope, SOURCES or ALL). */
export const scopeOf = (id: SourceId): Scope => SCOPES.get(id)!;

const META = new Map(SOURCES.map((s) => [s.id, s]));
/** Rows only come from the worker, which only knows SOURCES, so a row's source always resolves. */
export const sourceOf = (id: SourceId): SourceMeta => META.get(id)!;

/** Inline style that tints an element (and its descendants) with a scope's or source's hue. */
export const srcStyle = (id: SourceId) => ({ '--src': scopeOf(id).color });
