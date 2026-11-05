import test from 'node:test';
import assert from 'node:assert/strict';
import {assertImportFreeSource} from '../scripts/import-admission.mjs';

test('the 1 MiB source admission ceiling is inclusive and enforced before decoding',()=>{
  assert.doesNotThrow(()=>assertImportFreeSource(new Uint8Array(1024*1024).fill(32)));
  assert.throws(()=>assertImportFreeSource(new Uint8Array(1024*1024+1).fill(32)),/1 MiB admission budget/);
});

test('selected typed-array view excludes untrusted import tokens outside its range',()=>{
  const encoder=new TextEncoder();
  const source='pub fnc main(): int { return 42; }';
  const before=encoder.encode('import "+private"; ');
  const middle=encoder.encode(source);
  const after=encoder.encode(' import "+hidden";');
  const combined=new Uint8Array(before.length+middle.length+after.length);
  combined.set(before,0);combined.set(middle,before.length);combined.set(after,before.length+middle.length);
  assert.doesNotThrow(()=>assertImportFreeSource(combined.subarray(before.length,before.length+middle.length)));
  assert.throws(()=>assertImportFreeSource(combined),/source imports require a verified native import graph/);
});

test('typed bytes are read from native slots without invoking shadowed getters or iterators',()=>{
  const bytes=new TextEncoder().encode('pub fnc main(): int { return 42; }');
  let invoked=0;
  Object.defineProperty(bytes,'buffer',{get(){invoked++;throw Error('untrusted buffer getter');}});
  Object.defineProperty(bytes,Symbol.iterator,{get(){invoked++;throw Error('untrusted iterator getter');}});
  assert.doesNotThrow(()=>assertImportFreeSource(bytes));
  assert.equal(invoked,0);
});

test('fake and shared byte containers fail closed before importer permission could be granted',()=>{
  assert.throws(()=>assertImportFreeSource(Object.create(Uint8Array.prototype)),/genuine Uint8Array bytes/);
  if(typeof SharedArrayBuffer==='function')
    assert.throws(()=>assertImportFreeSource(new Uint8Array(new SharedArrayBuffer(8))),/cannot use shared memory/);
  assert.throws(()=>assertImportFreeSource(Uint8Array.of(0xc3,0x28)),/./);
});
