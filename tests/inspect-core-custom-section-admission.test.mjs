import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const core=(...tail)=>Uint8Array.from([...header,...tail]);

test('multiple inert custom sections remain valid and do not create memory',()=>{
 const bytes=core(0,1,0,0,1,0);
 assert.equal(WebAssembly.validate(bytes),true);
 const info=inspectWasmBytes(bytes,{maxModuleBytes:bytes.length});
 assert.deepEqual([...info.bytes],[...bytes]);
 assert.equal(info.memoryCount,0);
 assert.equal(info.hasMemoryMaximum,false);
});

test('custom section parser fails closed on incomplete and overflowing unsigned lengths',()=>{
 for(const [bytes,message] of [
  [core(0,0x80),/truncated unsigned integer/],
  [core(0,5,0),/section extends beyond module/],
  [core(0,0xff,0xff,0xff,0xff,0x10),/invalid u32 encoding/]
 ])assert.throws(()=>inspectWasmBytes(bytes,{maxModuleBytes:64}),message);
});

test('maximum module bytes applies to the complete custom-section payload',()=>{
 const bytes=core(0,1,0);
 assert.equal(bytes.length,11);
 assert.equal(inspectWasmBytes(bytes,{maxModuleBytes:11}).bytes.length,11);
 assert.throws(()=>inspectWasmBytes(bytes,{maxModuleBytes:10}),/Wasm module exceeds maximum byte size/);
});
