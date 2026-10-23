import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
// Grammar-surface regression only. An actual pinned WIT parser, projected
// component ABI and dual-schema tjsv are still required for release.
const source=await readFile(new URL("../wit/oreslang-host.wit",import.meta.url),"utf8");

test("WIT authored ABI keeps canonical f64 and a versioned package/world",()=>{
 assert.match(source,/^package oreslang:host@0\.1\.0;/m);
 assert.match(source,/\binterface clock\s*\{/);
 assert.match(source,/\bclock-ms:\s*func\(\)\s*->\s*f64\s*;/);
 assert.match(source,/\bworld oreslang-runtime\s*\{/);
 assert.match(source,/\bimport clock\s*;/);
 assert.match(source,/\bexport abi-version:\s*func\(\)\s*->\s*u32\s*;/);
 assert.doesNotMatch(source,/\b(?:float32|float64|externref)\b/);
});
