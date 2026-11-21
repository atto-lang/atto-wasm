import test from "node:test";
import assert from "node:assert/strict";
import {Buffer} from "node:buffer";
import {canonicalReleaseMetadata,MAX_CANONICAL_RELEASE_BYTES} from "../scripts/canonical-release-json.mjs";

const encode=canonicalReleaseMetadata;
test("canonical wire bytes preserve closed record order and LF",()=>{
 const x={schemaVersion:1,type:"release",arr:[],empty:null,yes:true,zero:0};
 assert.equal(encode(x).toString("utf8"),JSON.stringify(x)+"\n");
 assert.equal(encode(["a",22,false]).toString("utf8"),'["a",22,false]\n');
 assert.equal(MAX_CANONICAL_RELEASE_BYTES,16384);
});
test("UTF-8 byte budget includes the terminal LF and rejects dense input",()=>{
 assert.equal(encode({k:"x".repeat(16384-9)}).length,16384);
 assert.throws(()=>encode({k:"x".repeat(16384-8)}),/byte budget/);
 assert.throws(()=>encode({k:"😀".repeat(5000)}),/byte budget/);
 assert.throws(()=>encode({["k".repeat(16385)]:0}),/byte budget/);
 assert.throws(()=>encode(Array(9000).fill(0)),/byte budget/);
});
test("descriptor encoder does not invoke getters or admit hidden authority",()=>{
 let called=0;
 const getter={};
 Object.defineProperty(getter,"a",{enumerable:true,get(){called++;return "evil"}});
 assert.throws(()=>encode(getter),/field/);
 const hidden=[];
 Object.defineProperty(hidden,"secret",{value:1});
 assert.throws(()=>encode(hidden),/array properties/);
 const symbolic={x:1};
 Object.defineProperty(symbolic,Symbol("authority"),{value:"payload"});
 assert.throws(()=>encode(symbolic),/hidden fields/);
 const sparse=new Array(2);
 sparse[0]=4;
 assert.throws(()=>encode(sparse),/array properties/);
 assert.equal(called,0);
});
test("Proxy metadata is rejected without executing traps",()=>{
 let called=0;
 const trap=new Proxy({x:1},{get(){called++;throw Error("get")},
  ownKeys(){called++;throw Error("ownKeys")}});
 assert.throws(()=>encode(trap),/invalid canonical metadata value/);
 assert.equal(called,0);
});
test("post-import global builtin mutation cannot alter canonical bytes",()=>{
 const saved=[JSON.stringify,Object.keys,Object.getOwnPropertyDescriptor,
  Reflect.ownKeys,Array.isArray,Number.isFinite,Buffer.byteLength,
  Buffer.from,Buffer.alloc,Buffer.prototype.write,Uint8Array.prototype.subarray,
  Reflect.apply];
 let called=0;
 const poison=()=>{called++;throw Error("unexpected mutable intrinsic callback")};
 try{
  JSON.stringify=poison;Object.keys=poison;
  Object.getOwnPropertyDescriptor=poison;Reflect.ownKeys=poison;
  Array.isArray=poison;Number.isFinite=poison;Buffer.byteLength=poison;
  Buffer.from=poison;Buffer.alloc=poison;Buffer.prototype.write=poison;
  Uint8Array.prototype.subarray=poison;Reflect.apply=poison;
  const wire=encode({a:"value",n:7,empty:[]}).toString("utf8");
  if(wire!=='{"a":"value","n":7,"empty":[]}\n')throw Error("forged canonical bytes");
 }finally{
  [JSON.stringify,Object.keys,Object.getOwnPropertyDescriptor,
   Reflect.ownKeys,Array.isArray,Number.isFinite,Buffer.byteLength,
   Buffer.from,Buffer.alloc,Buffer.prototype.write,Uint8Array.prototype.subarray,
   Reflect.apply]=saved;
 }
 assert.equal(called,0);
});
test("inherited toJSON and Array.join are never invoked",()=>{
 const obj=Object.getOwnPropertyDescriptor(Object.prototype,"toJSON");
 const arr=Object.getOwnPropertyDescriptor(Array.prototype,"join");
 let called=0;
 try{
  Object.defineProperty(Object.prototype,"toJSON",{configurable:true,
   value(){called++;throw Error("inherited toJSON")}});
  Object.defineProperty(Array.prototype,"join",{configurable:true,
   value(){called++;return "FORGED"}});
  assert.equal(encode({x:[1,"two"],n:2}).toString("utf8"),
   '{"x":[1,"two"],"n":2}\n');
 }finally{
  if(obj)Object.defineProperty(Object.prototype,"toJSON",obj);
  else delete Object.prototype.toJSON;
  if(arr)Object.defineProperty(Array.prototype,"join",arr);
  else delete Array.prototype.join;
 }
 assert.equal(called,0);
});
test("canonical encoder refuses excessive depth and non-JSON values",()=>{
 const x={};let p=x;
 for(let i=0;i<17;i++){p.a={};p=p.a}
 assert.throws(()=>encode(x),/nesting limit/);
 assert.throws(()=>encode({x:Symbol("a")}),/invalid canonical metadata value/);
 assert.throws(()=>encode({x:Infinity}),/invalid canonical metadata value/);
 assert.throws(()=>encode({x:undefined}),/invalid canonical metadata value/);
});
test("1000 seeded records match native JSON bytes without inherited callbacks",()=>{
 let x=0x12345678;
 const random=()=>{x=(Math.imul(1664525,x)+1013904223)>>>0;return x};
 const alphabet=["a","\n","\\",'"',"ø","💎","\u0000","→"];
 for(let i=0;i<1000;i++){
  const n=random()%60;
  let value="";
  for(let j=0;j<n;j++)value+=alphabet[random()%alphabet.length];
  const record={i,contents:value,flag:!!(random()%2),
   nested:{name:"ok",count:random()%100},list:[random()%100,"\n"]};
  assert.deepEqual(encode(record),Buffer.from(JSON.stringify(record)+"\n"),
   "seeded record "+i);
 }
});


test("dense array index serialization ignores poisoned global String and safe-integer gate",()=>{
 const array=[0,"safe",null,true,{x:4},["nested"]];
 const expected='[0,"safe",null,true,{"x":4},["nested"]]\n';
 const originalString=Object.getOwnPropertyDescriptor(globalThis,"String");
 const originalSafeInteger=Object.getOwnPropertyDescriptor(Number,"isSafeInteger");
 let calls=0,actual;
 const poison=()=>{calls++;throw Error("mutable array serialization intrinsic invoked")};
 try{
  Object.defineProperty(globalThis,"String",{
   configurable:true,writable:true,value:poison});
  Object.defineProperty(Number,"isSafeInteger",{
   configurable:true,writable:true,value:poison});
  // Do not call test assertions or error formatting until globals are restored.
  actual=encode(array);
 }finally{
  if(originalString)Object.defineProperty(globalThis,"String",originalString);
  else delete globalThis.String;
  if(originalSafeInteger)Object.defineProperty(Number,"isSafeInteger",originalSafeInteger);
  else delete Number.isSafeInteger;
 }
 assert.equal(actual.toString("utf8"),expected);
 assert.equal(calls,0,"array metadata serialization must use captured intrinsics");
});
