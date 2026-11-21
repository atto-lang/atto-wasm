import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,chmod,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
import {readAtomicRelease,inspectAtomicReleaseState} from "../scripts/atomic-release.mjs";
import {fileURLToPath} from "node:url";
const hash=b=>createHash("sha256").update(b).digest("hex");
test("real Clang wasm32 bridge accepts verified IR and records hashes (stub compiler only)",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-bridge-test-"));
 try{
  const compiler=join(dir,"stub-compiler.sh"),source=join(dir,"source.ores"),output=join(dir,"app.wasm");
  const stub="#!/bin/sh\nprintf 'define i64 @main() { ret i64 42 }\\n'\n";
  await writeFile(compiler,stub,{mode:0o700});
  await chmod(compiler,0o700);
  await writeFile(source,"pub fnc main(): int { return 42; }\n");
  const pin=hash(await readFile(compiler));
  const r=await compileOresToWasm({compiler,source,output,compilerSha256:pin});
  assert.equal(r.compilerSha256,pin);
  assert.equal(r.importCount,0);
  assert.equal(r.kind,"llvm-ores-to-wasm32-core-experimental");
  const wasm=await readFile(output);
  assert.equal(WebAssembly.validate(wasm),true);
  assert.equal((new WebAssembly.Instance(new WebAssembly.Module(wasm))).exports.main(),42n);
  assert.equal(JSON.parse(await readFile(output+".provenance.json","utf8")).wasmSha256,hash(wasm));
  await assert.rejects(()=>compileOresToWasm({compiler,source,output:join(dir,"bad.wasm"),compilerSha256:"0".repeat(64)}),/SHA-256/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test("real native Oreslang compiler integration, opt-in and never simulated",{
 skip:!process.env.ORESLANG_LLVM_COMPILER
},async()=>{
 const dir=await mkdtemp(join(tmpdir(),"oreslang-real-llvm-wasm-"));
 try{
  const compiler=process.env.ORESLANG_LLVM_COMPILER;
  const source=new URL("../examples/native-int.ores",import.meta.url).pathname;
  const output=join(dir,"real-oreslang-guest.wasm");
  const r=await compileOresToWasm({compiler,source,output,
   compilerSha256:process.env.ORESLANG_LLVM_COMPILER_SHA256});
  assert.equal(r.importCount,0);
  const bytes=await readFile(output);
  assert.equal((new WebAssembly.Instance(new WebAssembly.Module(bytes))).exports.main(),42n);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("real pinned Oreslang LLVM compiler seals, verifies, executes and preserves rollback",
 {skip:!process.env.ORESLANG_LLVM_COMPILER,timeout:120000},async()=>{
 const compiler=process.env.ORESLANG_LLVM_COMPILER;
 const pin=process.env.ORESLANG_LLVM_COMPILER_SHA256;
 assert.match(pin||"",/^[0-9a-f]{64}$/,"real LLVM compiler must have a pinned SHA-256");
 const dir=await mkdtemp(join(tmpdir(),"oreslang-real-atomic-roundtrip-"));
 try{
  const output=join(dir,"guest.wasm");
  const cases=[
   [fileURLToPath(new URL("../examples/native-int.ores",import.meta.url)),42n],
   [fileURLToPath(new URL("../tests/fixtures/native-int-43.ores",import.meta.url)),43n]
  ];
  let previous=null;
  for(const [source,expected] of cases){
   const result=await compileOresToWasm({
    compiler,source,output,compilerSha256:pin,
    environment:"browser",publication:"atomic"
   });
   assert.equal(result.publication,"atomic");
   assert.equal(result.compilerSha256,pin);
   const verified=await readAtomicRelease(output);
   assert.equal(verified.releaseSha256,result.releaseSha256);
   assert.equal(verified.provenance.wasmSha256,hash(verified.wasm));
   assert.equal(verified.manifest.wasmSha256,verified.provenance.wasmSha256);
   assert.equal(verified.manifest.producer.compilerSha256,pin);
   assert.equal(verified.provenance.sourceSha256,hash(await readFile(source)));
   assert.equal(verified.manifest.producer.sourceSha256,verified.provenance.sourceSha256);
   assert.equal(verified.manifest.producer.llvmIrSha256,verified.provenance.llvmIrSha256);
   assert.equal(verified.provenance.importCount,0);
   assert.equal((new WebAssembly.Instance(new WebAssembly.Module(verified.wasm))).exports.main(),expected);
   const state=await inspectAtomicReleaseState(output);
   assert.equal(state.current,verified.releaseSha256);
   assert.deepEqual(state.invalid,[]);
   assert.deepEqual(state.staging,[]);
   if(previous){
    assert.notEqual(previous,verified.releaseSha256);
    assert.ok(state.unreferenced.includes(previous),
     "previous sealed guest must remain recoverable for in-flight readers");
   }
   previous=verified.releaseSha256;
  }
  const pointer=await readFile(output+".current.json");
  await assert.rejects(compileOresToWasm({
   compiler,source:cases[0][0],output,compilerSha256:"0".repeat(64),
   environment:"browser",publication:"atomic"
  }),/compiler binary SHA-256 does not match pinned hash/);
  assert.deepEqual(await readFile(output+".current.json"),pointer,
   "rejected compiler must never replace the selected release");
  assert.equal((new WebAssembly.Instance(
   new WebAssembly.Module((await readAtomicRelease(output)).wasm))).exports.main(),43n);
  await assert.rejects(readFile(output),/ENOENT/,
   "atomic publishing must not leave a legacy executable sidecar");
 }finally{await rm(dir,{recursive:true,force:true})}
});


test("compiler bridge resists poisoned native SHA-256 prototype methods",{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),"oreslang-sha-bridge-"));
 try{
  const compiler=join(dir,"compiler.sh"),source=join(dir,"main.ores");
  const output=join(dir,"guest.wasm");
  const script="#!/bin/sh\nprintf 'target triple = \"wasm32-unknown-unknown\"\\ndefine i64 @main() { ret i64 42 }\\n'\n";
  await writeFile(compiler,script,{mode:0o700});
  await chmod(compiler,0o700);
  await writeFile(source,"pub fnc main(): int { return 42; }\n");
  const pin=hash(await readFile(compiler));
  const bridgeURL=new URL("../scripts/compile-ores.mjs",import.meta.url).href;
  const childSource=[
   "import {compileOresToWasm} from "+JSON.stringify(bridgeURL)+";",
   "import {createHash} from 'node:crypto';",
   "const hashProto=Object.getPrototypeOf(createHash('sha256'));",
   "const originalUpdate=Object.getOwnPropertyDescriptor(hashProto,'update');",
   "const originalDigest=Object.getOwnPropertyDescriptor(hashProto,'digest');",
   "let callbacks=0,result;",
   "try{",
   " Object.defineProperty(hashProto,'update',{configurable:true,writable:true,",
   "  value(){callbacks++;return this}});",
   " Object.defineProperty(hashProto,'digest',{configurable:true,writable:true,",
   "  value(){callbacks++;return 'f'.repeat(64)}});",
   " result=await compileOresToWasm({compiler:"+JSON.stringify(compiler)+",",
   "  source:"+JSON.stringify(source)+",output:"+JSON.stringify(output)+",",
   "  compilerSha256:"+JSON.stringify(pin)+",publication:'atomic',environment:'browser'});",
   "}finally{",
   " Object.defineProperty(hashProto,'update',originalUpdate);",
   " Object.defineProperty(hashProto,'digest',originalDigest);",
   "}",
   "if(callbacks!==0)throw Error('poisoned bridge SHA callbacks: '+callbacks);",
   "process.stdout.write(result.wasmSha256+'\\n');"
  ].join("\n");
  const child=spawnSync(process.execPath,["--input-type=module","--eval",childSource],
   {encoding:"utf8",timeout:30000});
  assert.equal(child.status,0,"bridge used poisoned SHA methods: "+String(child.stderr));
  const wasm=await readFile(join(output+".releases",
   JSON.parse(await readFile(output+".current.json","utf8")).releaseSha256,
   "guest.wasm"));
  assert.equal(child.stdout.trim(),hash(wasm));
  assert.equal(WebAssembly.validate(wasm),true);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("bridge native ABI admission resists poisoned WebAssembly and Stats",{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),"oreslang-admission-bridge-"));
 try{
  const compiler=join(dir,"compiler.sh"),source=join(dir,"main.ores");
  const output=join(dir,"guest.wasm");
  const script="#!/bin/sh\nprintf 'target triple = \"wasm32-unknown-unknown\"\\ndefine i64 @main() { ret i64 42 }\\n'\n";
  await writeFile(compiler,script,{mode:0o700});
  await chmod(compiler,0o700);
  await writeFile(source,"pub fnc main(): int { return 42; }\n");
  const pin=hash(await readFile(compiler));
  const bridgeURL=new URL("../scripts/compile-ores.mjs",import.meta.url).href;
  const lines=[
   "import {compileOresToWasm} from "+JSON.stringify(bridgeURL)+";",
   "import {Stats} from 'node:fs';",
   "const actualModule=WebAssembly.Module;",
   "const oldModule=Object.getOwnPropertyDescriptor(WebAssembly,'Module');",
   "const oldValidate=Object.getOwnPropertyDescriptor(WebAssembly,'validate');",
   "const oldImports=Object.getOwnPropertyDescriptor(actualModule,'imports');",
   "const oldExports=Object.getOwnPropertyDescriptor(actualModule,'exports');",
   "const oldIsFile=Object.getOwnPropertyDescriptor(Stats.prototype,'isFile');",
   "let callbacks=0,result;",
   "const poison=()=>{callbacks++;throw Error('mutable admission callback invoked')};",
   "try{",
   " Object.defineProperty(WebAssembly,'Module',{configurable:true,writable:true,value:poison});",
   " Object.defineProperty(WebAssembly,'validate',{configurable:true,writable:true,value:poison});",
   " Object.defineProperty(actualModule,'imports',{configurable:true,writable:true,value:poison});",
   " Object.defineProperty(actualModule,'exports',{configurable:true,writable:true,value:poison});",
   " Object.defineProperty(Stats.prototype,'isFile',{configurable:true,writable:true,value:poison});",
   " result=await compileOresToWasm({compiler:"+JSON.stringify(compiler)+",",
   "  source:"+JSON.stringify(source)+",output:"+JSON.stringify(output)+",",
   "  compilerSha256:"+JSON.stringify(pin)+",publication:'atomic',environment:'browser'});",
   "}finally{",
   " Object.defineProperty(WebAssembly,'Module',oldModule);",
   " Object.defineProperty(WebAssembly,'validate',oldValidate);",
   " Object.defineProperty(actualModule,'imports',oldImports);",
   " Object.defineProperty(actualModule,'exports',oldExports);",
   " if(oldIsFile)Object.defineProperty(Stats.prototype,'isFile',oldIsFile);",
   " else delete Stats.prototype.isFile;",
   "}",
   "if(callbacks!==0)throw Error('poisoned native admission invoked: '+callbacks);",
   "process.stdout.write(result.wasmSha256+'\\n');"
  ].join("\n");
  const child=spawnSync(process.execPath,["--input-type=module","--eval",lines],
   {encoding:"utf8",timeout:30000});
  assert.equal(child.status,0,"bridge dispatched mutable Wasm or Stats methods: "+String(child.stderr));
  const id=JSON.parse(await readFile(output+".current.json","utf8")).releaseSha256;
  const wasm=await readFile(join(output+".releases",id,"guest.wasm"));
  assert.equal(child.stdout.trim(),hash(wasm));
  assert.equal((new WebAssembly.Instance(new WebAssembly.Module(wasm))).exports.main(),42n);
 }finally{await rm(dir,{recursive:true,force:true})}
});
