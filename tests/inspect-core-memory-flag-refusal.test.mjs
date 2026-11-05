import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const moduleOf=(...tail)=>Uint8Array.from([...header,...tail]);
const admit=bytes=>inspectWasmBytes(bytes,{maxModuleBytes:64,maxMemoryPages:2});

test('shared, memory64, and missing-maximum declarations cannot bypass fixed-memory policy',()=>{
 for(const flags of [0,2,3,4,5,7]){
  const bytes=moduleOf(5,4,1,flags,1,2);
  assert.throws(()=>admit(bytes),/memory requires fixed initial and maximum limits/,'flags='+flags);
 }
});

test('canonical empty memory section has zero allocations and validates as core Wasm',()=>{
 const bytes=moduleOf(5,1,0);
 assert.equal(WebAssembly.validate(bytes),true);
 const info=admit(bytes);
 assert.equal(info.memoryCount,0);
 assert.equal(info.memoryInitial,0);
 assert.equal(info.hasMemoryMaximum,false);
});

test('truncated, overflowing and overlong u32 section lengths fail closed',()=>{
 for(const [bytes,reason] of [
  [moduleOf(0,0x80),/truncated unsigned integer/],
  [moduleOf(0,0xff,0xff,0xff,0xff,0x10),/invalid u32 encoding/],
  [moduleOf(0,0x80,0x80,0x80,0x80,0x80,0),/invalid u32 encoding/]
 ]){
  assert.equal(WebAssembly.validate(bytes),false);
  assert.throws(()=>admit(bytes),reason);
 }
});
