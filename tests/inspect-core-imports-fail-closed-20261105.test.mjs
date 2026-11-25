import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const wasm=(...tail)=>Uint8Array.from([...header,...tail]);
const admit=bytes=>inspectWasmBytes(bytes,{maxModuleBytes:64,maxMemoryPages:2});

test('valid imported memory cannot evade the declared-memory budget',()=>{
 const imported=wasm(2,8,1,1,109,1,120,2,0,1);
 assert.equal(WebAssembly.validate(imported),true);
 assert.throws(()=>admit(imported),/imported tables and memories are forbidden/);
});

test('valid imported table is not silently accepted',()=>{
 const imported=wasm(2,9,1,1,109,1,116,1,0x70,0,1);
 assert.equal(WebAssembly.validate(imported),true);
 assert.throws(()=>admit(imported),/imported tables and memories are forbidden/);
});

test('ordinary function imports remain admitted',()=>{
 const imported=wasm(1,4,1,0x60,0,0,2,7,1,1,109,1,102,0,0);
 assert.equal(WebAssembly.validate(imported),true);
 assert.equal(admit(imported).memoryCount,0);
});

test('malformed import envelopes and noncanonical counts fail closed',()=>{
 for(const bad of [
  wasm(2,1,1),
  wasm(2,2,0x80,0),
  wasm(2,2,1,0),
  wasm(2,8,1,1,109,1,120,2,0)
 ])assert.throws(()=>admit(bad),/admission denied|truncated|noncanonical/);
});
