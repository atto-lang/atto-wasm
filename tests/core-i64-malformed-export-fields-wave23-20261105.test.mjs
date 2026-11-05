import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCoreI64Entry as check} from '../scripts/core-i64-abi.mjs';

const header=[0,97,115,109,1,0,0,0];
const section=(id,body)=>[id,body.length,...body];
const valid=()=>Uint8Array.from([...header,
 ...section(1,[1,0x60,0,1,0x7e]),
 ...section(3,[1,0]),
 ...section(7,[1,4,109,97,105,110,0,0]),
 ...section(10,[1,4,0,0x42,42,0x0b])
]);

test('well-formed direct i64 entry is admitted but missing entries fail closed',()=>{
 assert.equal(WebAssembly.validate(valid()),true);
 assert.doesNotThrow(()=>check(valid(),'main'));
 assert.throws(()=>check(valid(),'other'),/exact \(\) -> i64 signature/);
});

test('export-name declared length beyond section boundary is rejected',()=>{
 const bad=Uint8Array.from([...header,...section(7,[1,20,109,97,105,110,0,0])]);
 assert.throws(()=>check(bad,'main'),/malformed Wasm ABI export name/);
});

test('a declared result count without corresponding type bytes is rejected',()=>{
 const bad=Uint8Array.from([...header,...section(1,[1,0x60,0,2,0x7e])]);
 assert.throws(()=>check(bad,'main'),/invalid Wasm ABI result count/);
});

test('overlong and padded u32 fields are not accepted as canonical ABI metadata',()=>{
 const padded=Uint8Array.from([...header,7,0x88,0,1,4,109,97,105,110,0,0]);
 assert.throws(()=>check(padded,'main'),/noncanonical Wasm ABI integer/);
 const trailing=Uint8Array.from([...header,7,0x81,0x80,0x80,0x80,0x80,0]);
 assert.throws(()=>check(trailing,'main'),/overlong Wasm ABI integer/);
});
