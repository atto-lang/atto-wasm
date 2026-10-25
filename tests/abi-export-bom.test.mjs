import test from "node:test";
import assert from "node:assert/strict";
import {assertCoreI64Entry} from "../scripts/core-i64-abi.mjs";
// Real hand-encoded Wasm: two distinct export names, "main" and "\uFEFFmain".
// The BOM is part of the export identifier, not a text-file encoding marker.
function moduleBytes(mainI64){
 const text=new TextEncoder();
 const section=(id,payload)=>[id,payload.length,...payload];
 const name=(value)=>{const b=text.encode(value);return[b.length,...b]};
 return Uint8Array.from([0,97,115,109,1,0,0,0,
  ...section(1,[2,96,0,1,127,96,0,1,126]),
  ...section(3,[2,mainI64?1:0,mainI64?0:1]),
  ...section(5,[1,1,1,1]),
  ...section(7,[3,...name("main"),0,0,...name("\uFEFFmain"),0,1,...name("memory"),2,0]),
  ...section(10,[2,4,0,mainI64?66:65,42,11,4,0,mainI64?65:66,7,11])]);
}
test("BOM-prefixed export cannot substitute another function's i64 signature",()=>{
 const bytes=moduleBytes(false);
 assert.equal(WebAssembly.validate(bytes),true);
 const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes));
 assert.equal(instance.exports.main(),42);
 assert.equal(instance.exports["\uFEFFmain"](),7n);
 assert.throws(()=>assertCoreI64Entry(bytes,"main"),/exact.*i64 signature/);
});
test("BOM-prefixed i32 sibling cannot hide the actual i64 entry",()=>{
 const bytes=moduleBytes(true);
 assert.equal(WebAssembly.validate(bytes),true);
 assert.doesNotThrow(()=>assertCoreI64Entry(bytes,"main"));
 assert.equal(new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.main(),42n);
});
