import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCoreI64Entry} from '../scripts/core-i64-abi.mjs';

const section=(id,body)=>[id,body.length,...body];
const name=s=>{const bytes=[...new TextEncoder().encode(s)];return [bytes.length,...bytes];};
const wasm=(entry='main',params=[],results=[0x7e])=>Uint8Array.from([
 0,97,115,109,1,0,0,0,
 ...section(1,[1,0x60,params.length,...params,results.length,...results]),
 ...section(3,[1,0]),
 ...section(7,[1,...name(entry),0,0]),
 ...section(10,[1,4,0,results[0]===0x7e?0x42:0x41,42,0x0b])
]);

test('a valid no-import () -> i64 core entry is admitted by exact name',()=>{
 const bytes=wasm();
 assert.equal(WebAssembly.validate(bytes),true);
 assert.doesNotThrow(()=>assertCoreI64Entry(bytes,'main'));
 assert.throws(()=>assertCoreI64Entry(bytes,'Main'),/exact \(\) -> i64/);
});

test('Unicode BOM belongs to the export name and cannot silently alias main',()=>{
 const marked='\uFEFFmain';
 const bytes=wasm(marked);
 assert.equal(WebAssembly.validate(bytes),true);
 assert.doesNotThrow(()=>assertCoreI64Entry(bytes,marked));
 assert.throws(()=>assertCoreI64Entry(bytes,'main'),/exact \(\) -> i64/);
});

test('wrong function signature or malformed UTF-8 export name fails closed',()=>{
 assert.throws(()=>assertCoreI64Entry(wasm('main',[],[0x7f]),'main'),/exact \(\) -> i64/);
 assert.throws(()=>assertCoreI64Entry(wasm('main',[0x7e]),'main'),/exact \(\) -> i64/);
 const bytes=Uint8Array.from([
  0,97,115,109,1,0,0,0,
  ...section(1,[1,0x60,0,1,0x7e]),
  ...section(3,[1,0]),
  ...section(7,[1,2,0xc3,0x28,0,0])
 ]);
 assert.throws(()=>assertCoreI64Entry(bytes,'main'));
});
