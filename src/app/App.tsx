import { createRef } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { SearchClient } from './client';
import { useAsciiField } from './ascii';
import { effectiveTheme, readTheme, writeTheme, type Theme } from './theme';
import { ResultList, ResultsSkeleton } from './ResultList';
import { Detail } from './Detail';
import { Band, EmptyState, FilterBar, Frame, INERT_BAND, Intro, LoadFailed, Toolbar } from './chrome';
import { ALL, formatCount, parseScope, scopeOf } from './sources';
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
      canvasRef={createRef()}
      detailRef={createRef()}
      band={<Band q="" source={ALL.id} placeholder={ALL.placeholder} inputRef={createRef()} handlers={INERT_BAND} />}
      toolbar={<Toolbar label="Loading index…" filterCount={0} showFilters={false} onToggleFilters={() => {}} />}
      results={<ResultsSkeleton />}
      detail={<Intro onPick={() => {}} />}
    />
  );
}

// ---- URL state -----------------------------------------------------------------------------

const EMPTY_FILTERS: Filters = { source: ALL.id, verb: '', module: '', category: '', extra: '', examples: false };
const NO_FACETS: Facets = { verbs: [], modules: [], categories: [], extras: [] };

/** Each filter's URL parameter. */
const PARAMS: Record<keyof Filters, string> = { source: 's', verb: 'verb', module: 'module', category: 'cat', extra: 'ver', examples: 'ex' };

/** Filters narrowing the results within the chosen source (the source itself is shown by the tabs). */
const activeFilters = (f: Filters) => (Object.keys(f) as (keyof Filters)[]).filter((k) => k !== 'source' && f[k] !== EMPTY_FILTERS[k]).length;

/** The entry in the detail pane: its key (from a click or a link) and, once resolved, its row. */
interface Open { key: string; row: Row | null }
const CLOSED: Open = { key: '', row: null };

function readUrl(): { q: string; filters: Filters; open: Open } {
  const p = new URLSearchParams(location.search);
  const text = (k: Exclude<keyof Filters, 'examples'>) => p.get(PARAMS[k]) ?? '';
  return {
    q: p.get('q') ?? '',
    open: { key: p.get('c') ?? '', row: null },
    filters: {
      source: parseScope(p.get(PARAMS.source)),
      verb: text('verb'),
      module: text('module'),
      category: text('category'),
      extra: text('extra'),
      examples: p.get(PARAMS.examples) === '1',
    },
  };
}

function writeUrl(q: string, f: Filters, open: string) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  for (const k of Object.keys(PARAMS) as (keyof Filters)[]) {
    if (f[k] !== EMPTY_FILTERS[k]) p.set(PARAMS[k], f[k] === true ? '1' : String(f[k]));
  }
  if (open) p.set('c', open);
  const qs = p.toString();
  const url = location.pathname + (qs ? '?' + qs : '');
  if (url !== location.pathname + location.search) history.replaceState(null, '', url);
}

// ---- Search session ------------------------------------------------------------------------

function Search() {
  const [initial] = useState(readUrl);
  const [q, setQ] = useState(initial.q);
  const [filters, setFilters] = useState(initial.filters);
  const [open, setOpen] = useState(initial.open);
  const [results, setResults] = useState<Results | null>(null);
  const [active, setActive] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [theme, setTheme] = useState<Theme | null>(readTheme); // null = follow the OS
  const [loadError, setLoadError] = useState('');
  const [client] = useState(() => new SearchClient({ onResults: setResults, onLoadError: setLoadError }));

  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const scope = scopeOf(filters.source);
  const pulse = useAsciiField(canvasRef, scope.color, effectiveTheme(theme));
  const refs = results?.refs ?? null;

  useEffect(() => {
    client.search(q, filters);
    setActive(0);
  }, [q, filters]);

  useEffect(() => writeUrl(q, filters, open.key), [q, filters, open.key]);

  // Resolve a key that has no row yet (a deep link). An old or unqualified key adopts the row's canonical key.
  useEffect(() => {
    if (!open.key || open.row) return;
    let live = true; // a later click or close supersedes this lookup
    client.request('find', { key: open.key }).then((row) => live && setOpen(row ? { key: row.key, row } : CLOSED));
    return () => { live = false; };
  }, [open]);

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
    setOpen({ key: row.key, row });
    // Opening an entry sends a pulse from the detail pane, so the field marks every step of a lookup.
    const pane = detailRef.current?.getBoundingClientRect();
    if (pane?.width) pulse({ x: pane.left + 40, y: pane.top + 40 }, 0.7);
  }, []);
  const close = useCallback(() => setOpen(CLOSED), []);

  const onKeyDown = async (e: KeyboardEvent) => {
    // The box is autofocused, so the "/" shortcut lands here; nobody searches for a leading slash.
    if (e.key === '/' && !(e.target as HTMLInputElement).value) { e.preventDefault(); return; }
    if (e.key === 'Escape') { if (open.key) close(); else if (q) setQ(''); return; }
    if (!refs?.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(refs.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const [row] = await client.rows([refs[active]]);
      openRow(row);
    }
  };

  const toggleTheme = () => {
    const next: Theme = effectiveTheme(theme) === 'dark' ? 'light' : 'dark';
    writeTheme(next);
    setTheme(next);
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
      isOpen={!!open.key}
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
            openKey={open.key}
            onOpen={openRow}
            query={q}
            searchKey={JSON.stringify([q, filters])}
            empty={<EmptyState q={q} inLabel={scope.inLabel} filtered={filterCount > 0 || filters.source !== ALL.id} reset={() => setFilters(EMPTY_FILTERS)} />}
          />
        )
      }
      detail={
        open.row
          ? <Detail row={open.row} client={client} onOpen={openRow} onClose={close} />
          : <Intro onPick={(s, sample) => { setSource(s); setQ(sample); inputRef.current?.focus(); }} />
      }
    />
  );
}
