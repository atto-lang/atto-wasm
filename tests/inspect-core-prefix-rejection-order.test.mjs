import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const H=[0,97,115,109,1,0,0,0];
const inspect=tail=>inspectWasmBytes(Uint8Array.from([...H,...tail]),{maxModuleBytes:64,maxMemoryPages:2});

test('precompiled module is rejected rather than skipping byte admission',()=>{
 const precompiled=new WebAssembly.Module(Uint8Array.from(H));
 assert.throws(()=>inspectWasmBytes(precompiled),/precompiled WebAssembly.Module cannot be inspected/);
});

test('start and table sections fail closed before native Wasm validation',()=>{
 for(const tail of [[8,1,0],[4,1,0],[0,1,0,8,1,0],[0,1,0,4,1,0]])
  assert.throws(()=>inspect(tail),/section is forbidden|table section is not yet admitted/,tail.join(','));
});

test('invalid core headers and unsupported version bytes never enter validation',()=>{
 for(const i of [0,1,2,3,4,5,6,7]){
  const altered=[...H]; altered[i]^=1;
  assert.throws(()=>inspectWasmBytes(Uint8Array.from(altered),{maxModuleBytes:8}),/invalid core module header/);
 }
});