import { createRef } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { SearchClient } from './client';
import { useAsciiField } from './ascii';
import { useTheme } from './theme';
import { ResultList, ResultsSkeleton } from './ResultList';
import { Detail } from './Detail';
import { Band, EmptyState, FilterBar, Frame, INERT_BAND, Intro, LoadFailed, Toolbar } from './chrome';
import { ALL, formatCount, scopeOf } from './sources';
import { EMPTY_FILTERS, readUrl, writeUrl } from './url';
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
      inert
      canvasRef={createRef()}
      detailRef={createRef()}
      band={<Band q="" source={ALL.id} placeholder={ALL.placeholder} inputRef={createRef()} handlers={INERT_BAND} />}
      toolbar={<Toolbar label="Loading index…" filterCount={0} showFilters={false} onToggleFilters={() => {}} />}
      results={<ResultsSkeleton />}
      detail={<Intro onPick={() => {}} />}
    />
  );
}

const NO_FACETS: Facets = { verbs: [], modules: [], categories: [], extras: [] };

/** Filters narrowing the results within the chosen source (the source itself is shown by the tabs). */
const activeFilters = (f: Filters) => (Object.keys(f) as (keyof Filters)[]).filter((k) => k !== 'source' && f[k] !== EMPTY_FILTERS[k]).length;

// ---- Search session ------------------------------------------------------------------------

function Search() {
  const [initial] = useState(readUrl);
  const [q, setQ] = useState(initial.q);
  const [filters, setFilters] = useState(initial.filters);
  // The open entry, and a deep-linked key still being looked up (only ever the one from the URL).
  const [open, setOpen] = useState<Row | null>(null);
  const [link, setLink] = useState(initial.open);
  const [results, setResults] = useState<Results | null>(null);
  const [active, setActive] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [client] = useState(() => new SearchClient({ onResults: setResults, onLoadError: setLoadError }));

  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const scope = scopeOf(filters.source);
  const { theme, toggle: toggleTheme } = useTheme();
  const pulse = useAsciiField(canvasRef, scope.color, theme);
  const refs = results?.refs ?? null;

  useEffect(() => client.search(q, filters), [q, filters]);
  // A new result set starts with the cursor on its first row; a refresh of the same search keeps it.
  useEffect(() => setActive(0), [results?.id]);

  // Until the deep link resolves, keep it in the URL so a reload still opens it.
  const openKey = open?.key ?? link;
  useEffect(() => writeUrl({ q, filters, open: openKey }), [q, filters, openKey]);

  // Resolve the deep link. An old or unqualified key adopts the row's canonical key.
  useEffect(() => {
    if (!link) return;
    let live = true; // opening or closing an entry clears `link` and supersedes this lookup
    client.request('find', { key: link }).then((row) => { if (live) { setOpen(row); setLink(''); } });
    return () => { live = false; };
  }, [link]);

  // Global keys: "/" or Ctrl/Cmd+K focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select');
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  // Verb and the examples flag mean the same in every source, so they survive a source switch.
  const setSource = (source: Filters['source']) => setFilters((f) => ({ ...EMPTY_FILTERS, source, verb: f.verb, examples: f.examples }));

  const openRow = useCallback((row: Row) => {
    setOpen(row);
    setLink('');
    // Opening an entry sends a pulse from the detail pane, so the field marks every step of a lookup.
    const pane = detailRef.current?.getBoundingClientRect();
    if (pane?.width) pulse({ x: pane.left + 40, y: pane.top + 40 }, 0.7);
  }, []);
  const close = useCallback(() => { setOpen(null); setLink(''); }, []);

  const onKeyDown = async (e: KeyboardEvent) => {
    // The box is autofocused, so the "/" shortcut lands here; nobody searches for a leading slash.
    if (e.key === '/' && !(e.target as HTMLInputElement).value) { e.preventDefault(); return; }
    if (e.key === 'Escape') { if (openKey) close(); else if (q) setQ(''); return; }
    if (!refs?.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(refs.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // Refs are stable across result sets, so this is the row under the cursor even if new results land meanwhile.
      const [row] = await client.request('rows', { refs: [refs[active]] });
      openRow(row);
    }
  };

  const filterCount = activeFilters(filters);
  const countLabel = loadError
    ? 'Index unavailable'
    : !results
      ? 'Loading index…'
      : <>{formatCount(results.refs.length)} {results.refs.length === 1 ? 'result' : 'results'}{q ? <span class="ms"> · {results.ms < 1 ? '<1' : Math.round(results.ms)} ms</span> : null}</>;

  return (
    <Frame
      source={filters.source}
      isOpen={!!open}
      inert={false}
      canvasRef={canvasRef}
      detailRef={detailRef}
      band={
        <Band
          q={q}
          source={filters.source}
          placeholder={scope.placeholder}
          inputRef={inputRef}
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
            client={client}
            refs={refs}
            active={active}
            setActive={setActive}
            openKey={openKey}
            onOpen={openRow}
            query={q}
            searchId={results?.id ?? 0}
            empty={<EmptyState q={q} inLabel={scope.inLabel} filtered={filterCount > 0 || filters.source !== ALL.id} reset={() => setFilters(EMPTY_FILTERS)} />}
          />
        )
      }
      detail={
        open
          ? <Detail row={open} client={client} onOpen={openRow} onClose={close} />
          : <Intro onPick={(s, sample) => { setSource(s); setQ(sample); inputRef.current?.focus(); }} />
      }
    />
  );
}
