import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const moduleOf=(...sections)=>Uint8Array.from([...header,...sections.flat()]);
const one=[5,4,1,1,2,2];
const two=[5,7,2,1,0,1,1,0,1];
const admit=bytes=>inspectWasmBytes(bytes,{maxModuleBytes:64,maxMemoryPages:2});

test('two memories are rejected before native guest validation',()=>{
 assert.throws(()=>admit(moduleOf(two)),/more than one memory/);
});

test('single fixed memory may use exact page ceiling, but not inverted bounds',()=>{
 const good=moduleOf(one);
 assert.equal(WebAssembly.validate(good),true);
 const parsed=admit(good);
 assert.equal(parsed.memoryCount,1);
 assert.equal(parsed.memoryInitial,2);
 assert.equal(parsed.memoryMaximum,2);
 for(const bytes of [moduleOf([5,4,1,1,3,2]),moduleOf([5,4,1,1,2,3])])
  assert.throws(()=>admit(bytes),/linear memory exceeds host budget/);
});

test('duplicate memory sections are rejected even when each has valid individual limits',()=>{
 const duplicate=moduleOf(one,one);
 assert.equal(WebAssembly.validate(duplicate),false);
 assert.throws(()=>admit(duplicate),/invalid WebAssembly module/);
});
