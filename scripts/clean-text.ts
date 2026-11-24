// Text cleaning for prose from the docs, shared by the index build and its test.

/**
 * Prose from the docs as the reader should see it: line breaks the docs left as literal text
 * ("list:\\r- item") become spaces, whitespace collapses, HTML comments ("<!-- 10519922 -->") go,
 * and text that is only template placeholders ("{{ Fill in the Synopsis }}") or a stray markdown
 * heading ("## SYNTAX") counts as no text at all. A Windows or UNC path ("C:\\reports",
 * "\\\\server\\new") keeps its backslashes, even glued to an escape ("x\\nC:\\reports").
 */
export function cleanText(s: string): string {
  // Scanned left to right, a path is matched whole before its backslashes can be read as escapes.
  // A drive letter starts a path when no word character, or only an escape, comes before it, and a
  // name follows its backslash ("Note:\\nfoo" and "can be a:\\r- item" are no paths). An r or n
  // after a path's backslash with no letter or digit after it is an escape, not a folder name, so
  // "C:\\temp.\\r\\nNext" ends the path at "temp.". Outside paths, "\\r" is always an escape, and
  // "\\n" is one unless a letter comes before it and a lower-case letter after it: the docs write
  // the account format "domain\\name" that way, while their stray line breaks start a sentence.
  const pathOrEscape = /(?:(?:(?<!\w)|(?<=\\[rn]))[A-Za-z]:(?:\\(?![rn](?![A-Za-z0-9]))[\w.$][\w.$-]*)+|\\\\[\w.$-]+(?:\\(?![rn](?![A-Za-z0-9]))[\w.$][\w.$-]*)*)|\\r|(?:(?<![A-Za-z])|(?<=\\[rn]))\\n|\\n(?![a-z])/g;
  const t = s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(pathOrEscape, (m) => (/^\\[rn]$/.test(m) ? ' ' : m))
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:\{\{[^}]*\}\}\s*)+$/.test(t) || /^#+\s/.test(t) ? '' : t;
}
