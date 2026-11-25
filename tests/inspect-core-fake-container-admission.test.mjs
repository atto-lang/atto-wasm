import test from "node:test";
import assert from "node:assert/strict";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";

test("byte-container lookalikes cannot impersonate native ArrayBuffer slots",()=>{
 const fake=Object.create(Uint8Array.prototype);
 const plain={buffer:new ArrayBuffer(8),byteOffset:0,byteLength:8};
 const wrapped=new Proxy(Uint8Array.from([0,97,115,109,1,0,0,0]),{});
 for(const source of [fake,plain,wrapped])
   assert.throws(()=>inspectWasmBytes(source,{maxModuleBytes:64}),
     /expected a Wasm ArrayBuffer or typed array/);
});

test("foreign fake byte inputs cannot execute exposed getters or iterators",()=>{
 let calls=0;
 const fake=Object.create(null);
 for(const key of ["buffer","byteLength","byteOffset",Symbol.iterator])
   Object.defineProperty(fake,key,{get(){calls++;throw Error("untrusted input getter");}});
 assert.throws(()=>inspectWasmBytes(fake,{maxModuleBytes:64}),
   /expected a Wasm ArrayBuffer or typed array/);
 assert.equal(calls,0);
});
