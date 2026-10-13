import test from "node:test";
import assert from "node:assert/strict";
import {canonicalReleaseMetadata,MAX_CANONICAL_RELEASE_BYTES} from "../scripts/canonical-release-json.mjs";
import {canonicalReleaseMetadata as atomicEncoder} from "../scripts/atomic-release.mjs";

function bytes(value){return canonicalReleaseMetadata(value).toString("utf8")}

test("canonical metadata encoder preserves the legacy byte format and API",()=>{
 const values=[
  null,true,false,0,-0,1.25,"hello","\\n","😀",
  [],[1,null,true,"😀"],{},{"a":1,"b":[false,null]},
  {schemaVersion:1,kind:"llvm-ores-to-wasm32-core-experimental",wasmBytes:42}
 ];
 for(let i=0;i<values.length;i++){
  const x=values[i],expected=JSON.stringify(x)+String.fromCharCode(10);
  assert.equal(bytes(x),expected);
  assert.deepEqual(canonicalReleaseMetadata(x),atomicEncoder(x));
 }
 assert.equal(bytes(Object.assign(Object.create(null),{a:1})),'{"a":1}'+String.fromCharCode(10));
});

test("canonical metadata enforces aggregate UTF-8 byte budget including trailing newline",()=>{
 const exact={k:"x".repeat(MAX_CANONICAL_RELEASE_BYTES-9)};
 assert.equal(canonicalReleaseMetadata(exact).length,MAX_CANONICAL_RELEASE_BYTES);
 assert.throws(()=>canonicalReleaseMetadata({k:"x".repeat(MAX_CANONICAL_RELEASE_BYTES-8)}),/byte budget/);
 assert.throws(()=>canonicalReleaseMetadata({k:"😀".repeat(5000)}),/byte budget/);
 assert.throws(()=>canonicalReleaseMetadata(Array(9000).fill(0)),/byte budget/);
 assert.throws(()=>canonicalReleaseMetadata({["k".repeat(16385)]:0}),/byte budget/);
 assert.equal(bytes({k:"😀"}),'{"k":"😀"}'+String.fromCharCode(10));
 assert.equal(bytes({k:"\uD800"}),'{"k":"\\\\ud800"}'+String.fromCharCode(10));
});

test("canonical metadata rejects callbacks, hidden authority, proxies and cycles",()=>{
 const getter={};let called=0;
 Object.defineProperty(getter,"x",{enumerable:true,get(){called++;throw Error("get trap")}});
 assert.throws(()=>canonicalReleaseMetadata(getter),/invalid canonical metadata field/);
 const hidden={x:1};
 Object.defineProperty(hidden,"private",{value:2});
 assert.throws(()=>canonicalReleaseMetadata(hidden),/hidden fields/);
 const symbol={x:1};symbol[Symbol("grant")]=true;
 assert.throws(()=>canonicalReleaseMetadata(symbol),/hidden fields/);
 const hole=Array(1);assert.throws(()=>canonicalReleaseMetadata(hole),/array properties/);
 const weird=[];Object.setPrototypeOf(weird,Object.create(Array.prototype));
 assert.throws(()=>canonicalReleaseMetadata(weird),/array prototype/);
 let proxyTraps=0;
 const proxy=new Proxy({x:1},{ownKeys(){proxyTraps++;throw Error("proxy trap")}});
 assert.throws(()=>canonicalReleaseMetadata(proxy),/invalid canonical metadata value/);
 assert.equal(proxyTraps,0);
 const cycle={};cycle.self=cycle;
 assert.throws(()=>canonicalReleaseMetadata(cycle),/nesting limit/);
 assert.equal(called,0);
});

test("canonical metadata is invariant under inherited method and serializer poisoning",()=>{
 const entries=[
  [Object.prototype,"toJSON",()=>{throw Error("prototype toJSON called")}],
  [Array.prototype,"toJSON",()=>{throw Error("array toJSON called")}],
  [Array.prototype,"join",()=>{throw Error("array join called")}],
  [Array.prototype,"every",()=>{throw Error("array every called")}],
  [Array.prototype,"includes",()=>{throw Error("array includes called")}],
  [Object,"hasOwn",()=>{throw Error("Object.hasOwn called")}],
  [JSON,"stringify",()=>{throw Error("JSON.stringify called")}],
  [Buffer,"byteLength",()=>{throw Error("Buffer.byteLength called")}],
  [Buffer.prototype,"write",()=>{throw Error("Buffer.write called")}]
 ];
 const old=[];
 try{
  for(let i=0;i<entries.length;i++){
   const [target,key,value]=entries[i];
   old[i]=Object.getOwnPropertyDescriptor(target,key);
   Object.defineProperty(target,key,{configurable:true,writable:true,value});
  }
  const result=canonicalReleaseMetadata({items:[1,2],note:"safe"});
  // Don't invoke assertions or formatting while poisoned; restores below.
  old.result=result;
 }finally{
  for(let i=entries.length-1;i>=0;i--){
   if(!(i in old))continue;
   const [target,key]=entries[i];
   if(old[i])Object.defineProperty(target,key,old[i]);
   else delete target[key];
  }
 }
 assert.equal(old.result.toString("utf8"),'{"items":[1,2],"note":"safe"}'+String.fromCharCode(10));
});

test("canonical bytes match JSON.stringify on deterministic nested inputs",()=>{
 let seed=0x9e3779b9;
 const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};
 const leaf=()=>{const p=rand()%7;return [null,true,false,rand()%1000,rand()%97/7,"ASCII","😀"][p]};
 function value(depth){
  if(depth<=0)return leaf();
  const n=rand()%5;
  if(n<=1)return leaf();
  if(n===2){const a=[];const count=rand()%4;for(let i=0;i<count;i++)a[i]=value(depth-1);return a}
  const obj={};const count=rand()%4;
  for(let i=0;i<count;i++)obj["key"+i]=value(depth-1);
  return obj;
 }
 for(let i=0;i<1000;i++){
  const candidate=value(4);
  assert.equal(bytes(candidate),JSON.stringify(candidate)+String.fromCharCode(10),
   "mismatch at deterministic sample "+i);
 }
});
