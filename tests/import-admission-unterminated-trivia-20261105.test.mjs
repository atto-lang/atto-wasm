import test from 'node:test';
import assert from 'node:assert/strict';
import {assertImportFreeSource} from '../scripts/import-admission.mjs';

const encode=s=>new TextEncoder().encode(s);
const check=s=>assertImportFreeSource(encode(s));
// Scalar host scanner only; does not compile or execute an .atto guest.
test('unterminated and nested block comments cannot hide unverified imports',()=>{
 for(const source of ['/* unterminated','/* outer /* inner */','/* safe */ /* dangling']){
  assert.throws(()=>check(source),/unterminated Oreslang block comment/,source);
 }
 check('/* outer /* import fnc private */ safe */ fnc main(): int { return 42; }');
});
test('quoted literal escapes must terminate and cannot reveal import tokens',()=>{
 for(const source of ["'not closed",'"not closed',"'dangling\\"]){
  assert.throws(()=>check(source),/unterminated Oreslang/,source);
 }
 check('"\\\"import fnc hidden"');
 check("'escaped\\' import' fnc main():int{return 42;}");
});
test('live import following closed trivia is denied',()=>{
 for(const source of [
  '/* import ignored */ import module Secret from "+/secret";',
  '// import ignored\rimport fnc Secret from "pkg:secret";',
  '/* outer /* inner */ */\nimport fnc Secret from "pkg:secret";'
 ])assert.throws(()=>check(source),/verified native import graph/,source);
});
