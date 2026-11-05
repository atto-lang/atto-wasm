import test from "node:test";
import assert from "node:assert/strict";
import {assertCoreI64Entry} from "../scripts/core-i64-abi.mjs";

const part=(id,body)=>[id,body.length,...body];
const name=s=>[s.length,...new TextEncoder().encode(s)];
const header=[0,97,115,109,1,0,0,0];
const type=[1,0x60,0,1,0x7e],fn=[1,0],exp=[1,...name("main"),0,0];
const code=[1,4,0,0x42,42,0x0b];
const canonical=()=>Uint8Array.from([
 ...header,...part(1,type),...part(3,fn),
 ...part(7,exp),...part(10,code)
]);

test("standalone core i64 ABI validator accepts ordinary canonical Wasm integers",()=>{
 assert.equal(WebAssembly.validate(canonical()),true);
 assert.doesNotThrow(()=>assertCoreI64Entry(canonical(),"main"));
});

test("noncanonical padded unsigned LEB128 cannot impersonate canonical sections or indices",()=>{
 const aliasSection=Uint8Array.from([
  ...header,1,0x85,0x00,...type,...part(3,fn),
  ...part(7,exp),...part(10,code)
 ]);
 const aliasTypeCount=Uint8Array.from([
  ...header,...part(1,[0x81,0x00,0x60,0,1,0x7e]),
  ...part(3,fn),...part(7,exp),...part(10,code)
 ]);
 const aliasFuncIndex=Uint8Array.from([
  ...header,...part(1,type),...part(3,[1,0x80,0x00]),
  ...part(7,exp),...part(10,code)
 ]);
 for(const bytes of [aliasSection,aliasTypeCount,aliasFuncIndex]){
  // Wasm permits padded LEB128; the AttoLang ABI intentionally requires
  // a single canonical binary spelling even when the engine accepts it.
  assert.throws(()=>assertCoreI64Entry(bytes,"main"),
    /noncanonical Wasm ABI integer/);
 }
});
