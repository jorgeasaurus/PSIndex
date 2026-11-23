import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Check, Copy, ExternalLink, Link2 } from 'lucide-preact';
import { loadDetail, type SearchClient } from './client';
import { sourceColor } from './colors';
import { isCommonParam, parseParams, tokenize, type Param } from './powershell';
import type { Row, SourceMeta } from './types';

interface Props {
  row: Row;
  sources: SourceMeta[];
  client?: SearchClient;
  onOpen: (r: Row) => void;
  onClose: () => void;
}

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; data: any };

export function Detail({ row, sources, client, onOpen, onClose }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [related, setRelated] = useState<Row[]>([]);
  const top = useRef<HTMLDivElement>(null);
  const src = sources.find((s) => s.id === row.source)!;

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    top.current?.scrollTo?.({ top: 0 });
    loadDetail(row.source, row.file)
      .then((d) => {
        if (!live) return;
        const entry = row.source === 'errors' ? d.errors?.[row.name] : d.cmdlets?.[row.name];
        setState(entry ? { status: 'ok', data: entry } : { status: 'error', message: 'This entry is in the index but its detail file has no record for it.' });
      })
      .catch((e) => live && setState({ status: 'error', message: `Couldn’t load details (${e.message}). Check your connection and pick the entry again.` }));
    client?.related(row.key).then((r) => live && setRelated(r));
    return () => { live = false; };
  }, [row.key]);

  const learn = learnUrl(row, src);

  return (
    <article class="detail" ref={top} style={{ '--src': sourceColor(row.source) } as any} aria-labelledby="detail-title">
      <div class="detail-head">
        <button type="button" class="icon-btn detail-back" onClick={onClose} aria-label="Back to results"><ArrowLeft size={18} /></button>
        <h2 id="detail-title" class="detail-title">
          <code>{row.name}</code>
          <CopyBtn text={row.name} label="Copy name" />
        </h2>
        <div class="tags">
          <span class="tag tag-source"><span class="source-dot" aria-hidden="true" />{src.short}</span>
          {row.source === 'errors' ? <span class="tag">{row.module}</span> : row.module && <span class="tag">{row.module}</span>}
          {row.verb && <span class="tag">{row.verb}</span>}
          {row.category && row.category !== row.module && !row.module.endsWith('.' + row.category) && <span class="tag">{row.category}</span>}
          {row.extra && <span class={'tag' + (row.extra === 'beta' ? ' tag-warn' : '')}>{row.extra}</span>}
          {row.perms > 0 && <span class="tag">{row.perms} permission{row.perms === 1 ? '' : 's'}</span>}
        </div>
        <div class="detail-links">
          {learn && <a class="btn" href={learn} target="_blank" rel="noopener">Microsoft Learn <ExternalLink size={14} /></a>}
          <CopyBtn text={shareUrl(row)} label="Copy link" icon={<Link2 size={14} />} text-label="Copy link" />
        </div>
      </div>

      {state.status === 'loading' && <div class="detail-skel" aria-busy="true" aria-label="Loading details"><span /><span /><span /><span /></div>}
      {state.status === 'error' && <p class="notice notice-error" role="alert">{state.message}</p>}
      {state.status === 'ok' && (row.source === 'errors' ? <ErrorBody e={state.data} row={row} /> : <CmdletBody c={state.data} row={row} />)}

      {related.length > 0 && (
        <section class="block">
          <h3>{row.source === 'errors' ? 'Nearby codes' : `Same noun · ${row.name.slice(row.name.indexOf('-') + 1)}`}</h3>
          <ul class="related">
            {related.map((r) => (
              <li key={r.key}><button type="button" onClick={() => onOpen(r)}><code>{r.name}</code></button></li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function CmdletBody({ c, row }: { c: any; row: Row }) {
  const syntax: string = c.syntax ?? '';
  const sets = useMemo(() => syntax.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean), [syntax]);
  const params: Param[] = useMemo(() => {
    const parsed = parseParams(syntax);
    if (Array.isArray(c.parameters) && c.parameters.length) {
      const byName = new Map(parsed.map((p) => [p.name, p]));
      return c.parameters.map((p: any) => ({
        name: p.name,
        type: p.type || byName.get(p.name)?.type || '',
        required: !!p.required,
        positional: byName.get(p.name)?.positional ?? false,
        description: p.description,
      }));
    }
    return parsed;
  }, [syntax]);
  const [showCommon, setShowCommon] = useState(false);
  const visible = showCommon ? params : params.filter((p) => !isCommonParam(p.name));
  const hidden = params.length - visible.length;
  const examples: string[] = (c.examples ?? []).filter((x: string) => x && x.trim());
  const perms: string[] = c.permissions ?? [];

  return (
    <>
      {(c.description || row.desc) && <p class="detail-desc">{c.description || row.desc}</p>}

      {sets.length > 0 && (
        <section class="block">
          <h3>Syntax{sets.length > 1 ? <span class="h-note"> · {sets.length} parameter sets</span> : null}</h3>
          {sets.map((s, i) => <Code key={i} src={s} view={reflowSyntax(s)} syntax />)}
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
          <h3>Permissions <CopyBtn text={perms.join(', ')} label="Copy all permissions" small /></h3>
          <ul class="perms">{perms.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
        </section>
      )}

      <section class="block">
        <h3>Examples</h3>
        {examples.length ? examples.map((x, i) => <Code key={i} src={x} />) : <p class="h-sub">The docs have no example for this cmdlet. Start from the syntax above.</p>}
      </section>
    </>
  );
}

function ErrorBody({ e, row }: { e: any; row: Row }) {
  return (
    <>
      {e.message && <p class="detail-desc detail-message">{e.message}</p>}
      {e.description && (
        <section class="block"><h3>Description</h3><p class="prose">{e.description}</p></section>
      )}
      <section class="block">
        <h3>Resolution</h3>
        {e.resolution ? <p class="prose">{e.resolution}</p> : <p class="h-sub">Microsoft’s docs list no resolution for this code. Search Microsoft Learn for <code>{row.name}</code>.</p>}
      </section>
      {e.source_file && (
        <section class="block"><h3>Source</h3><p class="h-sub"><code>{e.source_file}</code></p></section>
      )}
    </>
  );
}

/** One line per set, with no-break spaces inside each [...] group so a parameter wraps as a unit. */
function reflowSyntax(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  let depth = 0, out = '';
  for (const ch of flat) {
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    out += ch === ' ' && depth > 0 ? '\u00a0' : ch;
  }
  return out;
}

const renderToks = (s: string) => tokenize(s).map((t, i) => (t.t === 'txt' ? t.v : <span key={i} class={'t-' + t.t}>{t.v}</span>));

function Code({ src, view, syntax }: { src: string; view?: string; syntax?: boolean }) {
  const body = useMemo(() => {
    if (!syntax) return renderToks(src);
    // Each depth-0 group ("[-Name <Type>]") is a non-wrapping unit; breaks only fall between groups.
    const groups = (view ?? src).split(' ');
    return groups.flatMap((g, i) => [i ? ' ' : '', <span key={i} class="sg">{renderToks(g.replace(/\u00a0/g, ' '))}</span>]);
  }, [src, view, syntax]);
  return (
    <div class={'code' + (syntax ? ' code-syntax' : '')}>
      <pre><code>{body}</code></pre>
      <CopyBtn text={src} label="Copy code" small />
    </div>
  );
}

function CopyBtn({ text, label, small, icon, ...rest }: { text: string; label: string; small?: boolean; icon?: any; 'text-label'?: string }) {
  const [done, setDone] = useState(false);
  const textLabel = rest['text-label'];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    } catch {
      /* clipboard blocked: leave state unchanged */
    }
  };
  if (textLabel) {
    return <button type="button" class="btn btn-quiet" onClick={copy}>{done ? <Check size={14} /> : icon} {done ? 'Copied' : textLabel}</button>;
  }
  return (
    <button type="button" class={'icon-btn copy' + (small ? ' copy-sm' : '') + (done ? ' is-done' : '')} onClick={copy} aria-label={done ? 'Copied' : label} title={label}>
      {done ? <Check size={small ? 14 : 16} /> : <Copy size={small ? 14 : 16} />}
    </button>
  );
}

function learnUrl(row: Row, src: SourceMeta): string {
  if (src.kind === 'error') return '';
  if (src.learn === 'configurationmanager') return `https://learn.microsoft.com/powershell/module/configurationmanager/${row.name.toLowerCase()}`;
  if (!row.module) return '';
  return `https://learn.microsoft.com/powershell/module/${row.module.toLowerCase()}/${row.name.toLowerCase()}`;
}

function shareUrl(row: Row) {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('c', row.key);
  return u.toString();
}
