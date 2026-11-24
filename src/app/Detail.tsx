import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, ExternalLink, Link2 } from 'lucide-preact';
import { loadModule, type SearchClient } from './client';
import { CopyIconButton, CopyTextButton } from './copy';
import { isCommonParam, parseSyntax, tokenize, withDocumented } from './powershell';
import { isWarnExtra, sourceOf, srcStyle } from './sources';
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
          {row.extra && <span class={'tag' + (isWarnExtra(src, row.extra) ? ' tag-warn' : '')}>{row.extra}</span>}
          {row.perms > 0 && <span class="tag">{row.perms} permission{row.perms === 1 ? '' : 's'}</span>}
        </div>
        <div class="detail-links">
          <a class="btn" href={learnUrl(row)} target="_blank" rel="noopener">Microsoft Learn <ExternalLink size={14} aria-hidden="true" /><span class="sr-only"> (opens in a new tab)</span></a>
          <CopyTextButton text={entryUrl(row.key)} label="Copy link" icon={<Link2 size={14} />} />
        </div>
      </div>

      <CmdletEntry row={row} />

      {related.length > 0 && (
        <section class="block">
          <h3>Same noun · {row.name.slice(row.name.indexOf('-') + 1)}</h3>
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

type EntryState = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ok'; cmdlet: CmdletDetail };

/** Loads the row's module file and renders its entry, or the loading / error state. */
function CmdletEntry({ row }: { row: Row }) {
  const [state, setState] = useState<EntryState>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    loadModule(row.source, row.file)
      .then((file: CmdletFile) => {
        // The build writes a row's file from the entries that hold its name, so a miss means the
        // index and the file come from different deploys: report it like any failed load.
        const cmdlet = file[row.name];
        if (!cmdlet) throw new Error(`no record for ${row.name}`);
        if (live) setState({ status: 'ok', cmdlet });
      })
      .catch((e) => live && setState({ status: 'failed', message: e.message }));
    return () => { live = false; };
  }, [row.key]);

  switch (state.status) {
    case 'loading': return <div class="detail-skel" aria-busy="true" aria-label="Loading details"><span /><span /><span /><span /></div>;
    case 'failed': return <p class="notice notice-error" role="alert">Couldn’t load details ({state.message}). Check your connection and pick the cmdlet again.</p>;
    case 'ok': return <CmdletBody c={state.cmdlet} />;
  }
}

function CmdletBody({ c }: { c: CmdletDetail }) {
  const { sets, params } = useMemo(() => {
    const syntax = parseSyntax(c.syntax);
    return { sets: syntax.sets, params: withDocumented(syntax.params, c.parameters) };
  }, [c]);
  const [showCommon, setShowCommon] = useState(false);
  const visible = showCommon ? params : params.filter((p) => !isCommonParam(p.name));
  const hidden = params.length - visible.length;
  const examples = c.examples;
  const perms = c.permissions;
  return (
    <>
      {c.description && <p class="detail-desc">{c.description}</p>}

      {sets.length > 0 && (
        <section class="block">
          <h3>Syntax{sets.length > 1 ? <span class="h-note"> · {sets.length} parameter sets</span> : null}</h3>
          {sets.map((groups, i) => <SyntaxBlock key={i} groups={groups} />)}
        </section>
      )}

      {visible.length > 0 && (
        <section class="block">
          <h3>Parameters</h3>
          <table class="params">
            <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col"><span class="sr-only">Required</span></th></tr></thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.name}>
                  <td><code class="t-param">-{p.name}</code>{p.description ? <p class="param-desc">{p.description}</p> : null}</td>
                  <td><code class="t-type">{breakable(p.type)}</code></td>
                  <td>{p.required ? <span class="tag tag-req">Required</span> : p.positional ? <span class="tag">Positional</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(hidden > 0 || showCommon) && (
            <button type="button" class="link-btn" aria-expanded={showCommon} onClick={() => setShowCommon((s) => !s)}>
              {showCommon ? 'Hide' : `Show ${hidden}`} pipeline and proxy parameters
            </button>
          )}
        </section>
      )}

      {perms.length > 0 && (
        <section class="block">
          <h3>Permissions <CopyIconButton text={perms.join(', ')} label="Copy all permissions" small /></h3>
          <ul class="perms">{perms.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
        </section>
      )}

      <section class="block">
        <h3>Examples</h3>
        {examples.length ? examples.map((x, i) => <CodeBlock key={i} src={x} />) : <p class="h-sub">The docs have no example for this cmdlet. Start from the syntax above.</p>}
      </section>
    </>
  );
}

const renderTokens = (s: string) => tokenize(s).map((t, i) => (t.t === 'txt' ? t.v : <span key={i} class={'t-' + t.t}>{t.v}</span>));

/** One parameter set: each top-level group is a non-wrapping unit, so lines only break between parameters. */
function SyntaxBlock({ groups }: { groups: string[] }) {
  const body = useMemo(() => groups.flatMap((g, i) => [i ? ' ' : '', <span key={i} class="sg">{renderTokens(g)}</span>]), [groups]);
  return <CodeFrame copy={groups.join(' ')} syntax>{body}</CodeFrame>;
}

function CodeBlock({ src }: { src: string }) {
  const body = useMemo(() => renderTokens(src), [src]);
  return <CodeFrame copy={src}>{body}</CodeFrame>;
}

function CodeFrame({ copy, syntax, children }: { copy: string; syntax?: boolean; children: ComponentChildren }) {
  return (
    <div class={'code' + (syntax ? ' code-syntax' : '')}>
      <pre><code>{children}</code></pre>
      <CopyIconButton text={copy} label="Copy code" small />
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

/** A category tag adds nothing when it repeats the module ("Groups" for Microsoft.Graph.Groups). */
const showsCategory = (row: Row) => !!row.category && row.category !== row.module && !row.module.endsWith('.' + row.category);

/** A module's own version, when it says more than its source's (Teams 8.1.0 under Exchange 3.9.2; each Az.* module). */
const showsModuleVersion = (row: Row, src: SourceMeta) => !!row.moduleVersion && row.moduleVersion !== src.version;

const learnUrl = (row: Row) => `https://learn.microsoft.com/powershell/module/${row.module.toLowerCase()}/${row.name.toLowerCase()}`;

