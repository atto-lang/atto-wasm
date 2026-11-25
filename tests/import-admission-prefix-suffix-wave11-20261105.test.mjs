import test from 'node:test';
import assert from 'node:assert/strict';
import {assertImportFreeSource as scan} from '../scripts/import-admission.mjs';
const encoded=source=>new TextEncoder().encode(source);
test('substring identifiers and quoted import text are inert tokens',()=>{
  for(const s of ['let importer=1;', 'let preimport=1;', 'let imported=1;',
                  '"import +lib";', "'import +lib';", '/* import +lib */ let ok=1;'])
    assert.doesNotThrow(()=>scan(encoded(s)),s);
});
test('whitespace and line-separated live import keywords are always denied',()=>{
  for(const s of ['import +lib;', '  import +lib;', '\nimport +lib;', 
                   '/* safe */import +lib;', '// ignored\nimport +lib;'])
    assert.throws(()=>scan(encoded(s)),/imports require a verified native import graph/,s);
});
test('sliced byte views are inspected exactly and malformed source fails closed',()=>{
  const prefix=encoded('import +hidden;'),body=encoded('let safe=1;');
  const array=new Uint8Array(prefix.length+body.length);
  array.set(prefix);array.set(body,prefix.length);
  assert.doesNotThrow(()=>scan(array.subarray(prefix.length)));
  assert.throws(()=>scan(array),/imports require a verified native import graph/);
  assert.throws(()=>scan(Uint8Array.of(0xc3,0x28)));
  assert.throws(()=>scan(encoded('/* unclosed')), /unterminated Oreslang block comment/);
});
