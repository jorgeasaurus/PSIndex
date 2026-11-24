/// <reference lib="webworker" />
import { artifactPath } from './artifacts';
import { facetsFor, prepareSource, refOfKey, related, rowOf, searchHits, setDescriptions, type Loaded } from './search-core';
import { SOURCES, fetchAsset, scopeOf } from './sources';
import type { Filters, FromWorker, IndexShard, RequestType, Requests, ToWorker } from './types';

type Search = { id: number; q: string; filters: Filters };
let lastSearch: Search | null = null;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

async function loadSource(si: number): Promise<Loaded> {
  const { id } = SOURCES[si];
  const shard = await fetchAsset<IndexShard>(artifactPath.shard(id));
  return prepareSource(si, id, shard);
}

async function loadDescriptions(L: Loaded) {
  const desc = await fetchAsset<string[]>(artifactPath.desc(L.id)).catch(() => null);
  if (!desc) return; // descriptions only refine ranking; without them names still search
  setDescriptions(L, desc);
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
  post({ type: 'load-error', message: String(e?.message ?? e) });
});

function runSearch(all: Loaded[], { id, q, filters }: Search) {
  const t0 = performance.now();
  const hits = searchHits(all, q, filters);
  const { sources, perSourceFacets } = scopeOf(filters.source);
  const scope = all.filter((L) => sources.some((s) => s.id === L.id));
  const refs = Int32Array.from(hits, (h) => h.ref);
  post({ type: 'results', id, q, refs, facets: facetsFor(scope, perSourceFacets), ms: performance.now() - t0 }, [refs.buffer]);
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
