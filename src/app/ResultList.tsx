import type { ComponentChildren, Ref } from 'preact';
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SearchClient } from './client';
import { flatMatch, isWarnExtra, queryTokens, sourceOf, srcStyle } from './sources';
import type { Results, Row } from './types';

const ROW_H = 64;
const OVERSCAN = 8;

/** Keyboard navigation, driven from the search box. */
export interface ListNav {
  move: (delta: number) => void;
  /** The row under the cursor, fetched if the window has not materialised it yet; null with no results. */
  current: () => Promise<Row> | null;
}

interface Props {
  navRef: Ref<ListNav>;
  client: SearchClient;
  /** The search's results, or null while the first ones load. A new id scrolls back to the top and
   * resets the cursor; a refresh under the same id (descriptions arriving) keeps both. */
  results: Results | null;
  openKey: string;
  onOpen: (r: Row) => void;
  /** The cursor row's element id ('' when there is none), for the search box's aria-activedescendant. */
  onCursor: (id: string) => void;
  query: string;
  empty: ComponentChildren;
}

/** Element id of the result row at position i. */
const rowId = (i: number) => `result-${i}`;

/** Virtualised result list: only the visible window of rows is materialised from the worker. */
export function ResultList({ navRef, client, results, openKey, onOpen, onCursor, query, empty }: Props) {
  const refs = results?.refs ?? null;
  const searchId = results?.id;
  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 30 });
  const [rows, setRows] = useState<Map<number, Row>>(new Map());
  // The keyboard cursor is a row (its ref) in one result set: a new search id puts it back on the
  // first row; a refresh under the same id can reorder rows, so the cursor follows its row.
  const [cursor, setCursor] = useState<{ id: number | undefined; ref: number }>({ id: undefined, ref: -1 });
  const active = useMemo(() => (refs && cursor.id === searchId ? Math.max(0, refs.indexOf(cursor.ref)) : 0), [refs, cursor, searchId]);
  const setActive = (i: number) => refs && setCursor({ id: searchId, ref: refs[i] });

  // Tell the search box which rendered row is under the cursor.
  const cursorShown = !!refs?.length && rows.has(refs[active]) && active >= range.start && active < range.end;
  useEffect(() => onCursor(cursorShown ? rowId(active) : ''), [cursorShown, active]);

  useImperativeHandle(navRef, () => ({
    move: (delta) => {
      if (!refs?.length) return;
      const i = Math.max(0, Math.min(refs.length - 1, active + delta));
      setActive(i);
      reveal(i); // keyboard moves keep the cursor in view (hover only highlights, so it never scrolls)
    },
    current: () => {
      if (!refs?.length) return null;
      const ref = refs[active];
      const row = rows.get(ref);
      return row ? Promise.resolve(row) : client.request('rows', { refs: [ref] }).then(([r]) => r);
    },
  }), [client, refs, rows, active, searchId]);

  /** Scroll just enough to show row i. */
  const reveal = (i: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  // A new search starts at the top; a refresh of the same search (descriptions arriving) keeps the
  // user's place, and if it moved the cursor's row, brings that row into view.
  const lastId = useRef(searchId);
  useLayoutEffect(() => {
    if (lastId.current !== searchId) {
      lastId.current = searchId;
      if (scroller.current) scroller.current.scrollTop = 0;
    } else if (cursor.id === searchId) {
      reveal(active);
    }
    measure();
  }, [refs]);

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

  const items = [];
  for (let i = range.start; refs && i < Math.min(refs.length, range.end); i++) {
    const r = rows.get(refs[i]);
    items.push(r
      ? <ResultRow key={refs[i]} i={i} row={r} query={query} active={i === active} open={r.key === openKey} onOpen={onOpen} onHover={setActive} />
      : <SkeletonRow key={refs[i]} i={i} />);
  }

  // One scroller for every state (loading, empty, results), so the ResizeObserver set up at mount
  // always watches the element on screen.
  const none = refs?.length === 0;
  return (
    <div class={'results' + (none ? ' results-empty' : '')} ref={scroller} onScroll={measure} id="results" role={none ? undefined : 'listbox'} aria-label="Search results" aria-busy={!refs}>
      {!refs ? <SkeletonRows /> : none ? empty : <div class="results-inner" style={{ height: `${refs.length * ROW_H}px` }}>{items}</div>}
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
      id={rowId(i)}
      role="option"
      aria-selected={active}
      aria-current={open || undefined}
      class={'result' + (active ? ' is-active' : '') + (open ? ' is-open' : '')}
      style={{ top: `${i * ROW_H}px`, ...srcStyle(row.source) }}
      // A click opens the row without taking focus from the search box, so the keyboard keeps working.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onOpen(row)}
      onMouseMove={() => !active && onHover(i)}
    >
      <div class="result-line">
        <span class="source-dot" aria-hidden="true" />
        <code class="result-name" title={row.name}><Mark text={row.name} q={query} /></code>
        <span class="result-meta">{tag}</span>
      </div>
      <p class="result-desc">{row.desc || <span class="result-module">{row.module}</span>}</p>
    </div>
  );
}

/**
 * Where a token occurs in a name, as [start, length]: literally, or else ignoring hyphens on both
 * sides ("getmguser" in Get-MgUser), mapped back to the name's own characters.
 */
function locate(name: string, t: string): readonly [number, number] | null {
  const lower = name.toLowerCase();
  const at = lower.indexOf(t);
  if (at >= 0) return [at, t.length];
  const keep = [...lower].flatMap((c, i) => (c === '-' ? [] : [i])); // flat index -> name index
  const flatLen = t.replace(/-/g, '').length;
  const fa = flatMatch(lower, lower.replace(/-/g, ''), t);
  if (fa < 0) return null;
  const start = keep[fa], end = keep[fa + flatLen - 1] + 1;
  return [start, end - start];
}

/** Highlight each query token in a name, tokenised the same way the worker matched it. */
function Mark({ text, q }: { text: string; q: string }) {
  // Overlapping tokens: at the same start, the longer one wins.
  const marks = queryTokens(q)
    .map((t) => locate(text, t))
    .filter((m) => m !== null)
    .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
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
