import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const custom=[0,1,0]; // inert custom section with empty UTF-8 name
const memory=[5,4,1,1,1,2]; // fixed one-page initial, two-page maximum
const moduleOf=(...parts)=>Uint8Array.from([...header,...parts.flat()]);

test('custom sections before or after bounded memory do not change the quota',()=>{
 for(const parts of [[memory],[custom,memory],[memory,custom],[custom,memory,custom]]){
  const bytes=moduleOf(...parts);
  assert.equal(WebAssembly.validate(bytes),true,'valid genuine core Wasm');
  const info=inspectWasmBytes(bytes,{maxModuleBytes:64,maxMemoryPages:2});
  assert.equal(info.memoryCount,1);
  assert.equal(info.memoryInitial,1);
  assert.equal(info.memoryMaximum,2);
  assert.equal(info.hasMemoryMaximum,true);
  assert.deepEqual(Array.from(info.bytes),Array.from(bytes));
  assert.throws(()=>inspectWasmBytes(bytes,{maxModuleBytes:64,maxMemoryPages:1}),/linear memory exceeds host budget/);
 }
});

test('unsupported start section refuses publication regardless of custom ordering',()=>{
 const start=[8,1,0];
 for(const parts of [[start],[custom,start],[start,custom],[custom,memory,custom,start]])
  assert.throws(()=>inspectWasmBytes(moduleOf(...parts),{maxModuleBytes:64,maxMemoryPages:2}),/start section is forbidden/);
});

test('duplicate memory definitions are not accepted through custom-section shuffling',()=>{
 for(const parts of [[memory,memory],[memory,custom,memory],[custom,memory,memory]]){
  const bytes=moduleOf(...parts);
  assert.equal(WebAssembly.validate(bytes),false);
  assert.throws(()=>inspectWasmBytes(bytes,{maxModuleBytes:64,maxMemoryPages:2}),/invalid WebAssembly module/);
 }
});
