import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, ExternalLink, Link2 } from 'lucide-preact';
import { loadModule, type SearchClient } from './client';
import { CopyIconButton, CopyTextButton } from './copy';
import { isCommonParam, parseSyntax, tokenize, withDocumented } from './powershell';
import { AssetError, isWarnExtra, sourceOf, srcStyle } from './sources';
import { entryUrl } from './url';
import type { CmdletDetail, CmdletFile, Row, SourceMeta } from './types';

interface Props {
  row: Row;
  client: SearchClient;
  onOpen: (r: Row) => void;
  onClose: () => void;
  /** Move focus to the entry's title when it opens (the narrow-screen dialog). */
  takeFocus: boolean;
}

export function Detail({ row, client, onOpen, onClose, takeFocus }: Props) {
  const [related, setRelated] = useState<Row[]>([]);
  const src = sourceOf(row.source);
  const title = useRef<HTMLHeadingElement>(null);

  // Focus the title when the entry is a dialog, or when the control that opened it is gone
  // (a "Same noun" button belongs to the entry it replaces): focus would otherwise drop to <body>.
  useEffect(() => {
    if (takeFocus || document.activeElement === document.body) title.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    let live = true;
    client.request('related', { key: row.key }).then((r) => live && setRelated(r));
    return () => { live = false; };
  }, [row.key]);

  return (
    <article class="detail" style={srcStyle(row.source)} aria-labelledby="detail-title">
      <div class="detail-head">
        <button type="button" class="icon-btn detail-back" onClick={onClose} aria-label="Back to results"><ArrowLeft size={18} /></button>
        <div class="detail-title-row">
          <h2 id="detail-title" class="detail-title" tabIndex={-1} ref={title}><code>{breakable(row.name)}</code></h2>
          <CopyIconButton text={row.name} label="Copy name" />
        </div>
        <div class="tags">
          <span class="tag tag-source"><span class="source-dot" aria-hidden="true" />{src.short}</span>
          <span class="tag">{row.module}</span>
          {showsModuleVersion(row, src) && <span class="tag" title="Module version">v{row.moduleVersion}</span>}
          {row.verb && <span class="tag">{row.verb}</span>}
          {showsCategory(row) && <span class="tag">{row.category}</span>}
          {row.extra && src.extra && <span class={'tag' + (isWarnExtra(src, row.extra) ? ' tag-warn' : '')}>{src.extra.label} {row.extra}</span>}
          {row.perms > 0 && <span class="tag">{row.perms} permission{row.perms === 1 ? '' : 's'}</span>}
        </div>
        <div class="detail-links">
          <a class="btn" href={learnUrl(row)} target="_blank" rel="noopener">Microsoft Learn <ExternalLink size={14} aria-hidden="true" /><span class="sr-only"> (opens in a new tab)</span></a>
          <CopyTextButton text={entryUrl(row.key)} label="Copy link" icon={<Link2 size={14} />} />
        </div>
      </div>

      <CmdletEntry row={row} onRetry={() => title.current?.focus({ preventScroll: true })} />

      {related.length > 0 && (
        <section class="block">
          {/* One flex item, so the noun's <wbr>s wrap it instead of each piece becoming an item. */}
          <h3><span>Same noun · {breakable(row.name.slice(row.name.indexOf('-') + 1))}</span></h3>
          <ul class="related">
            {related.map((r) => (
              <li key={r.key}>
                <button type="button" onClick={() => onOpen(r)}>
                  <code>{r.name}</code>{r.dup ? <span class="related-mod"> · {r.module}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

type EntryState = { status: 'loading' } | { status: 'failed'; error: AssetError } | { status: 'ok'; cmdlet: CmdletDetail };

/**
 * Loads the row's module file and renders its entry, or the loading / error state. `onRetry` keeps
 * focus in the entry when "Try again" is pressed (the button itself goes away while loading).
 */
function CmdletEntry({ row, onRetry }: { row: Row; onRetry: () => void }) {
  const [state, setState] = useState<EntryState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0); // "Try again" loads the file afresh (failures aren't cached)
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loadModule(row.source, row.file)
      .then((file: CmdletFile) => {
        // The build writes each row's file from the entries that hold its name, so a miss is a broken file.
        const cmdlet = file[row.name];
        if (!cmdlet) throw new AssetError('The server sent a damaged file.', 'reload');
        if (live) setState({ status: 'ok', cmdlet });
      })
      .catch((e: AssetError) => live && setState({ status: 'failed', error: e }));
    return () => { live = false; };
  }, [row.key, attempt]);

  switch (state.status) {
    case 'loading': return <div class="detail-skel" role="status"><span class="sr-only">Loading details</span><i /><i /><i /><i /></div>;
    case 'failed': return (
      <div class="notice notice-error" role="alert">
        <p>Couldn’t load the details. {state.error.message}</p>
        {state.error.fix === 'reload'
          ? <button type="button" class="chip" onClick={() => location.reload()}>Reload</button>
          : <button type="button" class="chip" onClick={() => { onRetry(); setAttempt((a) => a + 1); }}>Try again</button>}
      </div>
    );
    case 'ok': return <CmdletBody c={state.cmdlet} />;
  }
}

function CmdletBody({ c }: { c: CmdletDetail }) {
  const { sets, params } = useMemo(() => {
    const syntax = parseSyntax(c.syntax);
    return { sets: syntax.sets, params: withDocumented(syntax.params, c.parameters) };
  }, [c]);
  const [showCommon, setShowCommon] = useState(false);
  const common = params.filter((p) => isCommonParam(p.name));
  const visible = showCommon ? params : params.filter((p) => !isCommonParam(p.name));
  const examples = c.examples;
  const perms = c.permissions;
  return (
    <>
      {c.description && <p class="detail-desc">{c.description}</p>}

      {sets.length > 0 && (
        <section class="block">
          <h3>Syntax{sets.length > 1 ? <span class="h-note"> · {sets.length} parameter sets</span> : null}</h3>
          {sets.map((groups, i) => <SyntaxBlock key={i} groups={groups} label={sets.length > 1 ? `Copy parameter set ${i + 1}` : 'Copy syntax'} />)}
        </section>
      )}

      {params.length > 0 && (
        <section class="block">
          <h3>Parameters</h3>
          {visible.length > 0 && <table class="params">
            <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col"><span class="sr-only">Required or positional</span></th></tr></thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.name}>
                  <td><code class="t-param">{paramName(p.name)}</code>{p.description ? <p class="param-desc">{p.description}</p> : null}</td>
                  <td><code class="t-type">{breakable(p.type)}</code></td>
                  <td>{p.required ? <span class="tag tag-req">Required</span> : p.positional ? <span class="tag">Positional</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>}
          {common.length > 0 && (
            // Named, so an admin looking for -WhatIf knows it is here.
            <button type="button" class="link-btn" aria-expanded={showCommon} onClick={() => setShowCommon((s) => !s)}>
              {showCommon ? 'Hide' : 'Show'} {common.length} common parameter{common.length === 1 ? '' : 's'} ({common.map((p) => '-' + p.name).join(', ')})
            </button>
          )}
        </section>
      )}

      {perms.length > 0 && (
        <section class="block">
          {/* The copy button sits beside the heading, not in it: heading navigation reads just "Permissions". */}
          <div class="block-head"><h3>Permissions</h3><CopyIconButton text={perms.join(', ')} label="Copy all permissions" small /></div>
          <ul class="perms">{perms.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
        </section>
      )}

      <section class="block">
        <h3>Examples</h3>
        {examples.length ? examples.map((x, i) => <CodeBlock key={i} src={x} label={`Copy example ${i + 1}`} />) : <p class="h-sub">The docs have no example for this cmdlet. Start from the syntax above.</p>}
      </section>
    </>
  );
}

/** Names and types get word-boundary breaks, so a long one wraps readably when it must. */
const renderTokens = (s: string) => tokenize(s).map((t, i) => (
  t.t === 'txt' ? t.v
    : <span key={i} class={'t-' + t.t}>{t.t === 'param' ? paramName(t.v.slice(1)) : t.t === 'cmd' || t.t === 'type' ? breakable(t.v) : t.v}</span>
));

/**
 * One parameter set. Each top-level group moves to the next line whole when it fits there, and
 * wraps between its words only when it is wider than the box (global.css .sg).
 */
function SyntaxBlock({ groups, label }: { groups: string[]; label: string }) {
  const body = useMemo(() => groups.flatMap((g, i) => [i ? ' ' : '', <span key={i} class="sg">{renderTokens(g)}</span>]), [groups]);
  return <CodeFrame copy={groups.join(' ')} label={label} syntax>{body}</CodeFrame>;
}

function CodeBlock({ src, label }: { src: string; label: string }) {
  const body = useMemo(() => renderTokens(src), [src]);
  return <CodeFrame copy={src} label={label}>{body}</CodeFrame>;
}

/** `label` names the copy button apart from the page's others ("Copy example 2"). */
function CodeFrame({ copy, label, syntax, children }: { copy: string; label: string; syntax?: boolean; children: ComponentChildren }) {
  return (
    <div class={'code' + (syntax ? ' code-syntax' : '')}>
      <pre><code>{children}</code></pre>
      <CopyIconButton text={copy} label={label} small />
    </div>
  );
}

/**
 * Text with line-break opportunities at word boundaries: after "-" and ".", and before each
 * capital that starts a word (camel case). Long names then wrap at a readable point, not mid-word.
 */
function breakable(s: string) {
  const parts = s.split(/(?<=[-.])|(?<=[a-z0-9])(?=[A-Z])/);
  return parts.flatMap((p, i) => (i ? [<wbr key={i} />, p] : [p]));
}

/**
 * "-Name" breakable like other names, with the "-" held to the first word: a browser may break
 * after a hyphen, which would leave "-" (or "[-") at a line end, apart from its name.
 */
function paramName(name: string) {
  const [first, ...rest] = breakable(name);
  return [<span key="h" class="nb">-{first}</span>, ...rest];
}

/**
 * A category tag adds nothing when the module name already says it ("Groups" for Microsoft.Graph.Groups,
 * "Teams" for MicrosoftTeams), or when it is a catch-all ("Other", "General", "Exchange General").
 */
const FILLER_CATEGORY = /^(other|(.+\s)?general)$/i;
const showsCategory = (row: Row) => !!row.category && !FILLER_CATEGORY.test(row.category)
  && !row.module.toLowerCase().includes(row.category.toLowerCase().replace(/\s+/g, ''));

/** A module's own version, when it says more than its source's (Teams 8.1.0 under Exchange 3.9.2; each Az.* module). */
const showsModuleVersion = (row: Row, src: SourceMeta) => !!row.moduleVersion && row.moduleVersion !== src.version;

const learnUrl = (row: Row) => `https://learn.microsoft.com/powershell/module/${row.module.toLowerCase()}/${row.name.toLowerCase()}`;

