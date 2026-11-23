import type { ComponentChildren, Ref } from 'preact';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { SearchClient } from './client';
import { isWarnExtra, queryTokens, sourceOf, srcStyle } from './sources';
import type { Row } from './types';

const ROW_H = 64;
const OVERSCAN = 8;

/** Keyboard navigation, driven from the search box. */
export interface ListNav {
  move: (delta: number) => void;
  openActive: () => void;
}

interface Props {
  navRef: Ref<ListNav>;
  client: SearchClient;
  refs: Int32Array | null;
  openKey: string;
  onOpen: (r: Row) => void;
  query: string;
  /** Id of the search `refs` answer; a new id scrolls back to the top, a refresh under the same id keeps the place. */
  searchId: number;
  empty: ComponentChildren;
}

/** Virtualised result list: only the visible window of rows is materialised from the worker. */
export function ResultList({ navRef, client, refs, openKey, onOpen, query, searchId, empty }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 30 });
  const [rows, setRows] = useState<Map<number, Row>>(new Map());
  // The keyboard cursor belongs to one result set: a new search id puts it back on the first row,
  // a refresh under the same id keeps it.
  const [cursor, setCursor] = useState({ id: searchId, i: 0 });
  const active = cursor.id === searchId ? cursor.i : 0;
  const setActive = (i: number) => setCursor({ id: searchId, i });

  useImperativeHandle(navRef, () => ({
    move: (delta) => { if (refs?.length) setActive(Math.max(0, Math.min(refs.length - 1, active + delta))); },
    // The cursor is kept in view, so its row is normally materialised; if it is not yet, Enter does nothing.
    openActive: () => { const row = refs?.length ? rows.get(refs[active]) : undefined; if (row) onOpen(row); },
  }), [refs, rows, active, searchId, onOpen]);

  // A new search starts at the top; a refresh of the same search (descriptions arriving) keeps the user's place.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    measure();
  }, [searchId]);

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
    const window = Array.from(refs.subarray(range.start, Math.min(refs.length, range.end)));
    let live = true;
    client.request('rows', { refs: window }).then((got) => live && setRows(new Map(got.map((r, k) => [window[k], r]))));
    return () => { live = false; };
  }, [client, refs, range]);

  // Keep the keyboard cursor in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const top = active * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, [active]);

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
  const tag = row.dup ? row.module : isWarnExtra(sourceOf(row.source), row.extra) ? row.extra : '';
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
        <span class="result-meta">{tag}</span>
      </div>
      <p class="result-desc">{row.desc || <span class="result-module">{row.module}</span>}</p>
    </div>
  );
}

/** Highlight each query token in a name, tokenised the same way the worker matched it. */
function Mark({ text, q }: { text: string; q: string }) {
  const lower = text.toLowerCase();
  const marks = queryTokens(q)
    .map((t) => [lower.indexOf(t), t.length] as const)
    .filter(([at]) => at >= 0)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [at, len] of marks) {
    if (at < pos) continue;
    if (at > pos) out.push(text.slice(pos, at));
    out.push(<mark key={at}>{text.slice(at, at + len)}</mark>);
    pos = at + len;
  }
  out.push(text.slice(pos));
  return <>{out}</>;
}
