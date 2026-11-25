import test from 'node:test';
import assert from 'node:assert/strict';
import {assertImportFreeSource as scan} from '../scripts/import-admission.mjs';

const bytes=text=>new TextEncoder().encode(text);

test('deep nested comments terminate at the exact enforced depth',()=>{
 const safe='/*'.repeat(128)+'import "hidden"'+'*/'.repeat(128)+' let ok = 1;';
 assert.doesNotThrow(()=>scan(bytes(safe)));
 const excess='/*'.repeat(129)+'*/'.repeat(129);
 assert.throws(()=>scan(bytes(excess)),/block comment nesting exceeded/);
});

test('quoted import, identifier aliases and comment trivia remain inert',()=>{
 assert.doesNotThrow(()=>scan(bytes('let importer=1; let importable=2;')));
 assert.doesNotThrow(()=>scan(bytes('let text="import \\"not alive\\"";')));
 assert.doesNotThrow(()=>scan(bytes('/* import \\"skip\\" */ let ok=1;')));
 assert.throws(()=>scan(bytes('/* ignored */ import "+pkg"')),/imports require a verified native import graph/);
});

test('Unicode line separators end comments and expose actual live imports',()=>{
 for(const ch of [String.fromCharCode(0x85),String.fromCharCode(0x2028),String.fromCharCode(0x2029),'\n','\r'])
  assert.throws(()=>scan(bytes('// ignored'+ch+'import "+pkg"')),/imports require a verified native import graph/);
});

test('offset byte views do not gain source access outside their declared span',()=>{
 const hidden=bytes('import "+secret"'),safe=bytes('let n=1;');
 const backing=new Uint8Array(hidden.length+safe.length);
 backing.set(hidden);backing.set(safe,hidden.length);
 assert.doesNotThrow(()=>scan(backing.subarray(hidden.length)));
 assert.throws(()=>scan(backing),/imports require a verified native import graph/);
 assert.throws(()=>scan(Uint8Array.of(0xc3,0x28)));
 assert.throws(()=>scan(new Uint8Array(1024*1024+1)),/1 MiB admission budget/);
});
