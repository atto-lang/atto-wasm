import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const cli=new URL("../scripts/compile-ores.mjs",import.meta.url);
test("CLI rejects duplicate compiler, source, output, hash and toolchain options before publication",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ores-bridge-cli-policy-"));
 try{
  const compiler=join(dir,"compiler"),source=join(dir,"source.ores"),output=join(dir,"out.wasm");
  await writeFile(compiler,"#!/bin/sh\nexit 0\n",{mode:0o700});
  await writeFile(source,"pub fnc main(): int { return 42; }\n");
  const args=[
   "--compiler="+compiler,"--source="+source,"--output="+output,
   "--compiler-sha256="+"0".repeat(64),"--environment=browser",
   "--export=main","--clang=clang"
  ];
  const duplicateValues=[
   "--compiler="+join(dir,"evil-compiler"),
   "--source="+join(dir,"evil-source"),
   "--output="+join(dir,"out-injected.wasm"),
   "--compiler-sha256="+"f".repeat(64),
   "--environment=edge-wasi",
   "--export=other",
   "--clang="+join(dir,"evil-clang")
  ];
  for(const duplicate of duplicateValues){
   const option=duplicate.slice(2,duplicate.indexOf("="));
   const proc=spawnSync(process.execPath,[cli.pathname,...args,duplicate],{
    encoding:"utf8",timeout:3000
   });
   assert.equal(proc.error,undefined,"CLI must terminate: "+proc.error?.message);
   assert.equal(proc.status,1,"duplicate "+option+" must not compile");
   assert.match(proc.stderr,new RegExp("duplicate CLI option: "+option));
   for(const suffix of ["",".provenance.json",".artifact.json"])
    await assert.rejects(readFile(output+suffix),{code:"ENOENT"});
  }
 }finally{await rm(dir,{recursive:true,force:true})}
});
