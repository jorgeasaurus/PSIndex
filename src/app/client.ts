import { assetUrl } from './sources';
import type { CmdletFile, Filters, FromWorker, RequestType, Requests, Results, ToWorker } from './types';

type Pending = { resolve: (reply: Requests[RequestType]['reply']) => void; reject: (e: Error) => void };

interface Handlers {
  onResults: (r: Results) => void;
  onLoadError: (message: string) => void;
}

/** Owns the search worker. Search replies older than the latest search are dropped. */
export class SearchClient {
  private worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private latestSearch = 0;
  private pending = new Map<number, Pending>();

  constructor(h: Handlers) {
    this.worker.onmessage = ({ data: m }: MessageEvent<FromWorker>) => {
      switch (m.type) {
        case 'load-error': return h.onLoadError(m.message);
        case 'results': if (m.id === this.latestSearch) h.onResults(m); return;
        case 'reply': {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          if ('error' in m) p?.reject(new Error(m.error)); else p?.resolve(m.reply);
          return;
        }
      }
    };
  }

  search(q: string, filters: Filters) {
    this.latestSearch = ++this.seq;
    this.post({ type: 'search', id: this.latestSearch, q, filters });
  }

  /** Whether results with this id answer the latest search (false while a newer one is in flight). */
  isLatest(id: number | undefined) {
    return id === this.latestSearch;
  }

  /** Ask the worker a question. It answers once its index has loaded, or rejects if the load failed. */
  request<K extends RequestType>(type: K, args: Requests[K]['args']): Promise<Requests[K]['reply']> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      // The reply for `id` is Requests[K]['reply']; the map holds the union, so narrow here once.
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject });
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
