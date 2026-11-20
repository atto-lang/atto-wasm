import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const moduleOf=(...sections)=>Uint8Array.from([...header,...sections.flat()]);
const custom=[0,1,0];

test('table section is refused before any guest validation or publication',()=>{
 for(const sections of [[[4,1,0]],[custom,[4,1,0]],[[4,1,0],custom]]){
  assert.throws(()=>inspectWasmBytes(moduleOf(...sections)),/table section is not yet admitted/);
 }
});

test('start section is refused regardless of preceding inert custom metadata',()=>{
 for(const sections of [[[8,1,0]],[custom,[8,1,0]],[[8,1,0],custom]]){
  assert.throws(()=>inspectWasmBytes(moduleOf(...sections)),/start section is forbidden/);
 }
});

test('multiple well-formed inert custom sections preserve the admitted snapshot',()=>{
 const bytes=moduleOf(custom,custom);
 assert.equal(WebAssembly.validate(bytes),true);
 const admitted=inspectWasmBytes(bytes,{maxModuleBytes:bytes.length});
 assert.equal(admitted.memoryCount,0);
 assert.deepEqual([...admitted.bytes],[...bytes]);
 bytes[1]=0;
 assert.equal(admitted.bytes[1],97);
});
