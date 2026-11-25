import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,chmod,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
import {assertImportFreeSource} from "../scripts/import-admission.mjs";
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
test("canonical .atto input keeps its suffix at the native compiler boundary",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"oreslang-atto-stage-test-"));
 try{
  const compiler=join(dir,"suffix-compiler.sh");
  const source=join(dir,"scalar.atto");
  const output=join(dir,"scalar.wasm");
  const script=[
   "#!/bin/sh",
   'case "$1" in',
   "  *.atto) printf 'define i64 @main() { ret i64 42 }\\n' ;;",
   "  *) exit 81 ;;",
   "esac",
   ""
  ].join("\n");
  await writeFile(compiler,script,{mode:0o700});
  await writeFile(source,"pub fnc main(): int { return 42; }\n");
  const result=await compileOresToWasm({compiler,source,output});
  assert.equal(result.importCount,0);
  const wasm=await readFile(output);
  assert.equal(WebAssembly.validate(wasm),true);
  assert.equal(new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports.main(),42n);
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


test("scalar Wasm import admission ignores comments and literals, rejects real imports",()=>{
 const encoder=new TextEncoder();
 const accepts=[
  "pub fnc main():int { return 42; }",
  ["// import fnc fake from \"@/ghost\";","pub fnc main():int{return 42;}"].join(String.fromCharCode(10)),
  "/* import fake /* nested import */ end */ pub fnc main():int{return 42;}",
  "pub fnc main():int { let s=\"import fnc x from pkg:y/z\"; return 42; }",
  "pub fnc main():int { let s='import from'; return 42; }",
  "pub fnc main():int { let imported=42; return imported; }"
 ];
 for(const source of accepts)assert.doesNotThrow(()=>assertImportFreeSource(encoder.encode(source)));
 for(const path of ["./local","../parent","@/root","pkg:alias/source",".hidden/file","my/module"])
  assert.throws(()=>assertImportFreeSource(encoder.encode('import fnc run from "'+path+'";')),/verified native import graph/);
 for(const bad of ["/* unterminated", "'unterminated", '"unterminated', String.fromCharCode(34)+"bad"+String.fromCharCode(92)])
  assert.throws(()=>assertImportFreeSource(encoder.encode(bad)),/unterminated/);
 assert.throws(()=>assertImportFreeSource(Uint8Array.of(0xc0,0xaf)),/encoded|UTF-8/i);
});
test("stub compiler cannot publish Wasm from import-bearing source",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-import-reject-"));
 try {
  const compiler=join(dir,"stub.sh"),source=join(dir,"source.ores"),output=join(dir,"guest.wasm");
  await writeFile(compiler,["#!/bin/sh","printf \"define i64 @main() { ret i64 42 }\""].join(String.fromCharCode(10)),{mode:0o700});
  await writeFile(source,['import fnc helper from "@/lib/helper";','pub fnc main():int{return 42;}'].join(String.fromCharCode(10)));
  await assert.rejects(
    ()=>compileOresToWasm({compiler,source,output}),
    /verified native import graph/
  );
  await assert.rejects(()=>readFile(output),/ENOENT/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("canonical .ATTO source suffix is preserved instead of downgraded to .ores",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"oreslang-uppercase-atto-stage-"));
 try{
  const compiler=join(dir,"suffix-stub.sh"),source=join(dir,"hello.ATTO"),output=join(dir,"upper.wasm");
  await writeFile(compiler,[
   "#!/bin/sh",
   'case "$1" in',
   "  *.atto) printf 'define i64 @main() { ret i64 42 }\\n' ;;",
   "  *) exit 81 ;;",
   "esac",""
  ].join("\n"),{mode:0o700});
  await writeFile(source,"pub fnc main(): int { return 42; }\n");
  const record=await compileOresToWasm({compiler,source,output});
  assert.equal(record.importCount,0);
  const module=new WebAssembly.Module(await readFile(output));
  assert.equal(new WebAssembly.Instance(module).exports.main(),42n);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("unknown source extensions are rejected before stub compiler invocation",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"oreslang-suffix-reject-"));
 try{
  const marker=join(dir,"compiler-invoked"),compiler=join(dir,"fake.sh"),output=join(dir,"bad.wasm");
  await writeFile(compiler,["#!/bin/sh",'touch "'+marker+'"',"exit 0",""].join("\n"),{mode:0o700});
  for(const name of ["guest.txt","guest.atto.bak","guest","guest.py"]){
   const source=join(dir,name);
   await writeFile(source,"pub fnc main(): int { return 42; }\n");
   await assert.rejects(()=>compileOresToWasm({compiler,source,output}),/canonical .*atto.*ores/);
  }
  await assert.rejects(()=>readFile(marker),/ENOENT/);
  await assert.rejects(()=>readFile(output),/ENOENT/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
