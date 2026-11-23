import { assetUrl } from './sources';
import type { CmdletFile, Filters, FromWorker, RequestType, Requests, Results, Row, ToWorker } from './types';

type Reply = Requests[RequestType]['reply'];

interface Handlers {
  onResults: (r: Results) => void;
  onLoadError: (message: string) => void;
}

/** Rows kept between scrolls; plenty for a few screens of any list, small enough to never matter. */
const ROW_CACHE_MAX = 4000;

/** Owns the search worker. Search replies older than the latest search are dropped. */
export class SearchClient {
  private worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private latestSearch = 0;
  private pending = new Map<number, (reply: Reply) => void>();
  private ready: Promise<void>;
  private rowCache = new Map<number, Row>();

  constructor(h: Handlers) {
    let markReady!: () => void;
    this.ready = new Promise((r) => (markReady = r));
    this.worker.onmessage = ({ data: m }: MessageEvent<FromWorker>) => {
      switch (m.type) {
        case 'ready': return markReady();
        case 'desc-ready': return this.rowCache.clear(); // the worker re-sends the latest results next
        case 'load-error': return h.onLoadError(m.message);
        case 'results': if (m.id === this.latestSearch) h.onResults(m); return;
        case 'reply': this.pending.get(m.id)?.(m.reply); this.pending.delete(m.id); return;
      }
    };
  }

  search(q: string, filters: Filters) {
    this.latestSearch = ++this.seq;
    this.post({ type: 'search', id: this.latestSearch, q, filters });
  }

  /** Rows for result refs, from the cache where possible. */
  async rows(refs: number[]): Promise<Row[]> {
    const found = new Map<number, Row>();
    const missing: number[] = [];
    for (const ref of refs) {
      const row = this.rowCache.get(ref);
      if (row) found.set(ref, row); else missing.push(ref);
    }
    if (missing.length) {
      const got = await this.ask('rows', { refs: missing });
      if (this.rowCache.size + got.length > ROW_CACHE_MAX) this.rowCache.clear();
      got.forEach((row, k) => { found.set(missing[k], row); this.rowCache.set(missing[k], row); });
    }
    return refs.map((ref) => found.get(ref)!);
  }

  /** Ask the worker a question once its index has loaded. Rows go through `rows()` and its cache. */
  request<K extends Exclude<RequestType, 'rows'>>(type: K, args: Requests[K]['args']): Promise<Requests[K]['reply']> {
    return this.ask(type, args);
  }

  private async ask<K extends RequestType>(type: K, args: Requests[K]['args']): Promise<Requests[K]['reply']> {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve) => {
      // The reply for `id` is Requests[K]['reply']; the map holds the union, so narrow here once.
      this.pending.set(id, resolve as (reply: Reply) => void);
      this.post({ type, id, args } as ToWorker);
    });
  }

  private post(m: ToWorker) {
    this.worker.postMessage(m);
  }
}

const moduleCache = new Map<string, Promise<CmdletFile>>();

/** Fetch (once) a module file written by the build (public/data/<source>/<module>.json). */
export function loadModule(source: string, file: string): Promise<CmdletFile> {
  const key = `${source}/${file}`;
  let p = moduleCache.get(key);
  if (!p) {
    p = fetch(assetUrl(`data/${source}/${encodeURIComponent(file)}.json`)).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    p.catch(() => moduleCache.delete(key));
    moduleCache.set(key, p);
  }
  return p;
}
