import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

// This is a minimal syntax regression; final admission still requires a
// pinned wit-parser and component ABI execution, not regex-only proof.
test("host WIT clock uses Component Model f64, not obsolete float64",async()=>{
 const source=await readFile(new URL("../wit/oreslang-host.wit",import.meta.url),"utf8");
 assert.match(source,/clock-ms:\\s*func\\(\\)\\s*->\\s*f64;/);
 assert.doesNotMatch(source,/\\bfloat64\\b/);
 assert.match(source,/world\\s+oreslang-runtime/);
});
