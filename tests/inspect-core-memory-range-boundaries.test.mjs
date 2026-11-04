import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const head=[0,97,115,109,1,0,0,0];
const moduleWith=payload=>Uint8Array.from([...head,5,payload.length,...payload]);
const inspect=(bytes,limit=2)=>inspectWasmBytes(bytes,{maxModuleBytes:64,maxMemoryPages:limit});

test('real core memory with fixed exact host page limit is admitted',()=>{
 const fixed=moduleWith([1,1,1,2]);
 assert.equal(WebAssembly.validate(fixed),true);
 const got=inspect(fixed,2);
 assert.equal(got.memoryCount,1);
 assert.equal(got.memoryInitial,1);
 assert.equal(got.memoryMaximum,2);
 assert.equal(got.hasMemoryMaximum,true);
 assert.throws(()=>inspect(fixed,1),/linear memory exceeds host budget/);
});

test('zero initial and maximum pages are valid and bounded',()=>{
 const zero=moduleWith([1,1,0,0]);
 assert.equal(WebAssembly.validate(zero),true);
 const got=inspect(zero,1);
 assert.equal(got.memoryInitial,0);
 assert.equal(got.memoryMaximum,0);
 assert.equal(got.memoryCount,1);
});

test('reversed page limits and duplicate memory sections are denied',()=>{
 const reversed=moduleWith([1,1,3,2]);
 assert.throws(()=>inspect(reversed,4),/linear memory exceeds host budget/);
 const fixed=moduleWith([1,1,1,2]);
 const duplicate=Uint8Array.from([...fixed,5,4,1,1,1,2]);
 assert.equal(WebAssembly.validate(duplicate),false);
 assert.throws(()=>inspect(duplicate,2),/invalid WebAssembly module/);
});
