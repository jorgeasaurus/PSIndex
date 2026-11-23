import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Search, X, Sun, Moon, SlidersHorizontal } from 'lucide-preact';
import { SearchClient } from './client';
import { AsciiField } from './ascii';
import { effectiveTheme, readTheme, writeTheme, type Theme } from './theme';
import { ResultList, ResultsSkeleton } from './ResultList';
import { Detail } from './Detail';
import { ALL, SOURCES, SOURCE_NAMES, TOTAL, isScope, scopeOf, srcStyle } from './sources';
import type { Facets, Filters, Row, SourceId } from './types';

const EMPTY_FILTERS: Filters = { source: ALL.id, verb: '', module: '', category: '', extra: '', examples: false };
const NO_FACETS: Facets = { verbs: [], modules: [], categories: [], extras: [] };

function readUrl(): { q: string; filters: Filters; open: string } {
  const p = new URLSearchParams(location.search);
  const s = p.get('s') ?? ALL.id;
  return {
    q: p.get('q') ?? '',
    open: p.get('c') ?? '',
    filters: {
      source: isScope(s) ? s : ALL.id,
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

const fmt = new Intl.NumberFormat('en-US');

const sameFilters = (a: Filters, b: Filters) => (Object.keys(a) as (keyof Filters)[]).every((k) => a[k] === b[k]);

/** The entry in the detail pane: its key (from a click or a link) and, once resolved, its row. */
interface Open { key: string; row: Row | null }
const CLOSED: Open = { key: '', row: null };

let measureCtx: CanvasRenderingContext2D | null = null;
/** Width of `text` in `el`'s font, for placing the search ripple at the caret. */
function textWidth(el: HTMLElement, text: string) {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = getComputedStyle(el).font;
  return measureCtx.measureText(text).width;
}

export default function App() {
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [refs, setRefs] = useState<Int32Array | null>(null);
  const [facets, setFacets] = useState<Facets>(NO_FACETS);
  const [ms, setMs] = useState(0);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<Open>(CLOSED);
  const [showFilters, setShowFilters] = useState(false);
  const [theme, setTheme] = useState<Theme | null>(null); // null = follow the OS
  const [loadError, setLoadError] = useState('');
  const [client, setClient] = useState<SearchClient | null>(null); // created after mount; null while server-rendering

  const field = useRef<AsciiField | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Boot worker + ASCII field, then adopt the URL state.
  useEffect(() => {
    const initial = readUrl();
    setQ(initial.q);
    setFilters(initial.filters);
    setOpen({ key: initial.open, row: null });
    setClient(new SearchClient({
      onResults: (r) => { setRefs(r.refs); setFacets(r.facets); setMs(r.ms); },
      onLoadError: setLoadError,
    }));
    if (canvasRef.current) {
      field.current = new AsciiField(canvasRef.current);
      field.current.start();
    }
    setTheme(readTheme());
  }, []);

  // Run search whenever the query or filters change.
  useEffect(() => {
    client?.search(q, filters);
    setActive(0);
  }, [q, filters, client]);

  // Mirror state into the URL, once the boot effect has adopted the URL (it sets `client` in the same batch).
  useEffect(() => { if (client) writeUrl(q, filters, open.key); }, [q, filters, open.key, client]);

  // Resolve a key that has no row yet (a deep link). An old or unqualified key adopts the row's canonical key.
  useEffect(() => {
    if (!client || !open.key || open.row) return;
    let live = true; // a later click or close supersedes this lookup
    client.request('find', { key: open.key }).then((row) => live && setOpen(row ? { key: row.key, row } : CLOSED));
    return () => { live = false; };
  }, [open, client]);

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

  const pulseFromInput = () => {
    const el = inputRef.current;
    if (!el || !field.current) return;
    const r = el.getBoundingClientRect();
    const caret = Math.min(r.right - 24, r.left + parseFloat(getComputedStyle(el).paddingLeft) + textWidth(el, el.value));
    field.current.pulse(caret, r.top + r.height / 2, 1);
  };

  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  // Verb and the examples flag mean the same in every source, so they carry over; module, category and extra don't.
  const setSource = (s: Filters['source']) => setFilters((f) => ({ ...EMPTY_FILTERS, source: s, verb: f.verb, examples: f.examples }));

  const openRow = useCallback((row: Row) => {
    setOpen({ key: row.key, row });
    // Opening an entry sends a pulse from the detail pane, so the field marks every step of a lookup.
    const pane = document.querySelector('.pane-detail')?.getBoundingClientRect();
    if (pane && pane.width) field.current?.pulse(pane.left + 40, pane.top + 40, 0.7);
  }, []);
  const close = useCallback(() => setOpen(CLOSED), []);

  const onInputKey = async (e: KeyboardEvent) => {
    // The box is autofocused, so the "/" shortcut lands here; nobody searches for a leading slash.
    if (e.key === '/' && !(e.target as HTMLInputElement).value) { e.preventDefault(); return; }
    if (!refs || !client) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(refs.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && refs.length) {
      e.preventDefault();
      const [row] = await client.request('rows', { refs: [refs[active]] });
      if (row) openRow(row);
    } else if (e.key === 'Escape') {
      if (open.key) close(); else if (q) setQ('');
    }
  };

  const activeFilterCount = [filters.verb, filters.module, filters.category, filters.extra, filters.examples].filter(Boolean).length;
  const scope = scopeOf(filters.source);

  const resultsLabel = loadError ? 'Index unavailable' : refs == null ? 'Loading index…' : `${fmt.format(refs.length)} ${refs.length === 1 ? 'result' : 'results'}`;
  const toggleTheme = () => {
    const next: Theme = effectiveTheme(theme) === 'dark' ? 'light' : 'dark';
    writeTheme(next);
    setTheme(next);
  };

  return (
    <div class="app" style={srcStyle(filters.source)} data-open={open.key ? '' : undefined}>
      <canvas ref={canvasRef} class="field" aria-hidden="true" />

      <header class="band">
        <div class="band-top">
          <a class="wordmark" data-quiet href="/" aria-label="PSIndex home" onClick={(e) => { e.preventDefault(); setQ(''); setFilters(EMPTY_FILTERS); close(); }}>
            <span class="wordmark-ps">PS</span>Index
          </a>
          <p class="tagline" data-quiet>PowerShell cmdlets for {SOURCE_NAMES}. One index.</p>
          <div class="band-actions" data-quiet>
            <button class="icon-btn" type="button" onClick={toggleTheme} aria-label="Toggle light or dark theme">
              <Sun class="i-sun" size={18} /><Moon class="i-moon" size={18} />
            </button>
            <a class="icon-btn" href="https://github.com/jorgeasaurus/PSIndex" aria-label="Source on GitHub"><GithubMark /></a>
          </div>
        </div>

        <div class="searchbox" role="search">
          <Search class="searchbox-icon" size={20} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={q}
            autoFocus
            spellcheck={false}
            autoComplete="off"
            aria-label="Search cmdlets"
            aria-controls="results"
            placeholder={scope.placeholder}
            onInput={(e) => { setQ((e.target as HTMLInputElement).value); pulseFromInput(); }}
            onKeyDown={onInputKey}
          />
          {q ? (
            <button class="icon-btn searchbox-clear" type="button" aria-label="Clear search" onClick={() => { setQ(''); inputRef.current?.focus(); }}><X size={16} /></button>
          ) : (
            <kbd class="searchbox-kbd" aria-hidden="true">/</kbd>
          )}
        </div>

        <nav class="sources" aria-label="Source">
          <SourceTab id={ALL.id} label="All" count={TOTAL} current={filters.source} onPick={setSource} />
          {SOURCES.map((s) => (
            <SourceTab key={s.id} id={s.id} label={s.short} count={s.count} current={filters.source} onPick={setSource} />
          ))}
        </nav>
      </header>

      <main class="work">
        <section class="pane pane-results" aria-label="Results">
          <div class="toolbar">
            <span class="count" aria-live="polite">{resultsLabel}{refs && q ? <span class="ms"> · {ms < 1 ? '<1' : Math.round(ms)} ms</span> : null}</span>
            <button
              type="button"
              class={'chip' + (showFilters || activeFilterCount ? ' is-on' : '')}
              aria-expanded={showFilters}
              aria-controls="filters"
              onClick={() => setShowFilters((s) => !s)}
            >
              <SlidersHorizontal size={14} /> Filters{activeFilterCount ? <span class="chip-n">{activeFilterCount}</span> : null}
            </button>
          </div>
          {showFilters && (
            <FilterBar facets={facets} filters={filters} setFilter={setFilter} clear={() => setFilters((f) => ({ ...EMPTY_FILTERS, source: f.source }))} />
          )}
          {client ? <ResultList
            client={client}
            refs={refs}
            active={active}
            setActive={setActive}
            openKey={open.key}
            onOpen={openRow}
            query={q}
            empty={<EmptyState q={q} inLabel={scope.inLabel} filtered={!sameFilters(filters, EMPTY_FILTERS)} reset={() => setFilters(EMPTY_FILTERS)} />}
            failed={loadError ? (
              <div class="empty" role="alert">
                <p class="empty-title">The search index didn’t load.</p>
                <p>{loadError}. Check your connection, then reload the page.</p>
                <button type="button" class="chip" onClick={() => location.reload()}>Reload</button>
              </div>
            ) : null}
          /> : <ResultsSkeleton />}
        </section>

        <section class="pane pane-detail" aria-label="Details">
          {open.row && client ? (
            <Detail row={open.row} client={client} onOpen={openRow} onClose={close} />
          ) : (
            <Intro onPick={(s, qq) => { setSource(s); setQ(qq); inputRef.current?.focus(); }} />
          )}
        </section>
      </main>
    </div>
  );
}

function SourceTab({ id, label, count, current, onPick }: { id: Filters['source']; label: string; count: number; current: string; onPick: (s: Filters['source']) => void }) {
  const on = id === current;
  return (
    <button type="button" class={'source' + (on ? ' is-on' : '')} aria-pressed={on} style={srcStyle(id)} onClick={() => onPick(id)}>
      <span class="source-dot" aria-hidden="true" />
      {label}
      <span class="source-n">{fmt.format(count)}</span>
    </button>
  );
}

function FilterBar({ facets, filters, setFilter, clear }: { facets: Facets; filters: Filters; setFilter: <K extends keyof Filters>(k: K, v: Filters[K]) => void; clear: () => void }) {
  const { extraLabel } = scopeOf(filters.source);
  return (
    <div class="filters" id="filters">
      {facets.verbs.length > 0 && (
        <Select label="Verb" value={filters.verb} options={facets.verbs} onChange={(v) => setFilter('verb', v)} />
      )}
      {facets.modules.length > 1 && (
        <Select label="Module" value={filters.module} options={facets.modules} onChange={(v) => setFilter('module', v)} />
      )}
      {facets.categories.length > 1 && (
        <Select label="Category" value={filters.category} options={facets.categories} onChange={(v) => setFilter('category', v)} />
      )}
      {extraLabel && facets.extras.length > 1 && (
        <Select label={extraLabel} value={filters.extra} options={facets.extras} onChange={(v) => setFilter('extra', v)} />
      )}
      <label class="check">
        <input type="checkbox" checked={filters.examples} onChange={(e) => setFilter('examples', (e.target as HTMLInputElement).checked)} />
        Has examples
      </label>
      <button type="button" class="link-btn" onClick={clear}>Reset</button>
    </div>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label class="select">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        <option value="">Any</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function EmptyState({ q, inLabel, filtered, reset }: { q: string; inLabel: string; filtered: boolean; reset: () => void }) {
  return (
    <div class="empty">
      <p class="empty-title">{q ? <>No match for “{q}”{inLabel}.</> : 'Nothing matches these filters.'}</p>
      <p>Try the noun alone (<code>MgUser</code> instead of <code>Get-MgUser</code>), or fewer words.</p>
      {filtered && <button type="button" class="chip" onClick={reset}>Search every source</button>}
    </div>
  );
}

function Intro({ onPick }: { onPick: (s: SourceId, q: string) => void }) {
  return (
    <div class="intro">
      <h2>Type a fragment. Get the command.</h2>
      <p class="intro-lede">
        {fmt.format(TOTAL)} cmdlets from {SOURCES.length} Microsoft docs sets, searched in your browser. Pick a result for its syntax, parameters, examples and permissions.
      </p>
      <ul class="intro-samples" aria-label="Example searches">
        {SOURCES.map((s) => (
          <li key={s.id}>
            <button type="button" style={srcStyle(s.id)} onClick={() => onPick(s.id, s.sample)}>
              <span class="source-dot" aria-hidden="true" /><code>{s.sample}</code>
            </button>
          </li>
        ))}
      </ul>
      <dl class="intro-sources">
        {SOURCES.map((s) => (
          <div key={s.id} style={srcStyle(s.id)}>
            <dt><span class="source-dot" aria-hidden="true" />{s.label}</dt>
            <dd>{fmt.format(s.count)}{s.version && s.version !== '0.0.0' ? <span> · v{s.version}</span> : null}</dd>
          </div>
        ))}
      </dl>
      <p class="intro-keys"><kbd>/</kbd> search <kbd>↑</kbd><kbd>↓</kbd> move <kbd>Enter</kbd> open <kbd>Esc</kbd> close</p>
    </div>
  );
}

function GithubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
