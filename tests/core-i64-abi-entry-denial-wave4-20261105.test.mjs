import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCoreI64Entry} from '../scripts/core-i64-abi.mjs';
const head=[0,97,115,109,1,0,0,0];
const section=(id,body)=>[id,body.length,...body];
const moduleBytes=(result=0x7e,kind=0)=>Uint8Array.from([
  ...head,
  ...section(1,[1,0x60,0,1,result]),
  ...section(3,[1,0]),
  ...section(7,[1,4,109,97,105,110,kind,0]),
  ...section(10,[1,4,0,result===0x7e?0x42:0x41,42,0x0b])
]);

test('a canonical function entry with () -> i64 is accepted by native Wasm validation',()=>{
  const good=moduleBytes();
  assert.equal(WebAssembly.validate(good),true);
  assert.doesNotThrow(()=>assertCoreI64Entry(good,'main'));
});

test('i32 entry, nonfunction export and a missing exact name are denied',()=>{
  const i32=moduleBytes(0x7f);
  assert.equal(WebAssembly.validate(i32),true);
  assert.throws(()=>assertCoreI64Entry(i32,'main'),/exact \(\) -> i64 signature/);
  assert.throws(()=>assertCoreI64Entry(moduleBytes(0x7e,2),'main'),/not a function/);
  assert.throws(()=>assertCoreI64Entry(moduleBytes(),'Main'),/exact \(\) -> i64 signature/);
});

test('truncated sections and malformed unsigned integer fields fail closed',()=>{
  assert.throws(()=>assertCoreI64Entry(Uint8Array.from([...head,7,99,1]),'main'),/truncated Wasm ABI section/);
  assert.throws(()=>assertCoreI64Entry(Uint8Array.from([...head,7,0x80,0x00]),'main'),/noncanonical Wasm ABI integer/);
  assert.throws(()=>assertCoreI64Entry(Uint8Array.from([...head,7,0xff,0xff,0xff,0xff,0x10]),'main'),/invalid Wasm ABI integer/);
});
