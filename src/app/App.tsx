import { createRef } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { SearchClient } from './client';
import { useAsciiField } from './ascii';
import { useTheme } from './theme';
import { ResultList, ResultsSkeleton, type ListNav } from './ResultList';
import { Detail } from './Detail';
import { Band, EmptyState, FilterBar, Frame, INERT_BAND, Intro, LoadFailed, Toolbar } from './chrome';
import { ALL, formatCount, scopeOf } from './sources';
import { EMPTY_FILTERS, activeFilters, readUrl, writeUrl } from './url';
import type { Facets, Filters, Results, Row } from './types';

/**
 * Server-rendered and first paint: the static frame. Once mounted in the browser the search
 * session takes over, so everything inside Search can assume a window, a worker and the URL.
 */
export default function App() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <Search /> : <Shell />;
}

function Shell() {
  return (
    <Frame
      source={ALL.id}
      isOpen={false}
      dialog={false}
      inert
      canvasRef={createRef()}
      detailRef={createRef()}
      band={<Band q="" source={ALL.id} placeholder={ALL.placeholder} inputRef={createRef()} handlers={INERT_BAND} live={false} activeId="" />}
      toolbar={<Toolbar label="Loading index…" filterCount={0} showFilters={false} onToggleFilters={() => {}} />}
      results={<ResultsSkeleton />}
      detail={<Intro onPick={() => {}} />}
    />
  );
}

const NO_FACETS: Facets = { verbs: [], modules: [], categories: [], extras: [] };

/** Narrow screens show the open entry over the results (the 900px breakpoint in global.css). */
const NARROW = '(max-width: 900px)';
function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}


// ---- Search session ------------------------------------------------------------------------

/**
 * The detail pane's entry, including the two ways it can be waiting on the worker:
 *   row:   an entry is open
 *   link:  a deep-linked key is being looked up (only ever the URL's)
 *   enter: Enter was pressed for search `enter`; it opens that search's cursor row once its
 *          results are on screen, and `shown` stays open meanwhile
 * Every change is one setSel, so a new choice always replaces a pending one.
 */
type Selection = { row: Row } | { link: string } | { enter: number; shown: Row | null } | null;
/** A pending Enter given up: the pane goes back to what it showed. */
const settle = (s: Selection): Selection => (s && 'enter' in s ? s.shown && { row: s.shown } : s);

function Search() {
  const [initial] = useState(readUrl);
  const [q, setQ] = useState(initial.q);
  const [filters, setFilters] = useState(initial.filters);
  const [sel, setSel] = useState<Selection>(initial.open ? { link: initial.open } : null);
  const [results, setResults] = useState<Results | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [client] = useState(() => new SearchClient({ onResults: setResults, onLoadError: setLoadError }));

  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const listRef = useRef<ListNav>(null);
  const scope = scopeOf(filters.source);
  const { theme, toggle: toggleTheme } = useTheme();
  const pulse = useAsciiField(canvasRef, scope.color, theme);
  const narrow = useNarrow();
  const [activeId, setActiveId] = useState('');

  // The search box is the keyboard hub: it has focus once the session is live.
  useEffect(() => inputRef.current?.focus({ preventScroll: true }), []);

  // A layout effect, so the search is sent within the render: a key pressed right after typing
  // (Enter) already sees it as the latest, not a passive effect still waiting for the next frame.
  // A newer search also gives up an Enter pressed for the previous one.
  useLayoutEffect(() => { client.search(q, filters); setSel(settle); }, [q, filters]);
  const open = !sel ? null : 'row' in sel ? sel.row : 'enter' in sel ? sel.shown : null;
  const link = sel && 'link' in sel ? sel.link : '';
  const enterFor = sel && 'enter' in sel ? sel.enter : null;
  // Until the deep link resolves, keep it in the URL so a reload still opens it.
  const openKey = open?.key ?? link;
  // Each entry opens at its top (the pane, not the article, is what scrolls).
  useLayoutEffect(() => { if (detailRef.current) detailRef.current.scrollTop = 0; }, [open?.key]);
  useEffect(() => writeUrl({ q, filters, open: openKey }), [q, filters, openKey]);

  // Resolve the deep link. An old or unqualified key adopts the row's canonical key.
  useEffect(() => {
    if (!link) return;
    let live = true; // opening or closing an entry replaces the selection and supersedes this lookup
    client.request('find', { key: link }).then((row) => live && setSel(row && { row }));
    return () => { live = false; };
  }, [link]);

  // Global keys, from anywhere on the page:
  //   "/" or Ctrl/Cmd+K focuses search;
  //   Escape closes the open entry (back to the search box), or else clears the query.
  // Escape's default is prevented: the search input would also clear itself natively.
  const escape = useRef(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select');
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('select')) {
        e.preventDefault();
        escape.current();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  // Verb and the examples flag mean the same in every source, so they survive a source switch.
  const setSource = (source: Filters['source']) => setFilters((f) => ({ ...EMPTY_FILTERS, source, verb: f.verb, examples: f.examples }));

  const openRow = useCallback((row: Row) => {
    setSel({ row });
    // Opening an entry sends a pulse from the detail pane, so the field marks every step of a lookup.
    const pane = detailRef.current?.getBoundingClientRect();
    if (pane?.width) pulse({ x: pane.left + 40, y: pane.top + 40 }, 0.7);
  }, []);
  const close = useCallback(() => setSel(null), []);
  /**
   * Back from the entry (Back button, Escape): focus returns to the search box once the entry is
   * closed, i.e. after the render that lifts the narrow-screen dialog's inert from the band.
   */
  const refocus = useRef(false);
  const back = () => { refocus.current = true; close(); };
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    inputRef.current?.focus({ preventScroll: true });
  }, [open]);
  escape.current = () => { if (openKey) back(); else if (q) setQ(''); };

  // Resolve a pending Enter once its search's results are the ones on screen.
  useEffect(() => {
    if (enterFor === null || results?.id !== enterFor) return;
    const row = listRef.current?.current();
    if (!row) return setSel(settle); // no results: nothing to open
    let live = true; // a newer search or another selection replaces the pending Enter
    row.then((r) => live && openRow(r));
    return () => { live = false; };
  }, [enterFor, results?.id]);

  const onKeyDown = (e: KeyboardEvent) => {
    // No cmdlet name contains "/", so it is only ever the focus shortcut: never typed into the query.
    if (e.key === '/') { e.preventDefault(); return; }
    const nav = listRef.current;
    if (!nav) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); nav.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nav.move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter means the cursor's row in the results of what is typed: if they are still coming, open on
      // arrival. It is the later choice, so it replaces a deep link still being looked up.
      setSel({ enter: client.latest, shown: open });
    }
  };

  const filterCount = activeFilters(filters);
  const countLabel = loadError
    ? 'Index unavailable'
    : !results
      ? 'Loading index…'
      : <>{formatCount(results.refs.length)} {results.refs.length === 1 ? 'result' : 'results'}{results.q ? <span class="ms"> · {results.ms < 1 ? '<1' : Math.round(results.ms)} ms</span> : null}</>;

  return (
    <Frame
      source={filters.source}
      isOpen={!!open}
      dialog={!!open && narrow}
      inert={false}
      canvasRef={canvasRef}
      detailRef={detailRef}
      band={
        <Band
          q={q}
          source={filters.source}
          placeholder={scope.placeholder}
          inputRef={inputRef}
          live
          activeId={activeId}
          inert={!!open && narrow}
          handlers={{
            onQuery: (value, caret) => { setQ(value); pulse(caret); },
            onKeyDown,
            onClear: () => { setQ(''); inputRef.current?.focus(); },
            onHome: () => { setQ(''); setFilters(EMPTY_FILTERS); close(); },
            onToggleTheme: toggleTheme,
            onPickSource: setSource,
          }}
        />
      }
      toolbar={
        <>
          <Toolbar label={countLabel} filterCount={filterCount} showFilters={showFilters} onToggleFilters={() => setShowFilters((s) => !s)} />
          {showFilters && (
            <FilterBar facets={results?.facets ?? NO_FACETS} filters={filters} extraLabel={scope.extraLabel} setFilter={setFilter} clear={() => setFilters({ ...EMPTY_FILTERS, source: filters.source })} />
          )}
        </>
      }
      results={
        loadError ? <div class="results results-empty"><LoadFailed message={loadError} /></div> : (
          <ResultList
            navRef={listRef}
            client={client}
            results={results}
            openKey={openKey}
            onOpen={openRow}
            onCursor={setActiveId}
            query={q}
            empty={<EmptyState q={q} inLabel={scope.inLabel} filtered={filterCount > 0 || filters.source !== ALL.id} reset={() => { setFilters(EMPTY_FILTERS); inputRef.current?.focus(); }} />}
          />
        )
      }
      detail={
        open
          // Keyed by entry: each one starts fresh (no related list or body from the previous entry).
          ? <Detail key={open.key} row={open} client={client} onOpen={openRow} onClose={back} takeFocus={narrow} />
          : <Intro onPick={(s, sample) => { setSource(s); setQ(sample); inputRef.current?.focus(); }} />
      }
    />
  );
}
