import test from 'node:test';
import assert from 'node:assert/strict';
import {assertImportFreeSource} from '../scripts/import-admission.mjs';

const bytes=s=>new TextEncoder().encode(s);
const check=s=>assertImportFreeSource(bytes(s));
// Host-only scalar bridge admission, never a real LLVM/.atto guest test.
test('nested block-comment depth 128 admitted, 129 rejected',()=>{
 check('/*'.repeat(128)+'*/'.repeat(128)+'fnc main():int{return 42;}');
 assert.throws(()=>check('/*'.repeat(129)+'*/'.repeat(129)),/nesting exceeded/);
});

test('CR, LF, NEL and Unicode boundaries reveal live imports after line comments',()=>{
 for(const separator of ['\r','\n','\u0085','\u2028','\u2029']){
   assert.throws(()=>check('// ignored import'+separator+
     'import fnc x from "+/secret";'),/verified native import graph/,
     JSON.stringify(separator));
   check('// ignored import'+separator+'fnc main():int{return 42;}');
 }
});

test('quoted and commented imports are inert but executable imports fail',()=>{
 check('"import fnc x" \'import module y\' /* import fnc z */');
 assert.throws(()=>check('/* safe */ import fnc x from "pkg:private";'),
   /verified native import graph/);
 assert.throws(()=>check('fnc main():int{return 42;}\0'),/NUL/);
});

test('exact 1 MiB source is admitted before decoding; one byte more denied',()=>{
 assert.doesNotThrow(()=>assertImportFreeSource(new Uint8Array(1048576).fill(0x20)));
 assert.throws(()=>assertImportFreeSource(new Uint8Array(1048577)),/1 MiB/);
});

test('shadowed typed-array length and buffer cannot reduce the true size',()=>{
 const oversized=new Uint8Array(1048577);
 Object.defineProperty(oversized,'byteLength',{value:0});
 Object.defineProperty(oversized,'buffer',{value:new ArrayBuffer(0)});
 assert.throws(()=>assertImportFreeSource(oversized),/1 MiB/);
});
