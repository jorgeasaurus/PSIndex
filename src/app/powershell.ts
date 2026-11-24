// Tiny PowerShell tokenizer for syntax blocks and examples. Returns tokens; the UI renders them.
// Token kinds and their patterns, in match order. The kinds become CSS classes (`t-<kind>`, Detail.tsx).
const PATTERNS = {
  // A block comment (<# ... #>) or a line comment.
  com: String.raw`<#[\s\S]*?#>|#[^\n]*`,
  // Here-strings (@" ... "@ on lines of their own) hold quotes freely, so they come first.
  // PowerShell escapes with a backtick or a doubled quote; a backslash is an ordinary character ("C:\Temp\").
  str: String.raw`@"[ \t]*\r?\n[\s\S]*?\r?\n"@|@'[ \t]*\r?\n[\s\S]*?\r?\n'@|"(?:[^"\x60]|\x60.|"")*"|'(?:[^']|'')*'`,
  var: String.raw`\$(?:\{[^}]*\}|[\w:]+)`,
  cmd: String.raw`\b[A-Z][a-z]+-[A-Za-z0-9]+\b`,
  param: String.raw`(?<![\w-])-[A-Za-z][\w]*`,
  type: String.raw`<[^<>\n]+>|\[[A-Za-z][\w.\[\]]*\](?=\s*[\$(\w]|$)`,
  num: String.raw`\b\d+(?:\.\d+)?\b`,
  op: String.raw`[|{}()=;@,]`,
} as const;
type Kind = keyof typeof PATTERNS;
/** Object.keys loses the key type; these are exactly PATTERNS' keys. */
const KINDS = Object.keys(PATTERNS) as Kind[];
export type Tok = { t: Kind | 'txt'; v: string };

const RE = new RegExp(KINDS.map((k) => `(?<${k}>${PATTERNS[k]})`).join('|'), 'g');

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  for (const m of src.matchAll(RE)) {
    if (m.index! > last) out.push({ t: 'txt', v: src.slice(last, m.index) });
    // Every match is exactly one top-level group.
    out.push({ t: KINDS.find((k) => m.groups![k] !== undefined)!, v: m[0] });
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
    return { name: m[2], type: type ?? 'Switch', required: !optional, positional, description: '' };
  });
}

/**
 * The parameter sets in a SYNTAX block: each starts on a line beginning with the cmdlet's name
 * (the block's first word). Blank lines inside one set (docs that wrap a long set) don't split it.
 */
function setsOf(syntax: string): string[] {
  const name = syntax.trim().split(/\s/, 1)[0];
  if (!name) return [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return syntax.split(new RegExp(`^(?=\\s*${escaped}(?:\\s|$))`, 'm'));
}

export function parseSyntax(syntax: string): Syntax {
  const sets = setsOf(syntax).map(groupsOf).filter((g) => g.length);
  // A parameter is required only if every set has it and every set requires it.
  const seen = new Map<string, Param & { sets: number }>();
  for (const set of sets) {
    for (const p of set.flatMap(paramsOf)) {
      const prev = seen.get(p.name);
      if (!prev) { seen.set(p.name, { ...p, sets: 1 }); continue; }
      prev.required &&= p.required;
      prev.sets++;
      if (prev.type === 'Switch') prev.type = p.type;
    }
  }
  const params = [...seen.values()]
    .map(({ sets: n, ...p }) => ({ ...p, required: p.required && n === sets.length }))
    .sort((a, b) => Number(b.required) - Number(a.required) || Number(COMMON.has(a.name)) - Number(COMMON.has(b.name)));
  return { sets, params };
}

/**
 * Parameters some pipelines document (MECM) take precedence for their order and descriptions.
 * Type, position and "required" come from the syntax alone: the docs' own Required flag is per
 * parameter set, so it would mark a parameter of one set as always required. A parameter the
 * syntax doesn't show is not known to be required anywhere.
 */
export function withDocumented(parsed: Param[], documented: DocumentedParam[]): Param[] {
  if (!documented.length) return parsed;
  const byName = new Map(parsed.map((p) => [p.name, p]));
  return documented.map((p) => ({
    name: p.name,
    type: p.type || byName.get(p.name)?.type || '',
    required: byName.get(p.name)?.required ?? false,
    positional: byName.get(p.name)?.positional ?? false,
    description: p.description,
  }));
}
