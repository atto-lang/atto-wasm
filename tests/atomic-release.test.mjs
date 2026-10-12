import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm,chmod,mkdir,readdir,rename} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
import {publishAtomicRelease,readAtomicRelease} from "../scripts/atomic-release.mjs";

async function workspace(){
 const dir=await mkdtemp(join(tmpdir(),"oreslang-atomic-release-"));
 const compiler=join(dir,"compiler.sh"),source=join(dir,"program.ores");
 const script="#!/bin/sh\nprintf 'target triple = \"wasm32-unknown-unknown\"\\ndefine i64 @main() { ret i64 42 }\\n'\n";
 await writeFile(compiler,script,{mode:0o700});
 await chmod(compiler,0o700);
 await writeFile(source,"pub fnc main(): int { return 42; }\n");
 return {dir,compiler,source,output:join(dir,"guest.wasm")};
}
const execute=bytes=>(new WebAssembly.Instance(new WebAssembly.Module(bytes))).exports.main();
async function cleanup(dir){
 // Test teardown is allowed to remove the root; production release readers
 // never chmod or mutate sealed content.
 const entries=await readdir(dir,{withFileTypes:true});
 for(const entry of entries){
  if(!entry.isDirectory()||!entry.name.endsWith(".releases"))continue;
  const root=join(dir,entry.name);
  for(const sealed of await readdir(root,{withFileTypes:true})){
   if(sealed.isDirectory())await chmod(join(root,sealed.name),0o700);
  }
 }
 await rm(dir,{recursive:true,force:true});
}


test("atomic compilation publishes verified release, never partial legacy paths",async()=>{
 const w=await workspace();
 try{
  const r=await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const release=await readAtomicRelease(w.output);
  assert.equal(r.publication,"atomic");
  assert.equal(r.releaseSha256,release.releaseSha256);
  assert.equal(execute(release.wasm),42n);
  assert.equal(release.manifest.producer.sourceSha256,r.sourceSha256);
  assert.equal(release.provenance.wasmSha256,r.wasmSha256);
  await assert.rejects(readFile(w.output),/ENOENT/);
  await assert.rejects(readFile(w.output+".artifact.json"),/ENOENT/);
  await assert.rejects(readFile(w.output+".provenance.json"),/ENOENT/);
  const dirs=await readdir(w.output+".releases");
  assert.deepEqual(dirs,[r.releaseSha256]);
 }finally{await cleanup(w.dir)}
});

test("failed recompile cannot advance previous release pointer",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const before=await readFile(w.output+".current.json");
  const bad=join(w.dir,"broken.sh");
  await writeFile(bad,"#!/bin/sh\nexit 42\n",{mode:0o700});
  await assert.rejects(compileOresToWasm({...w,compiler:bad,
   environment:"browser",publication:"atomic"}),/command failed/);
  assert.deepEqual(await readFile(w.output+".current.json"),before);
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
 }finally{await cleanup(w.dir)}
});

test("concurrent verified publishers share the complete release, not partial sidecars",async()=>{
 const w=await workspace();
 try{
  const runs=await Promise.all(Array.from({length:3},()=>compileOresToWasm({
   ...w,environment:"browser",publication:"atomic"
  })));
  assert.equal(new Set(runs.map(x=>x.releaseSha256)).size,1);
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
  assert.deepEqual((await readdir(w.output+".releases")).sort(),[runs[0].releaseSha256]);
 }finally{await cleanup(w.dir)}
});

test("tampered sealed bytes and forged current pointers fail closed",async()=>{
 const w=await workspace();
 try{
  const r=await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const release=await readAtomicRelease(w.output);
  const path=join(release.directory,"provenance.json");
  await chmod(path,0o600);
  await writeFile(path,'{"wasmSha256":"0"}\n');
  await assert.rejects(readAtomicRelease(w.output),/release content mutated/);
  await assert.rejects(publishAtomicRelease({
   output:w.output,wasm:release.wasm,manifest:release.manifest,provenance:release.provenance
  }),/release content mutated/);
  await chmod(w.output+".current.json",0o600);
  await writeFile(w.output+".current.json",JSON.stringify({
   schemaVersion:1,releaseSha256:"0".repeat(64)
  })+"\n");
  await assert.rejects(readAtomicRelease(w.output));
  assert.match(r.releaseSha256,/^[0-9a-f]{64}$/);
 }finally{await cleanup(w.dir)}
});

test("corrupt staged metadata never publishes a pointer",async()=>{
 const w=await workspace();
 try{
  await assert.rejects(publishAtomicRelease({
   output:w.output,wasm:Uint8Array.from([0,97,115,109,1,0,0,0]),
   provenance:{wasmSha256:"0".repeat(64)}
  }),/invalid provenance digest/);
  await assert.rejects(readFile(w.output+".current.json"),/ENOENT/);
  assert.equal((await readdir(w.dir)).some(x=>x.startsWith(".oreslang-pointer-")),false);
 }finally{await cleanup(w.dir)}
});
