import { artifactPath } from './artifacts';
import { fetchAsset } from './sources';
import type { CmdletFile, Filters, FromWorker, RequestType, Requests, Results, ToWorker } from './types';

type Reply = Requests[RequestType]['reply'];

interface Handlers {
  onResults: (r: Results) => void;
  onLoadError: (message: string) => void;
}

/**
 * Owns the search worker. At most one search is with the worker at a time: while one runs, only the
 * latest query waits, so fast typing never queues a backlog of stale searches (a slow typo scan
 * would otherwise make results lag seconds behind the box). Replies older than the latest are dropped.
 */
export class SearchClient {
  private worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private latestSearch = 0;
  private running = 0; // id of the search the worker is working on (0: none)
  private waiting: Extract<ToWorker, { type: 'search' }> | null = null;
  private pending = new Map<number, (reply: Reply) => void>();

  constructor(h: Handlers) {
    this.worker.onmessage = ({ data: m }: MessageEvent<FromWorker>) => {
      switch (m.type) {
        case 'load-error': return h.onLoadError(m.message);
        case 'results':
          if (m.id === this.running) this.sendWaiting();
          if (m.id === this.latestSearch) h.onResults(m);
          return;
        case 'reply': this.pending.get(m.id)?.(m.reply); this.pending.delete(m.id); return;
      }
    };
  }

  search(q: string, filters: Filters) {
    this.latestSearch = ++this.seq;
    this.waiting = { type: 'search', id: this.latestSearch, q, filters };
    if (!this.running) this.sendWaiting();
  }

  private sendWaiting() {
    this.running = this.waiting?.id ?? 0;
    if (this.waiting) this.post(this.waiting);
    this.waiting = null;
  }

  /** Id of the latest search sent; results carry it once they answer that search. */
  get latest() {
    return this.latestSearch;
  }

  /**
   * Ask the worker a question. It answers once its index has loaded. If the load fails the promise
   * never settles: the failure has one channel, onLoadError, and callers stay single-path.
   */
  request<K extends RequestType>(type: K, args: Requests[K]['args']): Promise<Requests[K]['reply']> {
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

/** Fetch (once) a module file written by the build. */
export function loadModule(source: string, file: string): Promise<CmdletFile> {
  const key = `${source}/${file}`;
  let p = moduleCache.get(key);
  if (!p) {
    p = fetchAsset<CmdletFile>(artifactPath.module(source, file));
    p.catch(() => moduleCache.delete(key));
    moduleCache.set(key, p);
  }
  return p;
}
