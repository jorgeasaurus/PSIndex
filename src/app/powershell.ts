// Tiny PowerShell tokenizer for syntax blocks and examples. Returns tokens; the UI renders them.
export type Tok = { t: 'cmd' | 'param' | 'type' | 'var' | 'str' | 'com' | 'op' | 'num' | 'txt'; v: string };

const RE = new RegExp(
  [
    String.raw`(?<com>#[^\n]*)`,
    String.raw`(?<str>"(?:[^"\\\x60]|[\\\x60].)*"|'(?:[^']|'')*')`,
    String.raw`(?<var>\$(?:\{[^}]*\}|[\w:]+))`,
    String.raw`(?<cmd>\b[A-Z][a-z]+-[A-Za-z0-9]+\b)`,
    String.raw`(?<param>(?<![\w-])-[A-Za-z][\w]*)`,
    String.raw`(?<type><[^<>\n]+>|\[[A-Za-z][\w.\[\]]*\](?=\s*[\$(\w]|$))`,
    String.raw`(?<num>\b\d+(?:\.\d+)?\b)`,
    String.raw`(?<op>[|{}()=;@,])`,
  ].join('|'),
  'g',
);

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  for (const m of src.matchAll(RE)) {
    if (m.index! > last) out.push({ t: 'txt', v: src.slice(last, m.index) });
    const g = m.groups!;
    const t = (Object.keys(g).find((k) => g[k] !== undefined) ?? 'txt') as Tok['t'];
    out.push({ t, v: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push({ t: 'txt', v: src.slice(last) });
  return out;
}

import type { DocumentedParam } from './types';

export interface Param extends DocumentedParam {
  positional: boolean;
}

export interface Syntax {
  /** Each parameter set as its top-level groups ("Get-X", "-Name <T>", "[-Opt <T>]", "[-Switch]"). */
  sets: string[][];
  /** Parameters across all sets, required first, pipeline/proxy plumbing last. */
  params: Param[];
}

const COMMON = new Set([
  'Break', 'Headers', 'HttpPipelineAppend', 'HttpPipelinePrepend', 'Proxy', 'ProxyCredential',
  'ProxyUseDefaultCredentials', 'ResponseHeadersVariable', 'WhatIf', 'Confirm', 'DefaultProfile',
]);

export const isCommonParam = (n: string) => COMMON.has(n);

/**
 * Split one parameter set into top-level groups: whitespace only separates groups outside
 * [...] and <...>. A bare <Type> joins the group before it ("-Name <T>", "[-Identity] <T>").
 * A "]" that closes a bracket opened before an unclosed "<" ends it too (some docs write
 * "[-Status <StatusEnum]"); "]" inside a type ("<String[]>") does not.
 */
function groupsOf(set: string): string[] {
  const groups: string[] = [];
  let brackets = 0, angleAt = -1, cur = ''; // angleAt: bracket depth where the open "<" started
  const flush = () => {
    if (!cur) return;
    if (cur.startsWith('<') && groups.length) groups[groups.length - 1] += ' ' + cur;
    else groups.push(cur);
    cur = '';
  };
  for (const ch of set.replace(/\s+/g, ' ').trim()) {
    if (ch === ' ' && !brackets && angleAt < 0) { flush(); continue; }
    if (ch === '<') angleAt = brackets;
    else if (ch === '>') angleAt = -1;
    else if (ch === '[') brackets++;
    else if (ch === ']') {
      brackets = Math.max(0, brackets - 1);
      if (brackets < angleAt) angleAt = -1;
    }
    cur += ch;
  }
  flush();
  return groups;
}

/**
 * The parameters a group declares: usually one, but some docs pack several into one bracket
 * or omit the space between groups. A group is optional when bracketed as a whole;
 * "[-Name] <T>" is positional.
 */
function paramsOf(group: string): Param[] {
  // Type: a closed "<T>" (which may contain "[]"), else an unclosed "<T" up to the next "]".
  return [...group.matchAll(/(^|[[ ])-([A-Za-z]\w*)(\]?)(?: <(?:([^<>]+)>|([^<>\]]+)))?/g)].map((m) => {
    const type = m[4] ?? m[5];
    const positional = m[1] === '[' && m[3] === ']' && type !== undefined;
    const optional = group.startsWith('[') && !(positional && group.startsWith('[-'));
    return { name: m[2], type: type ?? 'Switch', required: !optional, positional };
  });
}

export function parseSyntax(syntax: string): Syntax {
  const sets = syntax.split(/\n\s*\n/).map((s) => groupsOf(s)).filter((g) => g.length);
  const seen = new Map<string, Param>();
  for (const p of sets.flat().flatMap(paramsOf)) {
    const prev = seen.get(p.name);
    if (!prev) seen.set(p.name, p);
    else {
      prev.required &&= p.required; // required only if every set requires it
      if (prev.type === 'Switch') prev.type = p.type;
    }
  }
  const params = [...seen.values()].sort((a, b) => Number(b.required) - Number(a.required) || Number(COMMON.has(a.name)) - Number(COMMON.has(b.name)));
  return { sets, params };
}

/** Parameters some pipelines document (MECM) take precedence; the syntax fills in type and position. */
export function withDocumented(parsed: Param[], documented: DocumentedParam[]): Param[] {
  if (!documented.length) return parsed;
  const byName = new Map(parsed.map((p) => [p.name, p]));
  return documented.map((p) => ({
    name: p.name,
    type: p.type || byName.get(p.name)?.type || '',
    required: p.required,
    positional: byName.get(p.name)?.positional ?? false,
    description: p.description,
  }));
}
