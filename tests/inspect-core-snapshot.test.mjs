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
