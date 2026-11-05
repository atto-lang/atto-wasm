import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const magic=[0,97,115,109,1,0,0,0];
const wrap=()=>Uint8Array.from([255,254,253,252,...magic,251,250,249,248]);

const cases=()=>{
 const u8=wrap();const u16=wrap();const i32=wrap();const dv=wrap();
 const big=Uint8Array.from([0,0,0,0,0,0,0,0,...magic]);
 return [
  ['Uint8Array',new Uint8Array(u8.buffer,4,8),u8],
  ['Uint16Array',new Uint16Array(u16.buffer,4,4),u16],
  ['Int32Array',new Int32Array(i32.buffer,4,2),i32],
  ['DataView',new DataView(dv.buffer,4,8),dv],
  ['BigInt64Array',new BigInt64Array(big.buffer,8,1),big]
 ];
};

test('five intrinsic view shapes snapshot nonzero native offsets without aliasing',()=>{
 for(const [name,view,backing] of cases()){
  const parsed=inspectWasmBytes(view,{maxModuleBytes:8});
  assert.deepEqual(Array.from(parsed.bytes),magic,name);
  assert.equal(parsed.memoryCount,0,name);
  backing[name==='BigInt64Array'?9:5]=0;
  assert.equal(parsed.bytes[1],97,name+' must own admitted bytes');
 }
});

test('hostile own getters and iterators never override native source view slots',()=>{
 for(const [name,view] of cases()){
  let invoked=0;
  for(const field of ['buffer','byteOffset','byteLength'])
   Object.defineProperty(view,field,{get(){invoked++;throw Error('unsafe '+field);}});
  Object.defineProperty(view,Symbol.iterator,{get(){invoked++;throw Error('unsafe iterator');}});
  assert.deepEqual(Array.from(inspectWasmBytes(view,{maxModuleBytes:8}).bytes),magic,name);
  assert.equal(invoked,0,name);
 }
});

test('shared-backed typed views are denied even with spoofed public backing',()=>{
 if(typeof SharedArrayBuffer!=='function')return;
 const sab=new SharedArrayBuffer(16);new Uint8Array(sab,4,8).set(magic);
 for(const view of [new Uint8Array(sab,4,8),new Uint16Array(sab,4,4),new DataView(sab,4,8)]){
  Object.defineProperty(view,'buffer',{value:new ArrayBuffer(16)});
  assert.throws(()=>inspectWasmBytes(view,{maxModuleBytes:8}),/shared Wasm input is not admitted/);
 }
});
