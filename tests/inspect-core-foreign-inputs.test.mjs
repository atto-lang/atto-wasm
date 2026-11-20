import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];

test('foreign primitive, JSON-array and precompiled-module inputs are refused',()=>{
 const compiled=new WebAssembly.Module(Uint8Array.from(header));
 for(const candidate of [null,undefined,false,0,'\0asm',header,{},new Set(header)])
  assert.throws(()=>inspectWasmBytes(candidate),/expected a Wasm ArrayBuffer or typed array/);
 assert.throws(()=>inspectWasmBytes(compiled),/precompiled WebAssembly.Module cannot be inspected/);
});

test('native typed-view slots defeat hostile shadow properties and iterator hooks',()=>{
 const view=Uint8Array.from(header);
 let observed=0;
 for(const name of ['byteLength','byteOffset','buffer'])
  Object.defineProperty(view,name,{get(){observed++;throw Error('host getter');}});
 Object.defineProperty(view,Symbol.iterator,{get(){observed++;throw Error('host iterator');}});
 const result=inspectWasmBytes(view,{maxModuleBytes:8});
 assert.equal(observed,0);
 assert.deepEqual([...result.bytes],header);
 view[1]=0;
 assert.equal(result.bytes[1],97,'verified snapshot remains immutable to caller mutation');
});

test('shared-backed native typed views cannot enter a source byte snapshot',()=>{
 if(typeof SharedArrayBuffer!=='function')return;
 const shared=new SharedArrayBuffer(8);
 new Uint8Array(shared).set(header);
 const view=new DataView(shared);
 Object.defineProperty(view,'buffer',{value:new ArrayBuffer(8)});
 assert.throws(()=>inspectWasmBytes(view),/shared Wasm input is not admitted/);
});
