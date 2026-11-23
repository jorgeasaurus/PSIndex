import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, ExternalLink, Link2 } from 'lucide-preact';
import { loadDetail, type SearchClient } from './client';
import { CopyIconButton, CopyTextButton } from './copy';
import { isCommonParam, parseParams, tokenize, type Param } from './powershell';
import { KINDS, sourceMeta, srcStyle } from './sources';
import type { CmdletDetail, CmdletFile, ErrorDetail, ErrorFile, Row, SourceKind, SourceMeta } from './types';

interface Props {
  row: Row;
  client: SearchClient;
  onOpen: (r: Row) => void;
  onClose: () => void;
}

export function Detail({ row, client, onOpen, onClose }: Props) {
  const [related, setRelated] = useState<Row[]>([]);
  const top = useRef<HTMLElement>(null);
  const src = sourceMeta(row.source)!; // rows only come from the worker, which only knows SOURCES
  const Body = BODIES[src.kind];

  useEffect(() => {
    let live = true;
    top.current?.scrollTo?.({ top: 0 });
    setRelated([]);
    client.request('related', { key: row.key }).then((r) => live && setRelated(r));
    return () => { live = false; };
  }, [row.key]);

  const learn = learnUrl(row, src);

  return (
    <article class="detail" ref={top} style={srcStyle(row.source)} aria-labelledby="detail-title">
      <div class="detail-head">
        <button type="button" class="icon-btn detail-back" onClick={onClose} aria-label="Back to results"><ArrowLeft size={18} /></button>
        <h2 id="detail-title" class="detail-title">
          <code>{row.name}</code>
          <CopyIconButton text={row.name} label="Copy name" />
        </h2>
        <div class="tags">
          <span class="tag tag-source"><span class="source-dot" aria-hidden="true" />{src.short}</span>
          {row.module && <span class="tag">{row.module}</span>}
          {row.verb && <span class="tag">{row.verb}</span>}
          {row.category && row.category !== row.module && !row.module.endsWith('.' + row.category) && <span class="tag">{row.category}</span>}
          {row.extra && <span class={'tag' + (row.extra === 'beta' ? ' tag-warn' : '')}>{row.extra}</span>}
          {row.perms > 0 && <span class="tag">{row.perms} permission{row.perms === 1 ? '' : 's'}</span>}
        </div>
        <div class="detail-links">
          {learn && <a class="btn" href={learn} target="_blank" rel="noopener">Microsoft Learn <ExternalLink size={14} /></a>}
          <CopyTextButton text={shareUrl(row)} label="Copy link" icon={<Link2 size={14} />} />
        </div>
      </div>

      <Body row={row} />

      {related.length > 0 && (
        <section class="block">
          <h3>{KINDS[src.kind].relatedTitle(row.name)}</h3>
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

type EntryState<E> = { status: 'loading' } | { status: 'missing' } | { status: 'failed'; message: string } | { status: 'ok'; entry: E };

/** Loads the detail file for `row`, picks the row's entry out of it, and renders loading / error states. */
function Entry<F, E>({ row, pick, render }: { row: Row; pick: (file: F) => E | undefined; render: (entry: E) => ComponentChildren }) {
  const [state, setState] = useState<EntryState<E>>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loadDetail<F>(row.source, row.file)
      .then((file) => {
        const entry = pick(file);
        if (live) setState(entry ? { status: 'ok', entry } : { status: 'missing' });
      })
      .catch((e) => live && setState({ status: 'failed', message: e.message }));
    return () => { live = false; };
  }, [row.key]);

  switch (state.status) {
    case 'loading': return <div class="detail-skel" aria-busy="true" aria-label="Loading details"><span /><span /><span /><span /></div>;
    case 'missing': return <p class="notice notice-error" role="alert">This entry is in the index but its detail file has no record for it.</p>;
    case 'failed': return <p class="notice notice-error" role="alert">Couldn’t load details ({state.message}). Check your connection and pick the entry again.</p>;
    case 'ok': return <>{render(state.entry)}</>;
  }
}

const BODIES: Record<SourceKind, (p: { row: Row }) => ComponentChildren> = {
  cmdlet: ({ row }) => <Entry<CmdletFile, CmdletDetail> row={row} pick={(f) => f.cmdlets[row.name]} render={(c) => <CmdletBody c={c} row={row} />} />,
  error: ({ row }) => <Entry<ErrorFile, ErrorDetail> row={row} pick={(f) => f.errors[row.name]} render={(e) => <ErrorBody e={e} name={row.name} />} />,
};

/** Pipelines that document parameters (MECM) win; otherwise parameters are parsed from the syntax. */
function paramsOf(c: CmdletDetail): Param[] {
  const parsed = parseParams(c.syntax ?? '');
  if (!c.parameters?.length) return parsed;
  const byName = new Map(parsed.map((p) => [p.name, p]));
  return c.parameters.map((p) => ({
    name: p.name,
    type: p.type || byName.get(p.name)?.type || '',
    required: p.required,
    positional: byName.get(p.name)?.positional ?? false,
    description: p.description,
  }));
}

function CmdletBody({ c, row }: { c: CmdletDetail; row: Row }) {
  const sets = useMemo(() => (c.syntax ?? '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean), [c]);
  const params = useMemo(() => paramsOf(c), [c]);
  const [showCommon, setShowCommon] = useState(false);
  const visible = showCommon ? params : params.filter((p) => !isCommonParam(p.name));
  const hidden = params.length - visible.length;
  const examples = (c.examples ?? []).filter((x) => x.trim());
  const perms = c.permissions ?? [];
  const description = c.description || row.desc;

  return (
    <>
      {description && <p class="detail-desc">{description}</p>}

      {sets.length > 0 && (
        <section class="block">
          <h3>Syntax{sets.length > 1 ? <span class="h-note"> · {sets.length} parameter sets</span> : null}</h3>
          {sets.map((s, i) => <SyntaxBlock key={i} src={s} />)}
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
                  <td><code class="t-type">{p.type}</code></td>
                  <td>{p.required ? <span class="tag tag-req">Required</span> : p.positional ? <span class="tag">Positional</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hidden > 0 && <button type="button" class="link-btn" onClick={() => setShowCommon(true)}>Show {hidden} pipeline and proxy parameters</button>}
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

function ErrorBody({ e, name }: { e: ErrorDetail; name: string }) {
  return (
    <>
      {e.message && <p class="detail-desc detail-message">{e.message}</p>}
      {e.description && (
        <section class="block"><h3>Description</h3><p class="prose">{e.description}</p></section>
      )}
      <section class="block">
        <h3>Resolution</h3>
        {e.resolution ? <p class="prose">{e.resolution}</p> : <p class="h-sub">Microsoft’s docs list no resolution for this code. Search Microsoft Learn for <code>{name}</code>.</p>}
      </section>
      {e.source_file && (
        <section class="block"><h3>Source</h3><p class="h-sub"><code>{e.source_file}</code></p></section>
      )}
    </>
  );
}

const renderTokens = (s: string) => tokenize(s).map((t, i) => (t.t === 'txt' ? t.v : <span key={i} class={'t-' + t.t}>{t.v}</span>));

/**
 * A syntax set as one wrapping line where each top-level group ("Cmd", "[-Name <Type>]") is a
 * non-wrapping unit, so lines only break between parameters.
 */
function syntaxGroups(s: string): string[] {
  const groups: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s.replace(/\s+/g, ' ').trim()) {
    if (ch === ' ' && depth === 0) { groups.push(cur); cur = ''; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    cur += ch;
  }
  return cur ? [...groups, cur] : groups;
}

function SyntaxBlock({ src }: { src: string }) {
  const body = useMemo(() => syntaxGroups(src).flatMap((g, i) => [i ? ' ' : '', <span key={i} class="sg">{renderTokens(g)}</span>]), [src]);
  return <CodeFrame copy={src} syntax>{body}</CodeFrame>;
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

function learnUrl(row: Row, src: SourceMeta): string {
  if (!src.learn || (src.learn.includes('{module}') && !row.module)) return '';
  return src.learn.replace('{module}', row.module.toLowerCase()).replace('{name}', row.name.toLowerCase());
}

function shareUrl(row: Row) {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('c', row.key);
  return u.toString();
}
