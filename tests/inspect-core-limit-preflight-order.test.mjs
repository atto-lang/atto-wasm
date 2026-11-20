import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const emptyCore=Uint8Array.from([0,97,115,109,1,0,0,0]);

test('invalid module budgets fail before hostile input can be inspected',()=>{
 let touched=0;
 const input=new Proxy({},{
  getPrototypeOf(){touched++;throw Error('input accessed');},
  get(){touched++;throw Error('input accessed');}
 });
 for(const maxModuleBytes of [0,7,16*1024*1024+1,1.5,NaN,Infinity])
  assert.throws(()=>inspectWasmBytes(input,{maxModuleBytes}),/invalid maximum module size/);
 for(const maxMemoryPages of [0,257,1.5,NaN,Infinity])
  assert.throws(()=>inspectWasmBytes(input,{maxMemoryPages}),/invalid maximum memory pages/);
 assert.equal(touched,0,'admission budgets must precede caller input examination');
});

test('the exact eight-byte module size budget admits a valid empty core',()=>{
 const result=inspectWasmBytes(emptyCore,{maxModuleBytes:8,maxMemoryPages:1});
 assert.equal(result.memoryCount,0);
 assert.deepEqual([...result.bytes],[...emptyCore]);
});

test('one byte above the module budget is rejected before Wasm parsing',()=>{
 const tooLarge=Uint8Array.from([...emptyCore,0]);
 assert.throws(()=>inspectWasmBytes(tooLarge,{maxModuleBytes:8,maxMemoryPages:1}),/Wasm module exceeds maximum byte size/);
});