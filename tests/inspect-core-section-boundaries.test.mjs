import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const moduleWith=bytes=>Uint8Array.from([...header,...bytes]);

test('only fixed memory with both minimum and maximum inside host budget is admitted',()=>{
  // Section 5: one memory, flags=1 (min+max), min=2, max=2.
  const fixed=moduleWith([5,4,1,1,2,2]);
  assert.equal(WebAssembly.validate(fixed),true,'control must be a real core Wasm module');
  const accepted=inspectWasmBytes(fixed,{maxModuleBytes:64,maxMemoryPages:2});
  assert.equal(accepted.memoryCount,1);
  assert.equal(accepted.hasMemoryMaximum,true);
  assert.equal(accepted.memoryInitial,2);
  assert.equal(accepted.memoryMaximum,2);
  assert.throws(()=>inspectWasmBytes(fixed,{maxModuleBytes:64,maxMemoryPages:1}),
                /linear memory exceeds host budget/);
  // Section 5 with flags=0 has no maximum and must not be admitted.
  const unbounded=moduleWith([5,3,1,0,2]);
  assert.equal(WebAssembly.validate(unbounded),true);
  assert.throws(()=>inspectWasmBytes(unbounded,{maxModuleBytes:64}),
                /memory requires fixed initial and maximum limits/);
});

test('start and table sections are denied before module validation or execution',()=>{
  assert.throws(()=>inspectWasmBytes(moduleWith([8,1,0]),{maxModuleBytes:64}),
                /start section is forbidden/);
  assert.throws(()=>inspectWasmBytes(moduleWith([4,1,0]),{maxModuleBytes:64}),
                /table section is not yet admitted/);
});
