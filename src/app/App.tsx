import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { SearchClient } from './client';
import { AsciiField } from './ascii';
import { effectiveTheme, readTheme, writeTheme, type Theme } from './theme';
import { ResultList, ResultsSkeleton } from './ResultList';
import { Detail } from './Detail';
import { Band, EmptyState, FilterBar, Frame, Intro, LoadFailed, Toolbar } from './chrome';
import { ALL, parseScope, scopeOf } from './sources';
import type { Facets, Filters, Row } from './types';

const EMPTY_FILTERS: Filters = { source: ALL.id, verb: '', module: '', category: '', extra: '', examples: false };
const NO_FACETS: Facets = { verbs: [], modules: [], categories: [], extras: [] };
const fmt = new Intl.NumberFormat('en-US');

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
      band={<Band q="" source={ALL.id} placeholder={ALL.placeholder} />}
      toolbar={<Toolbar label="Loading index…" filterCount={0} showFilters={false} />}
      results={<ResultsSkeleton />}
      detail={<Intro />}
    />
  );
}

/** The entry in the detail pane: its key (from a click or a link) and, once resolved, its row. */
interface Open { key: string; row: Row | null }
const CLOSED: Open = { key: '', row: null };

interface UrlState { q: string; filters: Filters; open: Open }

function readUrl(): UrlState {
  const p = new URLSearchParams(location.search);
  return {
    q: p.get('q') ?? '',
    open: { key: p.get('c') ?? '', row: null },
    filters: {
      source: parseScope(p.get('s')),
      verb: p.get('verb') ?? '',
      module: p.get('module') ?? '',
      category: p.get('cat') ?? '',
      extra: p.get('ver') ?? '',
      examples: p.get('ex') === '1',
    },
  };
}

function writeUrl(q: string, f: Filters, open: string) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (f.source !== EMPTY_FILTERS.source) p.set('s', f.source);
  if (f.verb) p.set('verb', f.verb);
  if (f.module) p.set('module', f.module);
  if (f.category) p.set('cat', f.category);
  if (f.extra) p.set('ver', f.extra);
  if (f.examples) p.set('ex', '1');
  if (open) p.set('c', open);
  const qs = p.toString();
  const url = location.pathname + (qs ? '?' + qs : '');
  if (url !== location.pathname + location.search) history.replaceState(null, '', url);
}

const sameFilters = (a: Filters, b: Filters) => (Object.keys(a) as (keyof Filters)[]).every((k) => a[k] === b[k]);

let measureCtx: CanvasRenderingContext2D | null = null;
/** Width of `text` in `el`'s font, for placing the search ripple at the caret. */
function textWidth(el: HTMLElement, text: string) {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = getComputedStyle(el).font;
  return measureCtx.measureText(text).width;
}

function Search() {
  const [initial] = useState(readUrl);
  const [q, setQ] = useState(initial.q);
  const [filters, setFilters] = useState(initial.filters);
  const [open, setOpen] = useState(initial.open);
  const [refs, setRefs] = useState<Int32Array | null>(null);
  const [facets, setFacets] = useState<Facets>(NO_FACETS);
  const [ms, setMs] = useState(0);
  const [active, setActive] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [theme, setTheme] = useState<Theme | null>(readTheme); // null = follow the OS
  const [loadError, setLoadError] = useState('');
  const [client] = useState(() => new SearchClient({
    onResults: (r) => { setRefs(r.refs); setFacets(r.facets); setMs(r.ms); },
    onLoadError: setLoadError,
  }));

  const field = useRef<AsciiField | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    field.current = new AsciiField(canvasRef.current!);
    field.current.start();
  }, []);

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

  // Field tint follows the source and theme; keep the active tab visible on narrow screens.
  useEffect(() => {
    field.current?.setTone(scopeOf(filters.source).color, effectiveTheme(theme));
    document.querySelector('.source.is-on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [filters.source, theme]);

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

  const query = (value: string) => {
    setQ(value);
    const el = inputRef.current!;
    const r = el.getBoundingClientRect();
    const caret = Math.min(r.right - 24, r.left + parseFloat(getComputedStyle(el).paddingLeft) + textWidth(el, value));
    field.current?.pulse(caret, r.top + r.height / 2, 1);
  };

  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  // Verb and the examples flag mean the same in every source, so they carry over; module, category and extra don't.
  const setSource = (s: Filters['source']) => setFilters((f) => ({ ...EMPTY_FILTERS, source: s, verb: f.verb, examples: f.examples }));

  const openRow = useCallback((row: Row) => {
    setOpen({ key: row.key, row });
    // Opening an entry sends a pulse from the detail pane, so the field marks every step of a lookup.
    const pane = document.querySelector('.pane-detail')?.getBoundingClientRect();
    if (pane?.width) field.current?.pulse(pane.left + 40, pane.top + 40, 0.7);
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

  const scope = scopeOf(filters.source);
  const filterCount = [filters.verb, filters.module, filters.category, filters.extra, filters.examples].filter(Boolean).length;
  const countLabel = loadError
    ? 'Index unavailable'
    : refs == null
      ? 'Loading index…'
      : <>{fmt.format(refs.length)} {refs.length === 1 ? 'result' : 'results'}{q ? <span class="ms"> · {ms < 1 ? '<1' : Math.round(ms)} ms</span> : null}</>;

  return (
    <Frame
      source={filters.source}
      isOpen={!!open.key}
      canvasRef={canvasRef}
      band={
        <Band
          q={q}
          source={filters.source}
          placeholder={scope.placeholder}
          inputRef={inputRef}
          onQuery={query}
          onKeyDown={onKeyDown}
          onClear={() => { setQ(''); inputRef.current?.focus(); }}
          onHome={() => { setQ(''); setFilters(EMPTY_FILTERS); close(); }}
          onToggleTheme={toggleTheme}
          onPickSource={setSource}
        />
      }
      toolbar={
        <>
          <Toolbar label={countLabel} filterCount={filterCount} showFilters={showFilters} onToggleFilters={() => setShowFilters((s) => !s)} />
          {showFilters && (
            <FilterBar facets={facets} filters={filters} extraLabel={scope.extraLabel} setFilter={setFilter} clear={() => setFilters((f) => ({ ...EMPTY_FILTERS, source: f.source }))} />
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
            empty={<EmptyState q={q} inLabel={scope.inLabel} filtered={!sameFilters(filters, EMPTY_FILTERS)} reset={() => setFilters(EMPTY_FILTERS)} />}
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
