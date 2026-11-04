import test from "node:test";
import assert from "node:assert/strict";
import {assertImportFreeSource as check} from "../scripts/import-admission.mjs";
const bytes = text => new TextEncoder().encode(text);

const accepted = [
  'fnc main():int{return 42;}',
  '// import fnc x from "+/bad";\nfnc main():int{return 42;}',
  '/* import */ fnc main():int{return 42;}',
  '/* import /* nested import */ */ fnc main():int{return 42;}',
  '"import fnc x from pkg:org/dep"',
  "'import something'",
  'importer imported imports my_import underscore_import',
  'fnc main():int{return 42;} // import',
  '"a\\\"import"',
  '"nested /* import */ source"',
  ''
];
for (const [i, source] of accepted.entries())
  test("non-import lexical source " + i, () => assert.doesNotThrow(() => check(bytes(source))));

const forms = ['+/root','+root','@/root','pkg:dep/file','./sibling','../parent','.hidden/file',
  '..backup/mod','module','common/util','C:\\foo'];
for (const form of forms)
  test("reject import " + form, () => assert.throws(
    () => check(bytes('import fnc x from "' + form + '";')),
    /verified native import graph/));

for (const source of ['/* unclosed', '/* outer /* inner */',
  '"unclosed', "'unclosed", '"bad\\', '"hello\\'])
  test("reject malformed lexical source " + source, () =>
    assert.throws(() => check(bytes(source)), /unterminated/));

for (const encoded of [[0xc0,0xaf],[0xff],[0xe2,0x82],[0xed,0xa0,0x80]])
  test("reject invalid utf8 " + encoded.join("-"), () =>
    assert.throws(() => check(Uint8Array.from(encoded)), /encoded|UTF-8|valid/i));

test("CR-only line comment cannot hide live import", () => {
  assert.throws(() => check(bytes('// allowed comment\rimport fnc x from "+/secret";')),
    /verified native import graph/);
  assert.doesNotThrow(() => check(bytes('// import from ignored\rfnc main():int{return 42;}')));
});
test("CRLF line comment handling", () => {
  assert.throws(() => check(bytes('// fake import\r\nimport fnc x from "pkg:d/f";')),
    /verified native import graph/);
});
test("reject NUL and oversized sources before compiler invocation", () => {
  assert.throws(() => check(bytes('fnc main():int{return 42;}\0')), /NUL/);
  assert.throws(() => check(new Uint8Array(1024*1024+1)), /1 MiB/);
  assert.throws(() => check("import"), /must be bytes/);
});

for (const boundary of ["\u0085", "\u2028", "\u2029"]) {
  test("Unicode line-separator import cannot hide in line comment U+" + boundary.charCodeAt(0).toString(16), () => {
    assert.throws(() => check(bytes('// hidden ' + boundary + 'import fnc x from "+/secret";')),
      /verified native import graph/);
    assert.doesNotThrow(() => check(bytes('// import ignored ' + boundary + 'fnc main():int{return 42;}')));
  });
}

test("block comment nesting is bounded before native scalar import scanning",()=>{
  assert.doesNotThrow(()=>check(bytes("/*".repeat(128)+"*/".repeat(128)+"fnc main():int{return 42;}")));
  assert.throws(()=>check(bytes("/*".repeat(129)+"*/".repeat(129))),/block comment nesting exceeded/);
  assert.throws(()=>check(bytes("/*".repeat(129)+"import fnc x from \"+/private\";"+ "*/".repeat(129))),/block comment nesting exceeded/);
});

test("shared mutable source cannot pass scalar import preflight",()=>{
  if(typeof SharedArrayBuffer !== "function")return;
  const source=new Uint8Array(new SharedArrayBuffer(128));
  assert.throws(()=>check(source),/cannot use shared memory/);
  // A forged .buffer property must not hide actual SharedArrayBuffer backing.
  Object.defineProperty(source,"buffer",{value:new ArrayBuffer(128)});
  assert.throws(()=>check(source),/cannot use shared memory/);
  assert.doesNotThrow(()=>check(bytes("fnc main():int{return 42;}")));
  assert.throws(()=>check(bytes('import fnc x from "+/private";')),
    /verified native import graph/);
});

test("spoofed byteLength cannot bypass preflight byte budget",()=>{
  const source=new Uint8Array(1024*1024+1);
  Object.defineProperty(source,"byteLength",{get(){return 1;}});
  assert.throws(()=>check(source),/1 MiB/);
});

test("UTF-8 BOM and embedded U+FEFF cannot conceal native imports",()=>{
  const sourceForms=[
    "\uFEFFimport fnc x from \"+/private\";",
    "/* safe */\uFEFFimport fnc x from \"pkg:private\";",
    "// safe\r\uFEFFimport fnc x from \"+/private\";",
    "\uFEFF// comment\nimport fnc x from \"+/private\";"
  ];
  for(const source of sourceForms)
    assert.throws(()=>check(bytes(source)),/verified native import graph/,JSON.stringify(source));
  assert.doesNotThrow(()=>check(bytes("\uFEFFfnc main():int{return 42;}")));
  assert.doesNotThrow(()=>check(bytes("/* safe */\uFEFFfnc main():int{return 42;}")));
});
