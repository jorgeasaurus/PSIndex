// Presentational pieces of the page. No state: App.tsx renders them statically on the server
// (Shell) and wires them to the search session in the browser (Search).
import type { ComponentChildren, Ref } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Search as SearchIcon, X, Sun, Moon, SlidersHorizontal } from 'lucide-preact';
import { ALL, SOURCES, SOURCE_NAMES, TOTAL, formatCount, srcStyle } from './sources';
import type { Facets, Filters, SourceId } from './types';

/** Page layout: band, results pane, detail pane, over the background canvas. */
export function Frame({ source, isOpen, inert, canvasRef, detailRef, band, toolbar, results, detail }: {
  source: SourceId;
  isOpen: boolean;
  /** The static server-rendered frame, before the search session takes over. */
  inert: boolean;
  canvasRef: Ref<HTMLCanvasElement>;
  detailRef: Ref<HTMLElement>;
  band: ComponentChildren;
  toolbar: ComponentChildren;
  results: ComponentChildren;
  detail: ComponentChildren;
}) {
  return (
    <div class="app" style={srcStyle(source)} data-open={isOpen ? '' : undefined} aria-busy={inert || undefined}>
      <canvas ref={canvasRef} class="field" aria-hidden="true" />
      {band}
      <main class="work">
        <section class="pane pane-results" aria-label="Results">{toolbar}{results}</section>
        <section class="pane pane-detail" aria-label="Details" ref={detailRef}>{detail}</section>
      </main>
    </div>
  );
}

export interface BandHandlers {
  /** New query text, and the point just after the caret (for the field's ripple). */
  onQuery: (q: string, caret: { x: number; y: number }) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onClear: () => void;
  onHome: () => void;
  onToggleTheme: () => void;
  onPickSource: (s: SourceId) => void;
}

/** For the static server render, where nothing is interactive yet. */
export const INERT_BAND: BandHandlers = {
  onQuery() {}, onKeyDown() {}, onClear() {}, onHome() {}, onToggleTheme() {}, onPickSource() {},
};

let measureCtx: CanvasRenderingContext2D | null = null;
/** Screen point just after the text in a search input. */
function caretPoint(el: HTMLInputElement) {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = getComputedStyle(el).font;
  const r = el.getBoundingClientRect();
  const x = r.left + parseFloat(getComputedStyle(el).paddingLeft) + measureCtx.measureText(el.value).width;
  return { x: Math.min(r.right - 24, x), y: r.top + r.height / 2 };
}

export function Band({ q, source, placeholder, inputRef, handlers }: {
  q: string;
  source: SourceId;
  placeholder: string;
  inputRef: Ref<HTMLInputElement>;
  handlers: BandHandlers;
}) {
  const { onQuery, onKeyDown, onClear, onHome, onToggleTheme, onPickSource } = handlers;
  return (
    <header class="band">
      <div class="band-top">
        <a class="wordmark" data-quiet href="/" aria-label="PSIndex home" onClick={(e) => { e.preventDefault(); onHome(); }}>
          <span class="wordmark-ps">PS</span>Index
        </a>
        <p class="tagline" data-quiet>PowerShell cmdlets for {SOURCE_NAMES}. One index.</p>
        <div class="band-actions" data-quiet>
          <button class="icon-btn" type="button" onClick={onToggleTheme} aria-label="Toggle light or dark theme">
            <Sun class="i-sun" size={18} /><Moon class="i-moon" size={18} />
          </button>
          <a class="icon-btn" href="https://github.com/jorgeasaurus/PSIndex" aria-label="Source on GitHub"><GithubMark /></a>
        </div>
      </div>

      <div class="searchbox" role="search">
        <SearchIcon class="searchbox-icon" size={20} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          value={q}
          autoFocus
          spellcheck={false}
          autoComplete="off"
          aria-label="Search cmdlets"
          aria-controls="results"
          placeholder={placeholder}
          onInput={(e) => { const el = e.target as HTMLInputElement; onQuery(el.value, caretPoint(el)); }}
          onKeyDown={onKeyDown}
        />
        {q ? (
          <button class="icon-btn searchbox-clear" type="button" aria-label="Clear search" onClick={onClear}><X size={16} /></button>
        ) : (
          <kbd class="searchbox-kbd" aria-hidden="true">/</kbd>
        )}
      </div>

      <nav class="sources" aria-label="Source">
        <SourceTab id={ALL.id} label="All" count={TOTAL} current={source} onPick={onPickSource} />
        {SOURCES.map((s) => <SourceTab key={s.id} id={s.id} label={s.short} count={s.count} current={source} onPick={onPickSource} />)}
      </nav>
    </header>
  );
}

function SourceTab({ id, label, count, current, onPick }: { id: SourceId; label: string; count: number; current: SourceId; onPick: (s: SourceId) => void }) {
  const on = id === current;
  const ref = useRef<HTMLButtonElement>(null);
  // The tab strip scrolls sideways on narrow screens; keep the selected tab in view.
  useEffect(() => { if (on) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [on]);
  return (
    <button ref={ref} type="button" class={'source' + (on ? ' is-on' : '')} aria-pressed={on} style={srcStyle(id)} onClick={() => onPick(id)}>
      <span class="source-dot" aria-hidden="true" />
      {label}
      <span class="source-n">{formatCount(count)}</span>
    </button>
  );
}

export function Toolbar({ label, filterCount, showFilters, onToggleFilters }: { label: ComponentChildren; filterCount: number; showFilters: boolean; onToggleFilters: () => void }) {
  return (
    <div class="toolbar">
      <span class="count" aria-live="polite">{label}</span>
      <button type="button" class={'chip' + (showFilters || filterCount ? ' is-on' : '')} aria-expanded={showFilters} aria-controls="filters" onClick={onToggleFilters}>
        <SlidersHorizontal size={14} /> Filters{filterCount ? <span class="chip-n">{filterCount}</span> : null}
      </button>
    </div>
  );
}

export function FilterBar({ facets, filters, extraLabel, setFilter, clear }: {
  facets: Facets;
  filters: Filters;
  extraLabel: string | null;
  setFilter: <K extends keyof Filters>(k: K, v: Filters[K]) => void;
  clear: () => void;
}) {
  return (
    <div class="filters" id="filters">
      {facets.verbs.length > 0 && <Select label="Verb" value={filters.verb} options={facets.verbs} onChange={(v) => setFilter('verb', v)} />}
      {facets.modules.length > 1 && <Select label="Module" value={filters.module} options={facets.modules} onChange={(v) => setFilter('module', v)} />}
      {facets.categories.length > 1 && <Select label="Category" value={filters.category} options={facets.categories} onChange={(v) => setFilter('category', v)} />}
      {extraLabel && facets.extras.length > 1 && <Select label={extraLabel} value={filters.extra} options={facets.extras} onChange={(v) => setFilter('extra', v)} />}
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

export function EmptyState({ q, inLabel, filtered, reset }: { q: string; inLabel: string; filtered: boolean; reset: () => void }) {
  return (
    <div class="empty">
      <p class="empty-title">{q ? <>No match for “{q}”{inLabel}.</> : 'Nothing matches these filters.'}</p>
      <p>Try the noun alone (<code>MgUser</code> instead of <code>Get-MgUser</code>), or fewer words.</p>
      {filtered && <button type="button" class="chip" onClick={reset}>Search every source</button>}
    </div>
  );
}

export function LoadFailed({ message }: { message: string }) {
  return (
    <div class="empty" role="alert">
      <p class="empty-title">The search index didn’t load.</p>
      <p>{message}. Check your connection, then reload the page.</p>
      <button type="button" class="chip" onClick={() => location.reload()}>Reload</button>
    </div>
  );
}

export function Intro({ onPick }: { onPick: (s: SourceId, q: string) => void }) {
  return (
    <div class="intro">
      <h2>Type a fragment. Get the command.</h2>
      <p class="intro-lede">
        {formatCount(TOTAL)} cmdlets from {SOURCES.length} Microsoft docs sets, searched in your browser. Pick a result for its syntax, parameters, examples and permissions.
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
            <dd>{formatCount(s.count)}{s.version ? <span> · v{s.version}</span> : null}</dd>
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
