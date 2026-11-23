import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, ExternalLink, Link2 } from 'lucide-preact';
import { loadModule, type SearchClient } from './client';
import { CopyIconButton, CopyTextButton } from './copy';
import { isCommonParam, parseParams, tokenize, type Param } from './powershell';
import { isWarnExtra, sourceOf, srcStyle } from './sources';
import type { CmdletDetail, CmdletFile, Row, SourceMeta } from './types';

interface Props {
  row: Row;
  client: SearchClient;
  onOpen: (r: Row) => void;
  onClose: () => void;
}

export function Detail({ row, client, onOpen, onClose }: Props) {
  const [related, setRelated] = useState<Row[]>([]);
  const top = useRef<HTMLElement>(null);
  const src = sourceOf(row.source);

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
          {row.extra && <span class={'tag' + (isWarnExtra(src, row.extra) ? ' tag-warn' : '')}>{row.extra}</span>}
          {row.perms > 0 && <span class="tag">{row.perms} permission{row.perms === 1 ? '' : 's'}</span>}
        </div>
        <div class="detail-links">
          {learn && <a class="btn" href={learn} target="_blank" rel="noopener">Microsoft Learn <ExternalLink size={14} /></a>}
          <CopyTextButton text={shareUrl(row)} label="Copy link" icon={<Link2 size={14} />} />
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

type EntryState = { status: 'loading' } | { status: 'missing' } | { status: 'failed'; message: string } | { status: 'ok'; cmdlet: CmdletDetail };

/** Loads the row's module file and renders its entry, or the loading / error state. */
function CmdletEntry({ row }: { row: Row }) {
  const [state, setState] = useState<EntryState>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loadModule(row.source, row.file)
      .then((file: CmdletFile) => {
        const cmdlet = file.cmdlets[row.name];
        if (live) setState(cmdlet ? { status: 'ok', cmdlet } : { status: 'missing' });
      })
      .catch((e) => live && setState({ status: 'failed', message: e.message }));
    return () => { live = false; };
  }, [row.key]);

  switch (state.status) {
    case 'loading': return <div class="detail-skel" aria-busy="true" aria-label="Loading details"><span /><span /><span /><span /></div>;
    case 'missing': return <p class="notice notice-error" role="alert">This cmdlet is in the index but its module file has no record for it.</p>;
    case 'failed': return <p class="notice notice-error" role="alert">Couldn’t load details ({state.message}). Check your connection and pick the cmdlet again.</p>;
    case 'ok': return <CmdletBody c={state.cmdlet} row={row} />;
  }
}

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
