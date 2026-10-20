import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

test("FIFO compiler/source paths fail promptly without publishing Wasm or sidecars",{
 skip:process.platform==="win32"
},async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ores-wasm-nonblocking-input-"));
 try{
  const source=join(dir,"source.ores"),compiler=join(dir,"compiler.sh");
  const output=join(dir,"guest.wasm");
  const bridgeUrl=new URL("../scripts/compile-ores.mjs",import.meta.url).href;
  for(const kind of ["source","compiler"]){
   await rm(source,{force:true});await rm(compiler,{force:true});
   if(kind==="source")await writeFile(compiler,"#!/bin/sh\nexit 0\n",{mode:0o700});
   else await writeFile(source,"pub fnc main(): int { return 42; }\n");
   const fifo=kind==="source"?source:compiler;
   const mk=spawnSync("mkfifo",[fifo],{timeout:2000,encoding:"utf8"});
   assert.equal(mk.error,undefined,"mkfifo must be available in Linux CI");
   assert.equal(mk.status,0,"unable to create FIFO: "+mk.stderr);
   // The child has its own process deadline. Accidentally using blocking
   // open(path,"r") can never stall the entire test runner indefinitely.
   const code=[
    "import {compileOresToWasm} from "+JSON.stringify(bridgeUrl)+";",
    "try { await compileOresToWasm("+JSON.stringify({compiler,source,output})+"); process.exitCode=12; }",
    "catch(e) { if(!/not a regular file|ELOOP|EAGAIN/.test(String(e.message))) process.exitCode=13;",
    'else console.log("EXPECTED_FIFO_REFUSAL"); }'
   ].join("\n");
   const child=spawnSync(process.execPath,["--input-type=module","-e",code],{
    timeout:3000,encoding:"utf8"
   });
   assert.equal(child.error,undefined,kind+" must not hang: "+child.error?.message);
   assert.equal(child.status,0,kind+" error: "+child.stderr+" "+child.stdout);
   assert.match(child.stdout,/EXPECTED_FIFO_REFUSAL/);
   for(const suffix of ["",".provenance.json",".artifact.json"])
    await assert.rejects(readFile(output+suffix),{code:"ENOENT"});
  }
 }finally{await rm(dir,{recursive:true,force:true})}
});
