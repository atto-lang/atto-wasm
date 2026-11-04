/**
 * Fail-closed admission for the scalar-only Oreslang -> wasm32 bridge.
 * No import closure, manifest authority, package alias resolver, or pinned
 * module graph is available yet. Do not let a permissive/stub compiler emit
 * an unrelated scalar module from a source that requests imports.
 *
 * Scan source tokens, not substrings: skip quoted text, line comments and
 * nested block comments. Malformed UTF-8/comments/strings also fail closed.
 */
// Inspect typed array internal slots: .buffer may be shadowed by an accessor.
const typedBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),"buffer").get;
const sharedByteLength = typeof SharedArrayBuffer === "function"
  ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype,"byteLength").get : null;

export function assertImportFreeSource(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024)
    throw Error("Oreslang scalar source must be bytes within the 1 MiB admission budget");
  let backing;
  try { backing = typedBuffer.call(bytes); }
  catch { throw Error("Oreslang scalar source requires genuine Uint8Array bytes"); }
  if (sharedByteLength) {
    let shared = false;
    try { sharedByteLength.call(backing); shared = true; } catch {}
    if (shared) throw Error("Oreslang scalar source cannot use shared memory");
  }
  const source = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  if (source.includes("\0")) throw Error("Oreslang source contains NUL byte");
  let i = 0;
  const identStart = c => /[A-Za-z_]/.test(c);
  const identPart = c => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    if (source.startsWith("//", i)) {
      // Treat CR/LF, NEL, and Unicode line/paragraph separators as boundaries.
      // A live import after any comment terminator must remain visible.
      i += 2;
      while (i < source.length && !["\r", "\n", "\u0085", "\u2028", "\u2029"].includes(source[i])) i++;
      continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { if (++depth > 128) throw Error("Oreslang block comment nesting exceeded"); i += 2; }
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
