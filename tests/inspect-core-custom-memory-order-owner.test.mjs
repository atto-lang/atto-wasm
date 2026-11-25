import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const custom=[0,3,1,97,0]; // inert named custom section "a" with one payload byte
const fixedMemory=[5,4,1,1,1,1]; // one fixed 1..1 page memory
const moduleWith=tail=>Uint8Array.from([...header,...tail]);

test('inert custom sections before and after fixed memory retain the same owned admission',()=>{
 for(const tail of [[...custom,...fixedMemory],[...fixedMemory,...custom]]){
  const bytes=moduleWith(tail);
  assert.equal(WebAssembly.validate(bytes),true);
  const original=Uint8Array.from(bytes);
  const info=inspectWasmBytes(bytes,{maxModuleBytes:bytes.length,maxMemoryPages:1});
  assert.equal(info.memoryCount,1);
  assert.equal(info.hasMemoryMaximum,true);
  assert.equal(info.memoryInitial,1);
  assert.equal(info.memoryMaximum,1);
  assert.notStrictEqual(info.bytes,bytes);
  assert.deepEqual(info.bytes,original);
  bytes.fill(0);
  assert.deepEqual(info.bytes,original,'caller mutation cannot alter inspected bytes');
 }
});

test('full custom plus memory framing counts toward byte ceiling',()=>{
 const bytes=moduleWith([...custom,...fixedMemory]);
 assert.equal(inspectWasmBytes(bytes,{maxModuleBytes:bytes.length,maxMemoryPages:1}).bytes.length,bytes.length);
 assert.throws(()=>inspectWasmBytes(bytes,{maxModuleBytes:bytes.length-1,maxMemoryPages:1}),/Wasm module exceeds maximum byte size/);
});
