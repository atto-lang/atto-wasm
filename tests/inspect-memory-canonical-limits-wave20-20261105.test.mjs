import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes as inspect} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const bounded=Uint8Array.from([...header,5,4,1,1,1,2]);

test('bounded module memory is parsed from a detached offset DataView',()=>{
 const container=Uint8Array.from([77,...bounded,99]);
 const view=new DataView(container.buffer,1,bounded.length);
 const result=inspect(view,{maxModuleBytes:64,maxMemoryPages:2});
 assert.equal(result.memoryCount,1);
 assert.equal(result.memoryInitial,1);
 assert.equal(result.memoryMaximum,2);
 assert.equal(result.hasMemoryMaximum,true);
 assert.deepEqual([...result.bytes],[...bounded]);
 container[1]=44;
 assert.equal(result.bytes[0],0);
});

test('host memory budget and malformed memory flags deny admission',()=>{
 assert.throws(()=>inspect(bounded,{maxMemoryPages:1}),/linear memory exceeds host budget/);
 assert.throws(()=>inspect(bounded,{maxModuleBytes:10}),/Wasm module exceeds maximum byte size/);
 assert.throws(()=>inspect(Uint8Array.from([...header,5,4,1,3,1,2])),/memory requires fixed initial and maximum limits/);
});

test('noncanonical padded u32 section length does not alias valid module bytes',()=>{
 const padded=Uint8Array.from([...header,5,0x84,0,1,1,1,2]);
 assert.throws(()=>inspect(padded),/noncanonical unsigned integer/);
 const start=Uint8Array.from([...header,8,1,0]);
 assert.throws(()=>inspect(start),/start section is forbidden/);
});

test('caller-defined view getters never widen source admission; shared backing is denied',()=>{
 const input=Uint8Array.from(bounded);
 let calls=0;
 Object.defineProperty(input,'byteLength',{get(){calls++;throw Error('spoof');}});
 Object.defineProperty(input,'buffer',{get(){calls++;throw Error('spoof');}});
 assert.equal(inspect(input).memoryCount,1);
 assert.equal(calls,0);
 if(typeof SharedArrayBuffer==='function'){
  const shared=new Uint8Array(new SharedArrayBuffer(bounded.length));shared.set(bounded);
  assert.throws(()=>inspect(shared),/shared Wasm input is not admitted/);
 }
});
