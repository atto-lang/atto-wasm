import test from "node:test";
import assert from "node:assert/strict";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";

const core=()=>Uint8Array.from([0,97,115,109,1,0,0,0]);

test("inspector copies raw Wasm slots without invoking caller iterator",()=>{
 const view=core();let reads=0;
 Object.defineProperty(view,Symbol.iterator,{value:function*(){reads++;throw Error("untrusted byte iterator");}});
 const result=inspectWasmBytes(view,{maxModuleBytes:64});
 assert.deepEqual(Array.from(result.bytes),[0,97,115,109,1,0,0,0]);
 assert.equal(reads,0);
});

test("Wasm inspector rejects hidden shared backing and spoofed byte lengths",()=>{
 const over=new Uint8Array(65);
 Object.defineProperty(over,"byteLength",{value:8});
 assert.throws(()=>inspectWasmBytes(over,{maxModuleBytes:64}),/maximum byte size/);
 if(typeof SharedArrayBuffer==="function"){
  const shared=new Uint8Array(new SharedArrayBuffer(8));
  Object.defineProperty(shared,"buffer",{value:core().buffer});
  assert.throws(()=>inspectWasmBytes(shared,{maxModuleBytes:64}),/shared Wasm input is not admitted/);
 }
});

test("DataView backing, offsets and length come from native slots",()=>{
 const input=Uint8Array.from([255,0,97,115,109,1,0,0,0,255]);
 const view=new DataView(input.buffer,1,8);
 Object.defineProperty(view,"byteOffset",{value:0});
 Object.defineProperty(view,"byteLength",{value:10});
 Object.defineProperty(view,"buffer",{get(){throw Error("caller buffer getter invoked");}});
 const result=inspectWasmBytes(view,{maxModuleBytes:8});
 assert.deepEqual(Array.from(result.bytes),[0,97,115,109,1,0,0,0]);
});

test("spoofed typed-array buffer cannot bypass the byte budget",()=>{
 const view=new Uint8Array(65);
 Object.defineProperty(view,"buffer",{value:new ArrayBuffer(8)});
 assert.throws(()=>inspectWasmBytes(view,{maxModuleBytes:64}),/maximum byte size/);
});

test("Wasm inspector rejects start and table sections before compilation",()=>{
 const header=[0,97,115,109,1,0,0,0];
 for(const [section,pattern] of [
  [[8,1,0],/start section/],
  [[4,1,0],/table section/]
 ])assert.throws(()=>inspectWasmBytes(Uint8Array.from([...header,...section]),
  {maxModuleBytes:64,maxMemoryPages:2}),pattern);
});

test("Wasm inspector requires bounded fixed memory pages",()=>{
 const header=[0,97,115,109,1,0,0,0];
 for(const [section,pattern] of [
  [[5,3,1,0,1],/fixed initial and maximum limits/],
  [[5,4,1,3,1,1],/shared\/memory64 forbidden/],
  [[5,4,1,1,3,2],/linear memory exceeds host budget/],
  [[5,4,1,1,1,3],/linear memory exceeds host budget/]
 ])assert.throws(()=>inspectWasmBytes(Uint8Array.from([...header,...section]),
  {maxModuleBytes:64,maxMemoryPages:2}),pattern);
 const admitted=inspectWasmBytes(Uint8Array.from([...header,5,4,1,1,1,2]),
  {maxModuleBytes:64,maxMemoryPages:2});
 assert.equal(admitted.memoryCount,1);
 assert.equal(admitted.hasMemoryMaximum,true);
 assert.equal(admitted.memoryInitial,1);
 assert.equal(admitted.memoryMaximum,2);
});

test("real core Wasm memory limits and start sections fail closed before publication",()=>{
 const header=[0,97,115,109,1,0,0,0];
 // One native valid core memory: initial=1, maximum=2 pages.
 const fixed=Uint8Array.from([...header,5,4,1,1,1,2]);
 assert.equal(WebAssembly.validate(fixed),true);
 const admitted=inspectWasmBytes(fixed,{maxModuleBytes:64,maxMemoryPages:2});
 assert.equal(admitted.memoryCount,1);
 assert.equal(admitted.hasMemoryMaximum,true);
 assert.equal(admitted.memoryInitial,1);
 assert.equal(admitted.memoryMaximum,2);
 assert.throws(()=>inspectWasmBytes(fixed,{maxModuleBytes:64,maxMemoryPages:1}),
   /linear memory exceeds host budget/);
 const unlimited=Uint8Array.from([...header,5,3,1,0,1]);
 assert.equal(WebAssembly.validate(unlimited),true);
 assert.throws(()=>inspectWasmBytes(unlimited,{maxModuleBytes:64,maxMemoryPages:2}),
   /memory requires fixed initial and maximum limits/);
 const start=Uint8Array.from([...header,8,1,0]);
 assert.throws(()=>inspectWasmBytes(start,{maxModuleBytes:64,maxMemoryPages:2}),
   /start section is forbidden/);
});

test("Wasm inspector snapshots offset slices without aliasing caller bytes",()=>{
 const supplied=Uint8Array.from([255,0,97,115,109,1,0,0,0,255]);
 const slice=supplied.subarray(1,9);
 let calls=0;
 Object.defineProperty(slice,"byteOffset",{value:0});
 Object.defineProperty(slice,"set",{value(){calls++;throw Error("untrusted set called");}});
 const verified=inspectWasmBytes(slice,{maxModuleBytes:8});
 assert.deepEqual(Array.from(verified.bytes),[0,97,115,109,1,0,0,0]);
 assert.equal(calls,0);
 assert.notEqual(verified.bytes.buffer,supplied.buffer);
 supplied[1]=255;
 supplied[4]=255;
 assert.deepEqual(Array.from(verified.bytes),[0,97,115,109,1,0,0,0]);
});

test("raw ArrayBuffer core bytes are detached from later caller mutations",()=>{
 const original=core();
 const source=original.buffer;
 const result=inspectWasmBytes(source,{maxModuleBytes:8});
 assert.notEqual(result.bytes.buffer,source);
 assert.deepEqual(Array.from(result.bytes),[0,97,115,109,1,0,0,0]);
 original.fill(255);
 assert.deepEqual(Array.from(result.bytes),[0,97,115,109,1,0,0,0],
   "validated snapshot must not share mutable caller backing");
});
