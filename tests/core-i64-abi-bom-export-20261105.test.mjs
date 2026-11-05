import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCoreI64Entry} from '../scripts/core-i64-abi.mjs';

const section=(id,bytes)=>[id,bytes.length,...bytes];
function fixture(name,result=0x7e){
  const label=[...new TextEncoder().encode(name)];
  return Uint8Array.from([0,97,115,109,1,0,0,0,
    ...section(1,[1,0x60,0,1,result]),
    ...section(3,[1,0]),
    ...section(7,[1,label.length,...label,0,0]),
    ...section(10,[1,4,0,0x42,0,0x0b])]);
}
test('U+FEFF remains part of the exported function name',()=>{
  const bytes=fixture('\uFEFFrun');
  assert.equal(WebAssembly.validate(bytes),true);
  assert.equal(assertCoreI64Entry(bytes,'\uFEFFrun'),undefined);
  assert.throws(()=>assertCoreI64Entry(bytes,'run'),/exact \(\) -> i64/);
});
test('padded varuint32 section length cannot alias canonical ABI metadata',()=>{
  const bytes=fixture('measure');
  const padded=Uint8Array.from([...bytes.slice(0,9),0x85,0,...bytes.slice(10)]);
  assert.throws(()=>assertCoreI64Entry(padded,'measure'),/noncanonical/);
});
test('wrong i32 return and truncated section cannot attest an i64 entry',()=>{
  assert.throws(()=>assertCoreI64Entry(fixture('measure',0x7f),'measure'),/exact \(\) -> i64/);
  assert.throws(()=>assertCoreI64Entry(fixture('measure').slice(0,12),'measure'),/truncated|exact \(\) -> i64/);
});
