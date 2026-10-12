import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,chmod,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {assertCoreI64Entry} from "../scripts/core-i64-abi.mjs";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const section=(id,body)=>[id,body.length,...body];
const name=s=>[s.length,...new TextEncoder().encode(s)];
const wasm=(returnType=0x7e,memoryMaximum=2)=>Uint8Array.from([
 0,97,115,109,1,0,0,0,
 ...section(1,[1,0x60,0,1,returnType]),
 ...section(3,[1,0]),
 ...section(5,[1,1,2,memoryMaximum]),
 ...section(7,[2,...name("main"),0,0,...name("memory"),2,0]),
 ...section(10,[1,4,0,returnType===0x7e?0x42:0x41,42,0x0b])
]);

test("post-link ABI verifier accepts only real zero-arg i64 export",()=>{
 const valid=wasm();
 assert.equal(WebAssembly.validate(valid),true);
 assert.doesNotThrow(()=>assertCoreI64Entry(valid,"main"));
 const bad=wasm(0x7f);
 assert.equal(WebAssembly.validate(bad),true);
 assert.throws(()=>assertCoreI64Entry(bad,"main"),/exact \(\) -> i64/);
});

test("bridge refuses valid Wasm i32 export even when compiler IR advertises i64",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ores-wasm-abi-"));
 try{
  const source=join(dir,"guest.ores"),compiler=join(dir,"compiler.mjs"),
   clang=join(dir,"clang.mjs"),output=join(dir,"guest.wasm");
  await writeFile(source,"pub fnc main(): int { return 42; }\n");
  await writeFile(compiler,[
   "#!/usr/bin/env node",
   "process.stdout.write("+JSON.stringify("target triple = \"wasm32-unknown-unknown\"\ndefine i64 @main() { ret i64 42 }\n")+");"
  ].join("\n"),{mode:0o700});
  const incorrect=Array.from(wasm(0x7f));
  await writeFile(clang,[
   "#!/usr/bin/env node",
   "import {writeFileSync} from \"node:fs\";",
   "const args=process.argv.slice(2);",
   "if(args.includes(\"--version\")){process.stdout.write(\"mock clang\\n\");process.exit(0)}",
   "const index=args.indexOf(\"-o\");",
   "if(index<0)process.exit(17);",
   "writeFileSync(args[index+1],Uint8Array.from("+JSON.stringify(incorrect)+"));"
  ].join("\n"),{mode:0o700});
  await chmod(compiler,0o700);await chmod(clang,0o700);
  await assert.rejects(compileOresToWasm({source,compiler,clang,output,environment:"browser"}),
   /exact \(\) -> i64/);
  await assert.rejects(readFile(output),/ENOENT/);
  await assert.rejects(readFile(output+".artifact.json"),/ENOENT/);
  await assert.rejects(readFile(output+".provenance.json"),/ENOENT/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("bridge refuses valid Wasm with wrong memory maximum even when IR advertises i64",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ores-wasm-abi-"));
 try{
  const source=join(dir,"guest.ores"),compiler=join(dir,"compiler.mjs"),
   clang=join(dir,"clang.mjs"),output=join(dir,"guest.wasm");
  await writeFile(source,"pub fnc main(): int { return 42; }\n");
  await writeFile(compiler,[
   "#!/usr/bin/env node",
   "process.stdout.write("+JSON.stringify("target triple = \"wasm32-unknown-unknown\"\ndefine i64 @main() { ret i64 42 }\n")+");"
  ].join("\n"),{mode:0o700});
  const incorrect=Array.from(wasm(0x7e,3));
  await writeFile(clang,[
   "#!/usr/bin/env node",
   "import {writeFileSync} from \"node:fs\";",
   "const args=process.argv.slice(2);",
   "if(args.includes(\"--version\")){process.stdout.write(\"mock clang\\n\");process.exit(0)}",
   "const index=args.indexOf(\"-o\");",
   "if(index<0)process.exit(17);",
   "writeFileSync(args[index+1],Uint8Array.from("+JSON.stringify(incorrect)+"));"
  ].join("\n"),{mode:0o700});
  await chmod(compiler,0o700);await chmod(clang,0o700);
  await assert.rejects(compileOresToWasm({source,compiler,clang,output,environment:"browser"}),
   /linear memory exceeds host budget/);
  await assert.rejects(readFile(output),/ENOENT/);
  await assert.rejects(readFile(output+".artifact.json"),/ENOENT/);
  await assert.rejects(readFile(output+".provenance.json"),/ENOENT/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("duplicate CLI flags cannot silently replace compiler or source provenance",()=>{
 const script=new URL("../scripts/compile-ores.mjs",import.meta.url).pathname;
 for(const option of ["compiler","source","output","compiler-sha256"]){
  const args=["--"+option+"=/first","--"+option+"=/second"];
  const result=spawnSync(process.execPath,[script,...args],{encoding:"utf8"});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/duplicate CLI option/);
 }
});
