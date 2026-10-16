/**
 * Fail-closed admission for the scalar-only Oreslang -> wasm32 bridge.
 * No import closure, manifest authority, package alias resolver, or pinned
 * module graph is available yet. Do not let a permissive/stub compiler emit
 * an unrelated scalar module from a source that requests imports.
 *
 * Scan source tokens, not substrings: skip quoted text, line comments and
 * nested block comments. Malformed UTF-8/comments/strings also fail closed.
 */
export function assertImportFreeSource(bytes) {
  const source = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  let i = 0;
  const identStart = c => /[A-Za-z_]/.test(c);
  const identPart = c => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    if (source.startsWith("//", i)) {
      i = source.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw Error("unterminated Oreslang block comment");
      continue;
    }
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i++];
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          if (i > source.length) throw Error("unterminated Oreslang string escape");
          continue;
        }
        if (source[i++] === quote) { closed = true; break; }
      }
      if (!closed) throw Error("unterminated Oreslang quoted literal");
      continue;
    }
    if (identStart(source[i])) {
      const start = i++;
      while (i < source.length && identPart(source[i])) i++;
      if (source.slice(start, i) === "import") {
        throw Error("Oreslang source imports require a verified native import graph; unsupported by the scalar Wasm bridge");
      }
      continue;
    }
    i++;
  }
}
