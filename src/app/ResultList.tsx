import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { SearchClient } from './client';
import { kindOf, srcStyle } from './sources';
import type { Row } from './types';

const ROW_H = 64;
const OVERSCAN = 8;

interface Props {
  client: SearchClient;
  refs: Int32Array | null;
  active: number;
  setActive: (i: number) => void;
  openKey: string;
  onOpen: (r: Row) => void;
  descTick: number;
  query: string;
  empty: ComponentChildren;
  failed?: ComponentChildren;
}

/** Virtualised result list: only the visible window of rows is materialised from the worker. */
export function ResultList({ client, refs, active, setActive, openKey, onOpen, descTick, query, empty, failed }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 30 });
  const [rows, setRows] = useState<Map<number, Row>>(new Map());
  const cache = useRef(new Map<number, Row>());

  // New result set: jump to top, drop cache.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    measure();
  }, [refs]);

  useEffect(() => { cache.current.clear(); setRows(new Map()); }, [descTick]);

  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    const start = Math.max(0, Math.floor(el.scrollTop / ROW_H) - OVERSCAN);
    const end = Math.ceil((el.scrollTop + el.clientHeight) / ROW_H) + OVERSCAN;
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Materialise the visible window.
  useEffect(() => {
    if (!refs) return;
    const want: number[] = [];
    const end = Math.min(refs.length, range.end);
    for (let i = range.start; i < end; i++) if (!cache.current.has(refs[i])) want.push(refs[i]);
    const publish = () => {
      const m = new Map<number, Row>();
      for (let i = range.start; i < end; i++) {
        const r = cache.current.get(refs[i]);
        if (r) m.set(refs[i], r);
      }
      setRows(m);
    };
    if (!want.length) return publish();
    let live = true;
    client.request('rows', { refs: want }).then((got) => {
      if (!live) return;
      // Evict before inserting, so the rows about to be shown are never the ones dropped.
      if (cache.current.size + got.length > 4000) cache.current.clear();
      got.forEach((r, k) => cache.current.set(want[k], r));
      publish();
    });
    return () => { live = false; };
  }, [client, refs, range, descTick]);

  // Keep the keyboard cursor in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const top = active * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, [active]);

  if (failed) return <div class="results results-empty">{failed}</div>;
  if (refs && refs.length === 0) return <div class="results results-empty">{empty}</div>;

  const items = [];
  for (let i = range.start; refs && i < Math.min(refs.length, range.end); i++) {
    const r = rows.get(refs[i]);
    items.push(r
      ? <ResultRow key={refs[i]} i={i} row={r} query={query} active={i === active} open={r.key === openKey} onOpen={onOpen} onHover={setActive} />
      : <SkeletonRow key={refs[i]} i={i} />);
  }

  return (
    <div class="results" ref={scroller} onScroll={measure} id="results" role="listbox" aria-label="Search results" aria-busy={!refs}>
      {refs ? <div class="results-inner" style={{ height: `${refs.length * ROW_H}px` }}>{items}</div> : <SkeletonRows />}
    </div>
  );
}

const SkeletonRow = ({ i }: { i: number }) => (
  <div class="result result-skel" style={{ top: `${i * ROW_H}px` }} aria-hidden="true"><span /><span /></div>
);

const SkeletonRows = () => (
  <div class="results-inner" style={{ height: `${12 * ROW_H}px` }}>{Array.from({ length: 12 }, (_, i) => <SkeletonRow key={i} i={i} />)}</div>
);

/** Placeholder list before the search client exists (also the server-rendered state). */
export const ResultsSkeleton = () => <div class="results" aria-busy="true" aria-label="Search results"><SkeletonRows /></div>;

function ResultRow({ i, row, query, active, open, onOpen, onHover }: { i: number; row: Row; query: string; active: boolean; open: boolean; onOpen: (r: Row) => void; onHover: (i: number) => void }) {
  return (
    <div
      role="option"
      aria-selected={open}
      class={'result' + (active ? ' is-active' : '') + (open ? ' is-open' : '')}
      style={{ top: `${i * ROW_H}px`, ...srcStyle(row.source) }}
      onClick={() => onOpen(row)}
      onMouseMove={() => !active && onHover(i)}
    >
      <div class="result-line">
        <span class="source-dot" aria-hidden="true" />
        <code class="result-name"><Mark text={row.name} q={query} /></code>
        <span class="result-meta">{kindOf(row.source).rowTag(row)}</span>
      </div>
      <p class="result-desc">{row.desc || <span class="result-module">{row.module || row.category}</span>}</p>
    </div>
  );
}

/** Highlight the first occurrence of each query token in a name. */
function Mark({ text, q }: { text: string; q: string }) {
  const tokens = q.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (!tokens.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const t of tokens) {
    const at = lower.indexOf(t.replace(/^0x/, ''));
    if (at >= 0) marks.push([at, at + t.replace(/^0x/, '').length]);
  }
  if (!marks.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    if (a > pos) out.push(text.slice(pos, a));
    out.push(<mark key={a}>{text.slice(a, b)}</mark>);
    pos = b;
  }
  out.push(text.slice(pos));
  return <>{out}</>;
}
