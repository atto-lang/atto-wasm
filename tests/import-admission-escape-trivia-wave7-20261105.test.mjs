import test from 'node:test';
import assert from 'node:assert/strict';
import {assertImportFreeSource as scan} from '../scripts/import-admission.mjs';

const check=source=>scan(new TextEncoder().encode(source));

test('quoted import tokens and nested comments are inert lexical data',()=>{
  assert.doesNotThrow(()=>check('let x = "import"; let y = \'import\';'));
  assert.doesNotThrow(()=>check('/* one /* import something */ two */ let x=5;'));
  assert.doesNotThrow(()=>check('let importer=5; let importable=7;'));
});

test('Unicode line terminators end comments; real import remains denied',()=>{
  for(const sep of [String.fromCharCode(0x85),String.fromCharCode(0x2028),String.fromCharCode(0x2029),'\n','\r']){
    assert.throws(()=>check('// import ignored'+sep+'import "+pkg"'),/imports require a verified native import graph/);
  }
  assert.throws(()=>check('import "+pkg"'),/imports require a verified native import graph/);
});

test('only the exact selected byte view counts; malformed source is rejected',()=>{
  const prefix=new TextEncoder().encode('import "+hidden";');
  const accepted=new TextEncoder().encode('let ok=5;');
  const buffer=new Uint8Array(prefix.length+accepted.length);
  buffer.set(prefix);
  buffer.set(accepted,prefix.length);
  assert.doesNotThrow(()=>scan(buffer.subarray(prefix.length)));
  assert.throws(()=>scan(buffer),/imports require a verified native import graph/);
  assert.throws(()=>scan(Uint8Array.of(0xc3,0x28)));
  assert.throws(()=>check('/* unterminated import'),/unterminated Oreslang block comment/);
});
