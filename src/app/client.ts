import type { Facets, Filters, FromWorker, Row, ToWorker } from './types';

type Pending = (m: FromWorker) => void;

/** Thin promise wrapper around the search worker. Stale search replies are dropped by id. */
export class SearchClient {
  private w: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private latestSearch = 0;
  ready: Promise<void>;
  onDesc: () => void = () => {};
  onLoadError: (message: string) => void = () => {};
  onResults: (r: { refs: Int32Array; total: number; facets: Facets; ms: number }) => void = () => {};

  constructor() {
    this.w = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    let resolveReady!: () => void;
    this.ready = new Promise((r) => (resolveReady = r));
    this.w.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === 'ready') return resolveReady();
      if (m.type === 'desc-ready') return this.onDesc();
      if (m.type === 'load-error') return this.onLoadError(m.message);
      if (m.type === 'results') {
        if (m.id === this.latestSearch) this.onResults(m);
        return;
      }
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p(m); }
    };
  }

  private send(m: ToWorker) { this.w.postMessage(m); }

  search(q: string, filters: Filters) {
    const id = ++this.seq;
    this.latestSearch = id;
    this.send({ type: 'search', id, q, filters });
  }

  rows(refs: number[]): Promise<Row[]> {
    const id = ++this.seq;
    return new Promise((res) => {
      this.pending.set(id, (m) => res(m.type === 'rows' ? m.rows : []));
      this.send({ type: 'rows', id, refs });
    });
  }

  related(key: string): Promise<Row[]> {
    const id = ++this.seq;
    return new Promise((res) => {
      this.pending.set(id, (m) => res(m.type === 'related' ? m.rows : []));
      this.send({ type: 'related', id, key });
    });
  }

  async find(key: string): Promise<Row | null> {
    await this.ready;
    const id = ++this.seq;
    return new Promise((res) => {
      this.pending.set(id, (m) => res(m.type === 'found' ? m.row : null));
      this.send({ type: 'find', id, key });
    });
  }
}

const detailCache = new Map<string, Promise<any>>();
export function loadDetail(source: string, file: string): Promise<any> {
  const k = `${source}/${file}`;
  let p = detailCache.get(k);
  if (!p) {
    p = fetch(`/data/${source}/${encodeURIComponent(file)}.json`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    p.catch(() => detailCache.delete(k));
    detailCache.set(k, p);
  }
  return p;
}
