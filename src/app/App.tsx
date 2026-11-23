import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Search, X, Sun, Moon, SlidersHorizontal } from 'lucide-preact';
import { SearchClient } from './client';
import { AsciiField } from './ascii';
import { ResultList, ResultsSkeleton } from './ResultList';
import { Detail } from './Detail';
import { KINDS, SOURCES, TOTAL, kindOf, sourceColor, sourceMeta, srcStyle } from './sources';
import type { Facets, Filters, Row, SourceId } from './types';

const EMPTY_FILTERS: Filters = { source: 'all', verb: '', module: '', category: '', extra: '', examples: false };
const NO_FACETS: Facets = { verbs: [], modules: [], categories: [], extras: [] };

function readUrl(): { q: string; filters: Filters; open: string } {
  const p = new URLSearchParams(location.search);
  const s = p.get('s') ?? 'all';
  return {
    q: p.get('q') ?? '',
    open: p.get('c') ?? '',
    filters: {
      source: sourceMeta(s) ? s : 'all',
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
  if (f.source !== 'all') p.set('s', f.source);
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
  const [openKey, setOpenKey] = useState('');
  const [openRow, setOpenRow] = useState<Row | null>(null);
  const [descTick, setDescTick] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
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
    setOpenKey(initial.open);
    setClient(new SearchClient({
      onResults: (r) => { setRefs(r.refs); setFacets(r.facets); setMs(r.ms); },
      onDescriptions: () => setDescTick((t) => t + 1),
      onLoadError: setLoadError,
    }));
    if (canvasRef.current) {
      const f = new AsciiField({ canvas: canvasRef.current });
      field.current = f;
      f.setTone(fieldColor(initial.filters.source), toneDim());
      document.fonts?.ready.then(() => f.refresh());
      f.start();
      const quiet = () => f.setQuiet([...document.querySelectorAll('[data-quiet]')].map((el) => el.getBoundingClientRect()));
      quiet();
      addEventListener('resize', quiet, { passive: true });
      document.fonts?.ready.then(quiet);
    }
    try {
      const saved = localStorage.getItem('psindex-theme') as 'light' | 'dark' | null;
      if (saved) setTheme(saved);
    } catch {}
  }, []);

  // Run search whenever the query or filters change.
  useEffect(() => {
    client?.search(q, filters);
    setActive(0);
    writeUrl(q, filters, openKey);
  }, [q, filters, client]);

  useEffect(() => writeUrl(q, filters, openKey), [openKey]);

  // Resolve the open entry (deep links, clicks, keyboard).
  useEffect(() => {
    if (!openKey) { setOpenRow(null); return; }
    if (!client || openRow?.key === openKey) return;
    let live = true; // a later click or close supersedes this lookup
    client.request('find', { key: openKey }).then((r) => {
      if (!live) return;
      setOpenRow(r);
      // An old or unqualified link resolved to a row: adopt its canonical key so the row highlights and the URL updates.
      if (r && r.key !== openKey) setOpenKey(r.key);
    });
    return () => { live = false; };
  }, [openKey, client]);

  // Source tint for the field; keep the active tab visible on narrow screens.
  useEffect(() => {
    field.current?.setTone(fieldColor(filters.source), toneDim());
    document.querySelector('.source.is-on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [filters.source, theme]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
    try { theme ? localStorage.setItem('psindex-theme', theme) : localStorage.removeItem('psindex-theme'); } catch {}
  }, [theme]);

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
  // Verb and the examples flag carry over between sources of the same kind; across kinds they mean different things.
  const setSource = (s: Filters['source']) =>
    setFilters((f) => {
      const keep = kindOf(s) === kindOf(f.source);
      return { ...EMPTY_FILTERS, source: s, examples: keep && f.examples, verb: keep ? f.verb : '' };
    });

  const open = useCallback((row: Row) => {
    setOpenRow(row);
    setOpenKey(row.key);
    // Opening an entry sends a pulse from the detail pane, so the field marks every step of a lookup.
    const pane = document.querySelector('.pane-detail')?.getBoundingClientRect();
    if (pane && pane.width) field.current?.pulse(pane.left + 40, pane.top + 40, 0.7);
  }, []);
  const close = useCallback(() => { setOpenKey(''); setOpenRow(null); }, []);

  const onInputKey = async (e: KeyboardEvent) => {
    // The box is autofocused, so the "/" shortcut lands here; nobody searches for a leading slash.
    if (e.key === '/' && !(e.target as HTMLInputElement).value) { e.preventDefault(); return; }
    if (!refs || !client) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(refs.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && refs.length) {
      e.preventDefault();
      const [row] = await client.request('rows', { refs: [refs[active]] });
      if (row) open(row);
    } else if (e.key === 'Escape') {
      if (openKey) close(); else if (q) setQ('');
    }
  };

  const activeFilterCount = [filters.verb, filters.module, filters.category, filters.extra, filters.examples].filter(Boolean).length;
  const srcMeta = sourceMeta(filters.source);
  const placeholder = srcMeta ? KINDS[srcMeta.kind].placeholder(srcMeta) : `Search ${fmt.format(TOTAL)} cmdlets & errors`;

  const resultsLabel = loadError ? 'Index unavailable' : refs == null ? 'Loading index…' : `${fmt.format(refs.length)} ${refs.length === 1 ? 'result' : 'results'}`;
  const toggleTheme = () => {
    const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(dark ? 'light' : 'dark');
  };

  return (
    <div class="app" style={srcStyle(filters.source)} data-open={openKey ? '' : undefined}>
      <canvas ref={canvasRef} class="field" aria-hidden="true" />

      <header class="band">
        <div class="band-top">
          <a class="wordmark" data-quiet href="/" aria-label="PSIndex home" onClick={(e) => { e.preventDefault(); setQ(''); setFilters(EMPTY_FILTERS); close(); }}>
            <span class="wordmark-ps">PS</span>Index
          </a>
          <p class="tagline" data-quiet>PowerShell for Graph, Az, Entra, Exchange and MECM, plus Microsoft error codes. One index.</p>
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
            aria-label="Search cmdlets and error codes"
            aria-controls="results"
            placeholder={placeholder}
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
          <SourceTab id="all" label="All" count={TOTAL} current={filters.source} onPick={setSource} />
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
            openKey={openKey}
            onOpen={open}
            descTick={descTick}
            query={q}
            empty={<EmptyState q={q} filters={filters} sourceLabel={srcMeta?.short} reset={() => setFilters(EMPTY_FILTERS)} />}
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
          {openRow && client ? (
            <Detail row={openRow} client={client} onOpen={open} onClose={close} />
          ) : (
            <Intro onPick={(s, qq) => { setSource(s); setQ(qq); inputRef.current?.focus(); }} />
          )}
        </section>
      </main>
    </div>
  );
}

/** Source hue for the canvas; darkened in light theme so glyphs read on the pale ground. */
function fieldColor(s: Filters['source']) {
  const hex = sourceColor(s);
  if (toneDim() > 0.8) {
    const n = parseInt(hex.slice(1), 16);
    const k = 0.62;
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k).toString(16).padStart(2, '0'));
    return '#' + c.join('');
  }
  return hex;
}

function toneDim() {
  const root = document.documentElement;
  const light = root.dataset.theme ? root.dataset.theme === 'light' : !matchMedia('(prefers-color-scheme: dark)').matches;
  return light ? 0.85 : 0.78;
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
  const kind = kindOf(filters.source);
  const extraLabel = sourceMeta(filters.source)?.extraLabel;
  return (
    <div class="filters" id="filters">
      {kind.hasVerbs && facets.verbs.length > 0 && (
        <Select label="Verb" value={filters.verb} options={facets.verbs} onChange={(v) => setFilter('verb', v)} />
      )}
      {facets.modules.length > 1 && (
        <Select label={kind.moduleLabel} value={filters.module} options={facets.modules} onChange={(v) => setFilter('module', v)} />
      )}
      {facets.categories.length > 1 && (
        <Select label="Category" value={filters.category} options={facets.categories} onChange={(v) => setFilter('category', v)} />
      )}
      {extraLabel && facets.extras.length > 1 && (
        <Select label={extraLabel} value={filters.extra} options={facets.extras} onChange={(v) => setFilter('extra', v)} />
      )}
      <label class="check">
        <input type="checkbox" checked={filters.examples} onChange={(e) => setFilter('examples', (e.target as HTMLInputElement).checked)} />
        {kind.flagLabel}
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

function EmptyState({ q, filters, sourceLabel, reset }: { q: string; filters: Filters; sourceLabel?: string; reset: () => void }) {
  const filtered = filters.source !== 'all' || filters.verb || filters.module || filters.category || filters.extra || filters.examples;
  return (
    <div class="empty">
      <p class="empty-title">{q ? <>No match for “{q}”{sourceLabel ? ` in ${sourceLabel}` : ''}.</> : 'Nothing matches these filters.'}</p>
      <p>Try the noun alone (<code>MgUser</code> instead of <code>Get-MgUser</code>), fewer words, or an error code without the <code>0x</code>.</p>
      {filtered && <button type="button" class="chip" onClick={reset}>Search every source</button>}
    </div>
  );
}

function Intro({ onPick }: { onPick: (s: SourceId, q: string) => void }) {
  return (
    <div class="intro">
      <h2>Type a fragment. Get the command.</h2>
      <p class="intro-lede">
        {fmt.format(TOTAL)} entries from six Microsoft docs sets, searched in your browser. Pick a result for its syntax, parameters, examples and permissions.
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
            <dd>{fmt.format(s.count)}{s.version && s.version !== '0.0.0' ? <span> · {KINDS[s.kind].versionPrefix}{s.version}</span> : null}</dd>
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
