import test from 'node:test';
import assert from 'node:assert/strict';
import {assertImportFreeSource} from '../scripts/import-admission.mjs';

const checked=text=>assertImportFreeSource(new TextEncoder().encode(text));

test('quoted import text, nested comments and lookalike names cannot trigger imports',()=>{
  for(const source of [
    'pub fnc main(): int { let label="import"; return 42; }',
    "pub fnc main(): int { let label='import'; return 42; }",
    '/* first /* import "+pkg" */ rest */ pub fnc main(): int { return 42; }',
    'pub fnc importer(): int { return 42; }'
  ]) assert.doesNotThrow(()=>checked(source),source);
});

test('NEL and paragraph separators terminate comments so live imports cannot hide',()=>{
  for(const separator of ['\u0085','\u2028','\u2029','\n','\r'])
    assert.throws(()=>checked('// ignored import'+separator+'import "+pkg"'),/source imports require a verified native import graph/);
});

test('unterminated and overly nested block comments fail before source admission',()=>{
  assert.throws(()=>checked('/* unterminated import'),/unterminated Oreslang block comment/);
  assert.throws(()=>checked('/*'.repeat(129)+'*/'.repeat(129)),/block comment nesting exceeded/);
  assert.throws(()=>checked('import "+pkg"'),/source imports require a verified native import graph/);
});
