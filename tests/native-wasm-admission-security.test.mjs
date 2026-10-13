import test from "node:test";
import assert from "node:assert/strict";
import {assertCoreI64Entry} from "../scripts/core-i64-abi.mjs";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";

// Genuine validated () -> i64 main() returning 42, one 2-page memory with
// declared maximum 2. No imports, start section, tables or dynamic memory.
const bounded=Uint8Array.from([
 0,97,115,109,1,0,0,0,
 1,5,1,0x60,0,1,0x7e,
 3,2,1,0,
 5,4,1,1,2,2,
 7,8,1,4,109,97,105,110,0,0,
 10,6,1,4,0,0x42,42,0x0b
]);
// Same valid module, but the memory declaration has NO explicit maximum.
const unbounded=Uint8Array.from([
 0,97,115,109,1,0,0,0,
 1,5,1,0x60,0,1,0x7e,
 3,2,1,0,
 5,3,1,0,2,
 7,8,1,4,109,97,105,110,0,0,
 10,6,1,4,0,0x42,42,0x0b
]);
const inspect=bytes=>inspectWasmBytes(bytes,{maxModuleBytes:16777216,maxMemoryPages:2});

test("native Wasm memory policy validates bounded backing across byte-view forms",()=>{
 assert.equal(WebAssembly.validate(bounded),true);
 assert.equal(WebAssembly.validate(unbounded),true);
 for(const value of [bounded,bounded.buffer,
  new DataView(bounded.buffer,bounded.byteOffset,bounded.byteLength)]){
  const info=inspect(value);
  assert.equal(info.memoryCount,1);
  assert.equal(info.hasMemoryMaximum,true);
  assert.equal(info.memoryMaximum,2);
  assert.deepEqual(info.bytes,bounded);
 }
 assert.throws(()=>inspect(unbounded),/memory requires fixed initial and maximum limits/);
 assert.doesNotThrow(()=>assertCoreI64Entry(bounded,"main"));
});

test("memory inspector does not consult fake typed-array getters or iterator",()=>{
 let invoked=0;
 class HostileBytes extends Uint8Array{
  get buffer(){invoked++;throw Error("hostile buffer getter")}
  get byteOffset(){invoked++;throw Error("hostile offset getter")}
  get byteLength(){invoked++;throw Error("hostile length getter")}
  [Symbol.iterator](){invoked++;throw Error("hostile iterator")}
 }
 const value=new HostileBytes(bounded);
 assert.deepEqual(inspect(value).bytes,bounded);
 assert.equal(invoked,0);
});

test("memory budget cannot be bypassed by poisoning Uint8Array.from or iteration",()=>{
 const originalFrom=Object.getOwnPropertyDescriptor(Uint8Array,"from");
 const originalIter=Object.getOwnPropertyDescriptor(Uint8Array.prototype,Symbol.iterator);
 let invocations=0,result;
 try{
  Object.defineProperty(Uint8Array,"from",{configurable:true,writable:true,
   value(){invocations++;return bounded}});
  Object.defineProperty(Uint8Array.prototype,Symbol.iterator,{
   configurable:true,writable:true,value:function*(){invocations++;yield* bounded}
  });
  try{inspect(unbounded)}catch(error){result=error}
 }finally{
  if(originalFrom)Object.defineProperty(Uint8Array,"from",originalFrom);
  else delete Uint8Array.from;
  if(originalIter)Object.defineProperty(Uint8Array.prototype,Symbol.iterator,originalIter);
  else delete Uint8Array.prototype[Symbol.iterator];
 }
 assert.match(String(result?.message),/memory requires fixed initial and maximum limits/);
 assert.equal(invocations,0);
});

test("Wasm ABI proof ignores poisoned array push and exported-name decoder methods",()=>{
 const originalPush=Object.getOwnPropertyDescriptor(Array.prototype,"push");
 const originalSlice=Object.getOwnPropertyDescriptor(Uint8Array.prototype,"subarray");
 const originalDecode=Object.getOwnPropertyDescriptor(TextDecoder.prototype,"decode");
 let invocations=0,goodError,badError;
 // Export name has same byte width so the mutated binary remains well formed.
 const wrongExport=new Uint8Array(bounded);
 wrongExport[27]=101;wrongExport[28]=118;
 wrongExport[29]=105;wrongExport[30]=108; // "evil", not "main"
 try{
  Object.defineProperty(Array.prototype,"push",{configurable:true,writable:true,
   value(){invocations++;throw Error("poisoned array push")}});
  Object.defineProperty(Uint8Array.prototype,"subarray",{configurable:true,writable:true,
   value(){invocations++;return bounded}});
  Object.defineProperty(TextDecoder.prototype,"decode",{configurable:true,writable:true,
   value(){invocations++;return "main"}});
  try{assertCoreI64Entry(bounded,"main")}catch(error){goodError=error}
  try{assertCoreI64Entry(wrongExport,"main")}catch(error){badError=error}
 }finally{
  if(originalPush)Object.defineProperty(Array.prototype,"push",originalPush);
  else delete Array.prototype.push;
  if(originalSlice)Object.defineProperty(Uint8Array.prototype,"subarray",originalSlice);
  else delete Uint8Array.prototype.subarray;
  if(originalDecode)Object.defineProperty(TextDecoder.prototype,"decode",originalDecode);
  else delete TextDecoder.prototype.decode;
 }
 assert.equal(goodError,undefined,"valid () -> i64 entry should survive prototype poisoning");
 assert.match(String(badError?.message),/core Wasm entry must have exact/);
 assert.equal(invocations,0,"ABI parser must use captured native intrinsics");
});

test("wrong core signature is rejected even when array push would forge i64",()=>{
 const wrongSig=new Uint8Array(bounded);
 wrongSig[14]=0x7f; // 0x7f i32 instead of 0x7e i64
 const prior=Object.getOwnPropertyDescriptor(Array.prototype,"push");
 let count=0,failure;
 try{
  Object.defineProperty(Array.prototype,"push",{configurable:true,writable:true,
   value(){count++;return 1}});
  try{assertCoreI64Entry(wrongSig,"main")}catch(error){failure=error}
 }finally{
  if(prior)Object.defineProperty(Array.prototype,"push",prior);
  else delete Array.prototype.push;
 }
 assert.match(String(failure?.message),/core Wasm entry must have exact/);
 assert.equal(count,0);
});

test("forged view prototypes and out-of-budget byte sources fail closed",()=>{
 const counterfeit=Object.create(Uint8Array.prototype);
 assert.throws(()=>inspect(counterfeit),/expected a Wasm ArrayBuffer or typed array/);
 const giant=new Uint8Array(1024);
 assert.throws(()=>inspectWasmBytes(giant,{maxModuleBytes:128,maxMemoryPages:2}),
  /maximum byte size/);
});
