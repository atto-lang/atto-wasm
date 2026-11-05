import test from 'node:test';
import assert from 'node:assert/strict';
import {assertImportFreeSource as scan} from '../scripts/import-admission.mjs';

const text=s=>new TextEncoder().encode(s);

test('offset typed source view cannot read adjacent hidden import tokens',()=>{
 const prefix=text('import "+hidden";'),good=text('let value=5;'),bytes=new Uint8Array(prefix.length+good.length);
 bytes.set(prefix);bytes.set(good,prefix.length);
 assert.doesNotThrow(()=>scan(bytes.subarray(prefix.length)));
 assert.throws(()=>scan(bytes),/imports require a verified native import graph/);
});

test('spoofed instance buffer/length accessors do not execute or widen admission',()=>{
 const bytes=text('let value=42;');let calls=0;
 Object.defineProperty(bytes,'buffer',{get(){calls++;throw Error('spoofed buffer');}});
 Object.defineProperty(bytes,'byteLength',{get(){calls++;throw Error('spoofed length');}});
 assert.doesNotThrow(()=>scan(bytes));
 assert.equal(calls,0);
});

test('NUL, invalid UTF-8 and actual imports after nested comments fail closed',()=>{
 assert.throws(()=>scan(Uint8Array.of(0xc3,0x28)));
 assert.throws(()=>scan(text('let foo=0;'+String.fromCharCode(0)+'import foo')),/NUL byte/);
 assert.throws(()=>scan(text('/* ignored /* hidden import */ */ import "+src"')),/imports require a verified native import graph/);
});

test('shared byte backing and invalid non-view arguments cannot cross source gate',()=>{
 assert.throws(()=>scan([1,2,3]),/source must be bytes/);
 if(typeof SharedArrayBuffer==='function'){
  const view=new Uint8Array(new SharedArrayBuffer(8));
  assert.throws(()=>scan(view),/cannot use shared memory/);
 }
});
