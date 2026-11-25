import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const moduleWith=tail=>Uint8Array.from([...header,...tail]);
const inspect=tail=>inspectWasmBytes(moduleWith(tail),{maxModuleBytes:64,maxMemoryPages:2});

test('one real fixed-memory section stays valid at the exact admitted minimum',()=>{
 const bytes=moduleWith([5,4,1,1,1,1]);
 assert.equal(WebAssembly.validate(bytes),true);
 const result=inspectWasmBytes(bytes,{maxModuleBytes:bytes.length,maxMemoryPages:1});
 assert.equal(result.memoryCount,1);
 assert.equal(result.memoryInitial,1);
 assert.equal(result.memoryMaximum,1);
});

test('four distinct malformed or over-budget memory-section forms fail closed',()=>{
 const cases=[
  [[5,5,1,1,1,1,0],/malformed memory section/],
  [[5,3,1,1,1],/truncated unsigned integer/],
  [[5,4,2,1,1,1],/more than one memory/],
  [[5,4,1,1,2,1],/linear memory exceeds host budget/]
 ];
 for(const [tail,re] of cases)
  assert.throws(()=>inspect(tail),re,tail.join(','));
});
