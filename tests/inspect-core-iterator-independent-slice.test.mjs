import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];

test('typed-array subarray does not invoke hostile iteration and copies only its own slice',()=>{
 const backing=new Uint8Array(40);
 backing.set([...header,0,1,0],13);
 const view=backing.subarray(13,24);
 let called=0;
 Object.defineProperty(view,Symbol.iterator,{
  get(){called++;throw Error('iterator must never execute');}
 });
 const inspected=inspectWasmBytes(view,{maxModuleBytes:11,maxMemoryPages:1});
 assert.equal(called,0);
 assert.equal(inspected.bytes.length,11);
 assert.equal(WebAssembly.validate(inspected.bytes),true);
 backing[13]=255;
 assert.equal(inspected.bytes[0],0);
});

test('genuine native DataView internal slots admit byte-exact empty core without custom iterators',()=>{
 const bytes=Uint8Array.from(header);
 const view=new DataView(bytes.buffer);
 const inspected=inspectWasmBytes(view,{maxModuleBytes:8,maxMemoryPages:1});
 assert.equal(inspected.bytes.length,8);
 assert.deepEqual([...inspected.bytes],header);
 assert.equal(inspected.memoryCount,0);
});
