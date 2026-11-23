import { assetUrl } from './sources';
import type { CmdletFile, Filters, FromWorker, RequestType, Requests, Results, ToWorker } from './types';

type Reply = Requests[RequestType]['reply'];

interface Handlers {
  onResults: (r: Results) => void;
  onLoadError: (message: string) => void;
}

/** Owns the search worker. Search replies older than the latest search are dropped. */
export class SearchClient {
  private worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private latestSearch = 0;
  private pending = new Map<number, (reply: Reply) => void>();
  private ready: Promise<void>;

  constructor(h: Handlers) {
    let markReady!: () => void;
    this.ready = new Promise((r) => (markReady = r));
    this.worker.onmessage = ({ data: m }: MessageEvent<FromWorker>) => {
      switch (m.type) {
        case 'ready': return markReady();
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

  /** Ask the worker a question once its index has loaded. */
  async request<K extends RequestType>(type: K, args: Requests[K]['args']): Promise<Requests[K]['reply']> {
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
