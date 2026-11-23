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

export interface Param {
  name: string;
  type: string;
  required: boolean;
  positional: boolean;
  description?: string;
}

const COMMON = new Set([
  'Break', 'Headers', 'HttpPipelineAppend', 'HttpPipelinePrepend', 'Proxy', 'ProxyCredential',
  'ProxyUseDefaultCredentials', 'ResponseHeadersVariable', 'WhatIf', 'Confirm', 'DefaultProfile',
]);

/** Parse parameters out of one or more syntax blocks (param sets are separated by blank lines). */
export function parseParams(syntax: string): Param[] {
  const seen = new Map<string, Param>();
  for (const set of syntax.split(/\n\s*\n/)) {
    const body = set.replace(/\s+/g, ' ').replace(/\[<CommonParameters>\]/g, '');
    // Walk bracket depth so we know whether a parameter is optional.
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '[') { depth++; continue; }
      if (ch === ']') { depth = Math.max(0, depth - 1); continue; }
      if (ch !== '-' || (i > 0 && /[\w-]/.test(body[i - 1]))) continue;
      const m = /^-([A-Za-z]\w*)(\]?)(?:\s+<([^>]+)>)?/.exec(body.slice(i));
      if (!m) continue;
      const name = m[1];
      // "[-Name] <Type>" marks a positional parameter: the name itself is bracketed.
      const positional = body[i - 1] === '[' && m[2] === ']' && m[3] !== undefined;
      const required = positional ? depth <= 1 : depth === 0;
      const type = m[3] ?? 'Switch';
      const prev = seen.get(name);
      if (!prev) seen.set(name, { name, type, required, positional });
      else {
        prev.required = prev.required && required;
        if (prev.type === 'Switch' && type !== 'Switch') prev.type = type;
      }
      i += name.length; // keep scanning brackets after the name so depth stays right
    }
  }
  return [...seen.values()].sort((a, b) => Number(b.required) - Number(a.required) || Number(COMMON.has(a.name)) - Number(COMMON.has(b.name)));
}

export const isCommonParam = (n: string) => COMMON.has(n);
