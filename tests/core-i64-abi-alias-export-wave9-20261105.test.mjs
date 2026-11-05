import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCoreI64Entry} from '../scripts/core-i64-abi.mjs';

const header=[0,97,115,109,1,0,0,0];
const sec=(id,body)=>[id,body.length,...body];
function make(nameBytes=[109,97,105,110],kind=0,index=[0],ret=0x7e) {
  return Uint8Array.from([...header,
    ...sec(1,[1,0x60,0,1,ret]),
    ...sec(3,[1,0]),
    ...sec(7,[1,nameBytes.length,...nameBytes,kind,...index]),
    ...sec(10,[1,4,0,ret===0x7e?0x42:0x41,42,0x0b])]);
}

test('valid canonical main export satisfies the narrow core-i64 ABI', () => {
  const wasm=make();
  assert.equal(WebAssembly.validate(wasm),true);
  assert.doesNotThrow(()=>assertCoreI64Entry(wasm,'main'));
});

test('an export whose spelling differs by case cannot act as main', () => {
  assert.throws(()=>assertCoreI64Entry(make([77,97,105,110]),'main'),/exact \(\) -> i64 signature/);
});

test('nonminimal export index encoding is rejected at the ABI boundary', () => {
  assert.throws(()=>assertCoreI64Entry(make(undefined,0,[0x80,0]),'main'),/noncanonical Wasm ABI integer/);
});

test('out-of-range function index never resolves a different entry', () => {
  assert.throws(()=>assertCoreI64Entry(make(undefined,0,[3]),'main'),/exact \(\) -> i64 signature/);
});

test('entry export must be a function with an i64 result', () => {
  assert.throws(()=>assertCoreI64Entry(make(undefined,2,[0]),'main'),/not a function/);
  assert.throws(()=>assertCoreI64Entry(make(undefined,0,[0],0x7f),'main'),/exact \(\) -> i64 signature/);
});

test('truncated export-name storage is rejected before name comparison', () => {
  const truncated=Uint8Array.from([...header,...sec(1,[1,0x60,0,1,0x7e]),
    ...sec(3,[1,0]),7,4,1,4,109,97]);
  assert.throws(()=>assertCoreI64Entry(truncated,'main'),/malformed Wasm ABI export name/);
});
