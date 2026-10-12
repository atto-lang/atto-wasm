import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const source=process.env.ORE_ACTOR_SOURCE;
const mandatory=process.env.ORE_REQUIRE_REAL_ACTOR==="1";
if(mandatory&&(!compiler||!source))
 throw Error("required source-level actor compiler input is unconfigured");

test("actor ABI options fail closed before file reads or publication",async()=>{
 await assert.rejects(compileOresToWasm({
  compiler:"/nonexistent/compiler",source:"/nonexistent/source",
  output:"/nonexistent/output",actorName:"Counter-evil",environment:"browser"
 }),/valid actor name/);
 await assert.rejects(compileOresToWasm({
  compiler:"/nonexistent/compiler",source:"/nonexistent/source",
  output:"/nonexistent/output",actorName:"Counter",environment:"edge-wasi"
 }),/browser environment/);
});

test("real LLVM-compiled source actor persists state only within one Wasm instance",{
 skip:!compiler||!source
},async()=>{
 const folder=await mkdtemp(join(tmpdir(),"ores-wasm-actor-bridge-"));
 try{
  const output=join(folder,"actor.wasm");
  const binary=await readFile(resolve(compiler));
  const record=await compileOresToWasm({
   compiler:resolve(compiler),source:resolve(source),output,
   actorName:"Counter",environment:"browser",
   compilerSha256:createHash("sha256").update(binary).digest("hex")
  });
  assert.equal(record.actorName,"Counter");
  const manifest=JSON.parse(await readFile(output+".artifact.json","utf8"));
  assert.equal(manifest.artifactType,"oreslang.core-wasm.actor-i64-v1");
  assert.deepEqual(manifest.actor,{
   name:"Counter",init:"oreslang_actor_Counter_init",
   onMessage:"oreslang_actor_Counter_on_message",
   messageShape:"I",instancesPerActor:1
  });
  const module=new WebAssembly.Module(await readFile(output));
  assert.equal(WebAssembly.Module.imports(module).length,0);
  const a=new WebAssembly.Instance(module),b=new WebAssembly.Instance(module);
  a.exports.oreslang_actor_Counter_init();
  assert.equal(a.exports.oreslang_actor_Counter_on_message(2n),12n);
  assert.equal(a.exports.oreslang_actor_Counter_on_message(3n),15n);
  b.exports.oreslang_actor_Counter_init();
  assert.equal(b.exports.oreslang_actor_Counter_on_message(1n),11n);
  assert.equal(a.exports.oreslang_actor_Counter_on_message(1n),16n);
 }finally{await rm(folder,{recursive:true,force:true})}
});
