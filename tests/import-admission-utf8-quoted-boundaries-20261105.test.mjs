import test from 'node:test';
import assert from 'node:assert/strict';
import {assertImportFreeSource} from '../scripts/import-admission.mjs';

const check=source=>assertImportFreeSource(new TextEncoder().encode(source));
// Host lexical admission only, not real LLVM/Wasm compiler execution.
test('malformed UTF-8 fails closed before import token scanning',()=>{
 for(const malformed of [[0xc0,0xaf],[0xe2,0x82],[0xff],[0xed,0xa0,0x80]])
  assert.throws(()=>assertImportFreeSource(Uint8Array.from(malformed)));
});
test('import-like identifiers, strings and comments are inert, live imports denied',()=>{
 assert.doesNotThrow(()=>check('important imported __import__ "import fnc x"'));
 assert.doesNotThrow(()=>check('/* import module A */ fnc main():int{return 42;}'));
 assert.throws(()=>check('/* safe */ import module Secret from "+secret";'),/verified native import graph/);
});
test('all Atto line boundaries expose live imports after line comments',()=>{
 for(const sep of ['\r','\u0085','\u2028','\u2029'])
  assert.throws(()=>check('// ignored import '+sep+'import module X from "+private";'),/verified native import graph/);
});