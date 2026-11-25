import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCoreI64Entry} from '../scripts/core-i64-abi.mjs';

const section=(id,body)=>[id,body.length,...body];
const encodedName=name=>[...new TextEncoder().encode(name)];
function core(name,resultType=0x7e){
  const bytes=encodedName(name);
  return Uint8Array.from([0,97,115,109,1,0,0,0,
    ...section(1,[1,0x60,0,1,resultType]),
    ...section(3,[1,0]),
    ...section(7,[1,bytes.length,...bytes,0,0]),
    ...section(10,[1,4,0,resultType===0x7e?0x42:0x41,42,0x0b])
  ]);
}

test('leading BOM remains part of the UTF-8 export name, never silently stripped',()=>{
  const bom='\uFEFFmain';
  const wasm=core(bom);
  assert.equal(WebAssembly.validate(wasm),true);
  assert.doesNotThrow(()=>assertCoreI64Entry(wasm,bom));
  assert.throws(()=>assertCoreI64Entry(wasm,'main'),/exact \(\) -> i64 signature/);
});

test('plain name, name case, and output ABI are checked independently',()=>{
  const wasm=core('main');
  assert.equal(WebAssembly.validate(wasm),true);
  assert.doesNotThrow(()=>assertCoreI64Entry(wasm,'main'));
  assert.throws(()=>assertCoreI64Entry(wasm,'\uFEFFmain'),/exact \(\) -> i64 signature/);
  assert.throws(()=>assertCoreI64Entry(wasm,'Main'),/exact \(\) -> i64 signature/);
  const wrong=core('main',0x7f);
  assert.equal(WebAssembly.validate(wrong),true);
  assert.throws(()=>assertCoreI64Entry(wrong,'main'),/exact \(\) -> i64 signature/);
});
