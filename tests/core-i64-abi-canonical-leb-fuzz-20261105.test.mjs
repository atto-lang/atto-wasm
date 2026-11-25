import test from "node:test";
import assert from "node:assert/strict";
import {assertCoreI64Entry} from "../scripts/core-i64-abi.mjs";
const header=[0,97,115,109,1,0,0,0];
const name=s=>[s.length,...new TextEncoder().encode(s)];
const section=(kind,data)=>[kind,data.length,...data];
const type=[1,0x60,0,1,0x7e],func=[1,0],code=[1,4,0,0x42,42,0x0b];
const binary=(exportBody=[1,...name("main"),0,0])=>Uint8Array.from([
 ...header,...section(1,type),...section(3,func),...section(7,exportBody),...section(10,code)
]);
test("static core i64 signature accepts exact one-export canonical module",()=>{
 assert.equal(WebAssembly.validate(binary()),true);
 assert.doesNotThrow(()=>assertCoreI64Entry(binary(),"main"));
 assert.throws(()=>assertCoreI64Entry(binary(),"nonexistent"));
});
test("static core i64 policy rejects padded indexes and malformed export counts",()=>{
 const padded=binary([1,...name("main"),0,0x80,0]);
 const paddedCount=binary([0x81,0,...name("main"),0,0]);
 const absent=binary([1,...name("main"),0]);
 for(const bytes of [padded,paddedCount,absent]){
  assert.throws(()=>assertCoreI64Entry(bytes,"main"));
 }
});
