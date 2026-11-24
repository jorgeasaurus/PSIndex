import { createRef } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { SearchClient } from './client';
import { useAsciiField } from './ascii';
import { useTheme } from './theme';
import { ResultList, ResultsSkeleton, type ListNav } from './ResultList';
import { Detail } from './Detail';
import { Band, DescriptionsFailed, EmptyState, FilterBar, Frame, INERT_BAND, Intro, LoadFailed, Toolbar } from './chrome';
import { ALL, formatCount, queryTokens, scopeOf } from './sources';
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
      band={<Band q="" source={ALL.id} placeholder="Loading the index…" inputRef={createRef()} handlers={INERT_BAND} live={false} activeId="" />}
      toolbar={<Toolbar label="Loading index…" filterCount={0} showFilters={false} />}
      results={<ResultsSkeleton />}
      detail={<Intro />}
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
 *   missing: the deep link named no cmdlet in the index (renamed or removed); the intro says so
 * Every change is one setSel, so a new choice always replaces a pending one.
 */
type Selection = { row: Row } | { link: string } | { enter: number; shown: Row | null } | { missing: string } | null;
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
  const missing = sel && 'missing' in sel ? sel.missing : '';
  // Until the deep link resolves, keep it in the URL so a reload still opens it.
  const openKey = open?.key ?? link;
  // Each entry opens at its top (the pane, not the article, is what scrolls).
  useLayoutEffect(() => { if (detailRef.current) detailRef.current.scrollTop = 0; }, [open?.key]);
  useEffect(() => writeUrl({ q, filters, open: openKey }), [q, filters, openKey]);

  // Resolve the deep link. An old or unqualified key adopts the row's canonical key.
  useEffect(() => {
    if (!link) return;
    let live = true; // opening or closing an entry replaces the selection and supersedes this lookup
    client.request('find', { key: link }).then((row) => live && setSel(row ? { row } : { missing: link }));
    return () => { live = false; };
  }, [link]);

  // Global keys, from anywhere on the page:
  //   "/" or Ctrl/Cmd+K focuses search;
  //   Escape closes the open entry (back to the search box), or else clears the query.
  // Escape's default is prevented: the search input would also clear itself natively.
  const escape = useRef(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The MCP dialog closes itself on Escape, and its focus trap owns Tab. preventDefault here
      // would cancel that close, and "/" would pull focus out of the dialog.
      if (document.querySelector('dialog[open]')) return;
      const typing = (e.target as HTMLElement)?.closest('input:not([type=checkbox]), textarea, select');
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
  const closeToSearch = () => { refocus.current = true; close(); };
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  /**
   * The narrow-screen dialog is a history entry of its own, so the phone's Back gesture closes it
   * instead of leaving the page. In-app Back drops that same entry once: a repeated Escape or a
   * double click must not pop the page behind it. Leaving the narrow layout drops the entry too,
   * without closing the cmdlet.
   */
  const dialog = !!open && narrow;
  const pushed = useRef(false);
  /** A history.back() we started. Its popstate restores the URL and must not close the entry. */
  const dropping = useRef(false);
  const dialogNow = useRef(false);
  dialogNow.current = dialog;
  const urlNow = useRef({ q, filters, open: openKey });
  urlNow.current = { q, filters, open: openKey };
  const dropEntry = () => {
    if (!pushed.current || dropping.current) return;
    dropping.current = true;
    history.back();
  };
  // A layout effect: the entry exists as soon as the dialog is on screen, so Back can never skip it.
  // When the dialog goes away without a browser Back (widen, Home, Dismiss), drop the leftover entry.
  useLayoutEffect(() => {
    if (dialog) {
      if (pushed.current || dropping.current) return;
      history.pushState(history.state, '', location.href);
      pushed.current = true;
      return;
    }
    dropEntry();
  }, [dialog]);
  useEffect(() => {
    const onPop = () => {
      const ours = dropping.current;
      dropping.current = false;
      if (!pushed.current) return;
      pushed.current = false;
      if (!ours) {
        closeToSearch();
        return;
      }
      // history.back() restored the URL from before the dialog. Put the current one back.
      writeUrl(urlNow.current);
      if (dialogNow.current) {
        history.pushState(history.state, '', location.pathname + location.search);
        pushed.current = true;
      }
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const back = () => { dropEntry(); closeToSearch(); };

  // Escape gives up a pending Enter first (what was typed stays), then closes the entry, then clears.
  escape.current = () => { if (enterFor !== null) setSel(settle); else if (openKey) back(); else if (q) setQ(''); };

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
      : `${formatCount(results.refs.length)} ${results.refs.length === 1 ? 'result' : 'results'}`;
  // Search time, for a real query only (a blank query lists everything).
  const timing = results && !loadError && queryTokens(results.q).length ? `${results.ms < 1 ? '<1' : Math.round(results.ms)} ms` : undefined;

  return (
    <Frame
      source={filters.source}
      isOpen={!!open}
      dialog={dialog}
      inert={false}
      canvasRef={canvasRef}
      detailRef={detailRef}
      band={
        <Band
          q={q}
          source={filters.source}
          placeholder={scope.placeholder}
          inputRef={inputRef}
          activeId={activeId}
          inert={dialog}
          live={!loadError}
          dark={theme === 'dark'}
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
          <Toolbar label={countLabel} timing={timing} filterCount={filterCount} showFilters={showFilters} onToggleFilters={loadError ? undefined : () => setShowFilters((s) => !s)} />
          {/* Above the results, so it shows at every width (narrow screens hide the detail pane). */}
          {missing && (
            <div class="notice notice-error notice-link" role="status">
              <p>The link names <code>{missing}</code>, which isn’t a cmdlet in the index. The link may be cut off or mistyped, or the cmdlet renamed or removed.</p>
              <button type="button" class="chip" onClick={() => { close(); inputRef.current?.focus(); }}>Dismiss</button>
            </div>
          )}
          {results?.descriptions === 'failed' && <DescriptionsFailed />}
          {showFilters && !loadError && (
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
            empty={<EmptyState q={q.trim()} descriptions={results?.descriptions ?? 'loading'} inLabel={scope.inLabel} filtered={filterCount > 0 || filters.source !== ALL.id} reset={() => { setFilters(EMPTY_FILTERS); inputRef.current?.focus(); }} />}
          />
        )
      }
      detail={
        open
          // Keyed by entry: each one starts fresh (no related list or body from the previous entry).
          ? <Detail key={open.key} row={open} client={client} onOpen={openRow} onClose={back} takeFocus={narrow} />
          // A sample is a fresh search in its source: no filters carried over that could hide it.
          : <Intro onPick={loadError ? undefined : (s, sample) => { setFilters({ ...EMPTY_FILTERS, source: s }); setQ(sample); inputRef.current?.focus(); }} />
      }
    />
  );
}
