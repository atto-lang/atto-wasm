import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const wasm=section=>Uint8Array.from([...header,...section]);

test('exact fixed-memory boundary is accepted before any guest instantiation',()=>{
  const fixed=wasm([5,4,1,1,2,2]);
  assert.equal(WebAssembly.validate(fixed),true,'valid core Wasm control');
  const result=inspectWasmBytes(fixed,{maxModuleBytes:fixed.length,maxMemoryPages:2});
  assert.equal(result.memoryCount,1);
  assert.equal(result.hasMemoryMaximum,true);
  assert.equal(result.memoryInitial,2);
  assert.equal(result.memoryMaximum,2);
  assert.equal(result.bytes.length,fixed.length);
});

test('inverted min/max and over-quota maximum are rejected prior to execution',()=>{
  for(const section of [
    [5,4,1,1,2,1],
    [5,4,1,1,2,3],
    [5,4,1,1,3,3]
  ])assert.throws(()=>inspectWasmBytes(wasm(section),
    {maxModuleBytes:64,maxMemoryPages:2}),/linear memory exceeds host budget/);
});

test('unbounded, shared and memory64 flags cannot downgrade the admission contract',()=>{
  for(const section of [
    [5,3,1,0,2],
    [5,3,1,2,2],
    [5,3,1,3,2],
    [5,3,1,4,2]
  ])assert.throws(()=>inspectWasmBytes(wasm(section),
    {maxModuleBytes:64,maxMemoryPages:2}),
    /memory requires fixed initial and maximum limits/);
});

test('section-budget denial is independent of caller-provided own length fields',()=>{
  const bytes=wasm([5,4,1,1,2,2]);
  Object.defineProperty(bytes,'byteLength',{value:8});
  assert.throws(()=>inspectWasmBytes(bytes,{maxModuleBytes:8,maxMemoryPages:2}),
    /maximum byte size/);
});
