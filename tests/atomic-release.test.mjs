import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawn,spawnSync} from "node:child_process";
import {mkdtemp,writeFile,readFile,rm,chmod,mkdir,readdir,rename,symlink,unlink,link} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
import {publishAtomicRelease,readAtomicRelease,inspectAtomicReleaseState,AtomicReleaseCommitUncertainError,canonicalReleaseMetadata} from "../scripts/atomic-release.mjs";

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
  }),/invalid producer record/);
  await assert.rejects(readFile(w.output+".current.json"),/ENOENT/);
  assert.equal((await readdir(w.dir)).some(x=>x.startsWith(".oreslang-pointer-")),false);
 }finally{await cleanup(w.dir)}
});

test("atomic publisher refuses coexistence with stale legacy sidecars",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,environment:"browser",publication:"legacy"});
  await assert.rejects(compileOresToWasm({
   ...w,environment:"browser",publication:"atomic"
  }),/legacy and atomic artifact publications cannot share/);
  await assert.rejects(readFile(w.output+".current.json"),/ENOENT/);
 }finally{await cleanup(w.dir)}
});

test("legacy publisher refuses coexistence with an installed atomic pointer",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const before=await readFile(w.output+".current.json");
  await assert.rejects(compileOresToWasm({
   ...w,environment:"browser",publication:"legacy"
  }),/legacy and atomic artifact publications cannot share/);
  assert.deepEqual(await readFile(w.output+".current.json"),before);
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
 }finally{await cleanup(w.dir)}
});

test("competing distinct verified source releases never mix metadata",async()=>{
 const w=await workspace();
 try{
  const other=join(w.dir,"other.ores");
  await writeFile(other,"pub fnc main(): int { return 40 + 2; }\n");
  const [first,second]=await Promise.all([
   compileOresToWasm({...w,environment:"browser",publication:"atomic"}),
   compileOresToWasm({...w,source:other,environment:"browser",publication:"atomic"})
  ]);
  assert.notEqual(first.releaseSha256,second.releaseSha256);
  const published=await readAtomicRelease(w.output);
  assert.ok([first.releaseSha256,second.releaseSha256].includes(published.releaseSha256));
  assert.ok([first.sourceSha256,second.sourceSha256].includes(published.provenance.sourceSha256));
  assert.equal(published.manifest.producer.sourceSha256,published.provenance.sourceSha256);
  assert.equal(execute(published.wasm),42n);
 }finally{await cleanup(w.dir)}
});

test("signed matching hashes alone cannot admit malformed or incompatible Wasm",async()=>{
 const w=await workspace();
 try{
  const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
  const invalid=Uint8Array.from([0,97,115,109,1,0,0,0,5]);
  const i32=Uint8Array.from([
   0,97,115,109,1,0,0,0,1,5,1,0x60,0,1,0x7f,
   3,2,1,0,7,8,1,4,109,97,105,110,0,0,
   10,6,1,4,0,0x41,42,0x0b
  ]);
  for(const [bytes,message] of [[invalid,/invalid executable Wasm/],
    [i32,/invalid core i64 entry ABI|invalid bounded 2-page guest memory/]]){
   const h=sha(bytes);
   const producer={schemaVersion:1,kind:"llvm-ores-to-wasm32-core-experimental",
     compilerSha256:"1".repeat(64),sourceSha256:"2".repeat(64),
     llvmIrSha256:"3".repeat(64),wasmSha256:h,
     wasmBytes:bytes.length,exportName:"main",importCount:0,
     clangVersion:"fixture-clang-verified",note:"ABl negative test; valid v1 metadata"};
   await assert.rejects(publishAtomicRelease({output:w.output,
     wasm:bytes,provenance:producer}),message);
   await assert.rejects(readFile(w.output+".current.json"),/ENOENT/);
  }
 }finally{await cleanup(w.dir)}
});

test("browser manifest cannot downgrade memory or request host capabilities",async()=>{
 const w=await workspace();
 try{
  const published=await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const release=await readAtomicRelease(w.output);
  const pointer=await readFile(w.output+".current.json");
  for(const manifest of [
    {...release.manifest,memory:{maximumPages:3}},
    {...release.manifest,requiredCapabilities:["net"]},
    {...release.manifest,entry:"other"},
    {...release.manifest,imports:[{module:"env",name:"host"}]}
  ]){
   await assert.rejects(publishAtomicRelease({output:w.output,
     wasm:release.wasm,manifest,provenance:release.provenance}),
     /inconsistent manifest provenance/);
   assert.deepEqual(await readFile(w.output+".current.json"),pointer);
  }
  assert.equal(published.releaseSha256,(await readAtomicRelease(w.output)).releaseSha256);
 }finally{await cleanup(w.dir)}
});

test("racing legacy and atomic publishers cannot commit both formats",async()=>{
 const w=await workspace();
 try{
  const outcome=await Promise.allSettled([
   compileOresToWasm({...w,environment:"browser",publication:"atomic"}),
   compileOresToWasm({...w,environment:"browser",publication:"legacy"})
  ]);
  assert.equal(outcome.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(outcome.filter(x=>x.status==="rejected").length,1);
  assert.match(String(outcome.find(x=>x.status==="rejected").reason),
    /legacy and atomic artifact publications cannot share/);
  if(outcome[0].status==="fulfilled"){
   assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
   await assert.rejects(readFile(w.output),/ENOENT/);
  }else{
   assert.equal(execute(await readFile(w.output)),42n);
   await assert.rejects(readFile(w.output+".current.json"),/ENOENT/);
  }
  await assert.rejects(readFile(w.output+".publication.lock"),/ENOENT/);
 }finally{await cleanup(w.dir)}
});

test("an existing publication lock fails closed instead of stealing it",async()=>{
 const w=await workspace();
 try{
  await mkdir(w.output+".publication.lock");
  await assert.rejects(
   compileOresToWasm({...w,publication:"atomic",environment:"browser"}),
   /artifact publication lock unavailable/
  );
  await assert.rejects(readFile(w.output+".current.json"),/ENOENT/);
 }finally{await cleanup(w.dir)}
});

test("crash recovery reports orphaned stage without deleting it",async()=>{
 const w=await workspace();
 try{
  const stage=join(w.output+".releases",".staging-abandoned");
  await mkdir(stage,{recursive:true});
  await writeFile(join(stage,"guest.wasm"),"incomplete");
  const report=await inspectAtomicReleaseState(w.output);
  assert.equal(report.current,null);
  assert.deepEqual(report.staging,[".staging-abandoned"]);
  assert.deepEqual(report.unreferenced,[]);
  assert.equal((await readFile(join(stage,"guest.wasm"),"utf8")),"incomplete");
  const release=await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const next=await inspectAtomicReleaseState(w.output);
  assert.equal(next.current,release.releaseSha256);
  assert.deepEqual(next.staging,[".staging-abandoned"]);
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
 }finally{await cleanup(w.dir)}
});

test("recovery retains previous valid releases while pointer selects new one",async()=>{
 const w=await workspace();
 try{
  const first=await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const changed=join(w.dir,"changed.ores");
  await writeFile(changed,"pub fnc main(): int { return 41 + 1; }\n");
  const second=await compileOresToWasm({...w,source:changed,environment:"browser",publication:"atomic"});
  const report=await inspectAtomicReleaseState(w.output);
  assert.equal(report.current,second.releaseSha256);
  assert.deepEqual(report.unreferenced,[first.releaseSha256]);
  assert.deepEqual(report.invalid,[]);
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
  const releaseNames=await readdir(w.output+".releases");
  assert.ok(releaseNames.includes(first.releaseSha256));
  assert.ok(releaseNames.includes(second.releaseSha256));
 }finally{await cleanup(w.dir)}
});

test("duplicate-key or noncanonical current pointer never selects a release",async()=>{
 const w=await workspace();
 try{
  const release=await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const pointer=w.output+".current.json";
  const canonical=await readFile(pointer,"utf8");
  await chmod(pointer,0o600);
  for(const malformed of [
   JSON.stringify({schemaVersion:1,releaseSha256:"0".repeat(64),
      other:"unexpected"})+"\n",
   '{"schemaVersion":1,"releaseSha256":"'+release.releaseSha256+
     '","releaseSha256":"'+release.releaseSha256+'"}\n',
   JSON.stringify({releaseSha256:release.releaseSha256,schemaVersion:1})+"\n"
  ]){
   await writeFile(pointer,malformed);
   await assert.rejects(readAtomicRelease(w.output));
  }
  await writeFile(pointer,canonical);
  assert.equal((await readAtomicRelease(w.output)).releaseSha256,release.releaseSha256);
 }finally{await cleanup(w.dir)}
});

test("canonical release seal rejects duplicate keys and alternate encodings",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const release=await readAtomicRelease(w.output);
  const sealPath=join(release.directory,"seal.json");
  const good=await readFile(sealPath,"utf8");
  await chmod(sealPath,0o600);
  const bad=[
   good.replace('{"schemaVersion":1,','{"schemaVersion":1,"schemaVersion":1,'),
   good.replace('{"schemaVersion":1,','{ "schemaVersion":1,'),
   good.replace(',"type":"oreslang.atomic-release-v1"',',"type":"oreslang.atomic-release-v1","type":"oreslang.atomic-release-v1"'),
   good.replace('{"schemaVersion":1,"type":"oreslang.atomic-release-v1",','{"type":"oreslang.atomic-release-v1","schemaVersion":1,'),
   good.replace('"fileHashes":{"wasm":','"fileHashes":{"wasm":"'+release.releaseSha256+'","wasm":')
  ];
  for(const malformed of bad){
   assert.notEqual(malformed,good);
   await writeFile(sealPath,malformed);
   await assert.rejects(readAtomicRelease(w.output),/noncanonical release seal/);
  }
  await writeFile(sealPath,good);
  const restored=await readAtomicRelease(w.output);
  assert.equal(restored.releaseSha256,release.releaseSha256);
  assert.equal(execute(restored.wasm),42n);
 }finally{await cleanup(w.dir)}
});

test("strict atomic metadata admission matches closed schema and refuses extra authority",async()=>{
 const w=await workspace();
 try{
  const baseline=await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const release=await readAtomicRelease(w.output);
  const previous=await readFile(w.output+".current.json");
  const extraProducers=[
   {...release.provenance,untrusted:true},
   {...release.provenance,importCount:1},
   {...release.provenance,clangVersion:""},
   {...release.provenance,note:42},
   {...release.provenance,note:"x".repeat(1025)},
  ];
  for(const provenance of extraProducers){
   await assert.rejects(publishAtomicRelease({
    output:w.output,wasm:release.wasm,manifest:release.manifest,provenance
   }),/invalid producer record/);
   assert.deepEqual(await readFile(w.output+".current.json"),previous);
  }
  const badManifests=[
   {...release.manifest,hostCapabilityGrants:["net"]},
   {...release.manifest,producer:{...release.manifest.producer,debugMode:true}},
   {...release.manifest,memory:{maximumPages:2,unbounded:true}},
   {...release.manifest,entry:"m".repeat(129)},
   {...release.manifest,requiredCapabilities:{"0":"net",length:0}},
  ];
  for(const manifest of badManifests){
   await assert.rejects(publishAtomicRelease({
    output:w.output,wasm:release.wasm,manifest,provenance:release.provenance
   }),/inconsistent manifest provenance/);
   assert.deepEqual(await readFile(w.output+".current.json"),previous);
  }
  assert.equal((await readAtomicRelease(w.output)).releaseSha256,baseline.releaseSha256);
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
 }finally{await cleanup(w.dir)}
});

test("failure before pointer rename keeps the previous release selected",async()=>{
 const w=await workspace();
 try{
  const first=await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const alternateSource=join(w.dir,"next-source.ores");
  await writeFile(alternateSource,"pub fnc main(): int { return 40 + 2; }\n");
  const secondOutput=join(w.dir,"alternate.wasm");
  await compileOresToWasm({...w,source:alternateSource,output:secondOutput,
    environment:"browser",publication:"atomic"});
  const alt=await readAtomicRelease(secondOutput);
  assert.notEqual(first.releaseSha256,alt.releaseSha256);
  const prior=await readFile(w.output+".current.json");
  await assert.rejects(publishAtomicRelease({
   output:w.output,wasm:alt.wasm,manifest:alt.manifest,provenance:alt.provenance,
   __testAfterReleaseInstall:()=>{throw Error("simulated pre-pointer failure")}
  }),/simulated pre-pointer failure/);
  assert.deepEqual(await readFile(w.output+".current.json"),prior);
  const inventory=await inspectAtomicReleaseState(w.output);
  assert.equal(inventory.current,first.releaseSha256);
  assert.ok(inventory.unreferenced.includes(alt.releaseSha256));
 }finally{await cleanup(w.dir)}
});

test("post-rename sync failure reports uncertain commit, never ordinary abort",async()=>{
 const w=await workspace();
 try{
  const first=await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const altSource=join(w.dir,"alt.ores");
  await writeFile(altSource,"pub fnc main(): int { return 41 + 1; }\n");
  const altOutput=join(w.dir,"alt.wasm");
  await compileOresToWasm({...w,source:altSource,output:altOutput,
    environment:"browser",publication:"atomic"});
  const second=await readAtomicRelease(altOutput);
  assert.notEqual(first.releaseSha256,second.releaseSha256);
  await assert.rejects(publishAtomicRelease({
   output:w.output,wasm:second.wasm,manifest:second.manifest,
   provenance:second.provenance,
   __testAfterPointerRename:()=>{throw Error("simulated pointer-parent fsync failure")}
  }),error=>{
   assert.ok(error instanceof AtomicReleaseCommitUncertainError);
   assert.equal(error.code,"ATOMIC_RELEASE_COMMIT_UNCERTAIN");
   assert.equal(error.releaseSha256,second.releaseSha256);
   assert.equal(error.pointer,w.output+".current.json");
   assert.equal(error.mayBePublished,true);
   assert.match(String(error.cause),/simulated pointer-parent fsync failure/);
   return true;
  });
  // The pointer was visible despite the returned error. A caller must inspect,
  // not assume rollback or retry a non-idempotent external side effect.
  assert.equal((await readAtomicRelease(w.output)).releaseSha256,second.releaseSha256);
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
 }finally{await cleanup(w.dir)}
});


test("cleanup failure after durable commit returns success with explicit warning",async()=>{
 const w=await workspace();
 try{
  const baseline=await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const previous=(await readFile(w.output+".current.json")).toString("utf8");
  const checked=await readAtomicRelease(w.output);
  const result=await publishAtomicRelease({
   output:w.output,wasm:checked.wasm,
   manifest:checked.manifest,provenance:checked.provenance,
   __testBeforeCleanup:()=>{throw Error("injected temporary-directory cleanup failure")}
  });
  assert.equal(result.releaseSha256,baseline.releaseSha256);
  assert.equal(result.cleanupWarning.code,"ATOMIC_RELEASE_POST_COMMIT_CLEANUP_FAILED");
  assert.match(result.cleanupWarning.message,/injected temporary-directory cleanup failure/);
  assert.equal((await readFile(w.output+".current.json")).toString("utf8"),previous);
  assert.equal((await readAtomicRelease(w.output)).releaseSha256,baseline.releaseSha256);
  const inventory=await inspectAtomicReleaseState(w.output);
  assert.equal(inventory.current,baseline.releaseSha256);
  assert.ok(inventory.staging.some(name=>name.startsWith(".staging-")));
 }finally{await cleanup(w.dir)}
});


test("integration: strict schema admission survives uncertain and confirmed publication",async()=>{
 const w=await workspace();
 try{
  const first=await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const alternateSource=join(w.dir,"integrated-next.ores");
  await writeFile(alternateSource,"pub fnc main(): int { return 41 + 1; }\n");
  const alternateOutput=join(w.dir,"integrated-next.wasm");
  await compileOresToWasm({...w,source:alternateSource,output:alternateOutput,
   environment:"browser",publication:"atomic"});
  const next=await readAtomicRelease(alternateOutput);
  const oldPointer=await readFile(w.output+".current.json");
  assert.notEqual(first.releaseSha256,next.releaseSha256);
  await assert.rejects(publishAtomicRelease({
   output:w.output,wasm:next.wasm,provenance:next.provenance,
   manifest:{...next.manifest,requiredCapabilities:[],unexpectedHostAuthority:true},
   __testAfterPointerRename:()=>{throw Error("must never reach rename")}
  }),/inconsistent manifest provenance/);
  assert.deepEqual(await readFile(w.output+".current.json"),oldPointer);
  await assert.rejects(publishAtomicRelease({
   output:w.output,wasm:next.wasm,provenance:next.provenance,
   manifest:next.manifest,
   __testAfterPointerRename:()=>{throw Error("injected unconfirmed durability")}
  }),error=>{
   assert.ok(error instanceof AtomicReleaseCommitUncertainError);
   assert.equal(error.code,"ATOMIC_RELEASE_COMMIT_UNCERTAIN");
   assert.equal(error.releaseSha256,next.releaseSha256);
   return true;
  });
  // Current visibility is a verified release, not a power-loss durability
  // guarantee. No external operation or blind retry is performed here.
  const recovered=await readAtomicRelease(w.output);
  assert.equal(recovered.releaseSha256,next.releaseSha256);
  assert.deepEqual(recovered.manifest,next.manifest);
  assert.equal(execute(recovered.wasm),42n);
  const confirmed=await publishAtomicRelease({
   output:w.output,wasm:next.wasm,manifest:next.manifest,
   provenance:next.provenance,
   __testBeforeCleanup:()=>{throw Error("injected cleanup failure")}
  });
  assert.equal(confirmed.releaseSha256,next.releaseSha256);
  assert.equal(confirmed.cleanupWarning.code,"ATOMIC_RELEASE_POST_COMMIT_CLEANUP_FAILED");
  const state=await inspectAtomicReleaseState(w.output);
  assert.equal(state.current,next.releaseSha256);
  assert.ok(state.unreferenced.includes(first.releaseSha256));
  assert.ok(state.staging.length>0);
 }finally{await cleanup(w.dir)}
});


test("SIGKILL at five publication barriers never selects an incomplete release",async()=>{
 const moduleURL=new URL("../scripts/atomic-release.mjs",import.meta.url).href;
 for(const checkpoint of [
  "__testAfterReleaseRename",
  "__testAfterReleaseInstall",
  "__testBeforePointerRename",
  "__testAfterPointerRename",
  "__testBeforeCleanup"
 ]){
  const w=await workspace();
  try{
   const initial=await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
   const alternateSource=join(w.dir,"crash-next.ores");
   await writeFile(alternateSource,"pub fnc main(): int { return 40 + 2; }\n");
   const alternateOutput=join(w.dir,"crash-next.wasm");
   await compileOresToWasm({...w,source:alternateSource,output:alternateOutput,
    publication:"atomic",environment:"browser"});
   const alternate=await readAtomicRelease(alternateOutput);
   assert.notEqual(alternate.releaseSha256,initial.releaseSha256);
   const options={
    output:w.output,releaseOutput:alternateOutput,checkpoint,moduleURL
   };
   const childSource=[
    "import {readAtomicRelease,publishAtomicRelease} from "+JSON.stringify(options.moduleURL)+";",
    "const alt=await readAtomicRelease("+JSON.stringify(options.releaseOutput)+");",
    "await publishAtomicRelease({output:"+JSON.stringify(options.output)+",",
    "wasm:alt.wasm,manifest:alt.manifest,provenance:alt.provenance,",
    JSON.stringify(options.checkpoint)+":()=>{process.kill(process.pid,'SIGKILL')}", 
    "});",
   ].join("\n");
   const child=spawnSync(process.execPath,["--input-type=module","--eval",childSource],
    {timeout:30000,encoding:"utf8"});
   assert.equal(child.signal,"SIGKILL",
    checkpoint+": child did not terminate at checkpoint; stderr="+child.stderr);
   const verified=await readAtomicRelease(w.output);
   // All three earlier barriers predate the pointer's rename/visibility.
   const beforeRename=[
    "__testAfterReleaseRename",
    "__testAfterReleaseInstall",
    "__testBeforePointerRename"
   ].includes(checkpoint);
   assert.equal(verified.releaseSha256,
    beforeRename?initial.releaseSha256:alternate.releaseSha256);
   assert.equal(execute(verified.wasm),42n);
   assert.deepEqual(verified.manifest.producer, 
    (beforeRename?await readAtomicRelease(w.output):alternate).manifest.producer);
   const inventory=await inspectAtomicReleaseState(w.output);
   assert.equal(inventory.current,verified.releaseSha256);
   assert.deepEqual(inventory.invalid,[]);
   if(beforeRename)assert.ok(inventory.unreferenced.includes(alternate.releaseSha256));
  }finally{await cleanup(w.dir)}
 }
});


test("compiler bridge preserves confirmed commit through three cleanup failures",async()=>{
 const w=await workspace();
 try{
  const result=await compileOresToWasm({...w,
   publication:"atomic",environment:"browser",
   __testBeforeAtomicCleanup:()=>{throw Error("injected publisher cleanup failure")},
   __testAfterLockCleanup:()=>{throw Error("injected lock cleanup failure")},
   __testAfterScratchCleanup:()=>{throw Error("injected scratch cleanup failure")}
  });
  assert.match(result.releaseSha256,/^[0-9a-f]{64}$/);
  assert.equal(result.cleanupWarning.code,"ATOMIC_RELEASE_POST_COMMIT_CLEANUP_FAILED");
  assert.deepEqual(result.cleanupWarnings.map(warning=>warning.code),[
   "ATOMIC_RELEASE_POST_COMMIT_CLEANUP_FAILED",
   "ARTIFACT_POST_COMMIT_CLEANUP_FAILED",
   "ARTIFACT_POST_COMMIT_CLEANUP_FAILED"
  ]);
  assert.deepEqual(result.cleanupWarnings.slice(1).map(x=>x.scope),["lock","scratch"]);
  const release=await readAtomicRelease(w.output);
  assert.equal(release.releaseSha256,result.releaseSha256);
  assert.equal(execute(release.wasm),42n);
  const state=await inspectAtomicReleaseState(w.output);
  assert.equal(state.current,result.releaseSha256);
 }finally{await cleanup(w.dir)}
});


test("Unicode string bounds follow JSON Schema code-point counts",async()=>{
 const w=await workspace();
 try{
  const baseline=await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const original=await readAtomicRelease(w.output);
  const cp="\u{1f642}";
  const validProvenance={...original.provenance,
   clangVersion:cp.repeat(256),note:cp.repeat(1024)};
  const accepted=await publishAtomicRelease({
   output:w.output,wasm:original.wasm,manifest:original.manifest,
   provenance:validProvenance
  });
  assert.notEqual(accepted.releaseSha256,baseline.releaseSha256);
  assert.equal((await readAtomicRelease(w.output)).releaseSha256,accepted.releaseSha256);
  const pointer=await readFile(w.output+".current.json");
  for(const provenance of [
   {...validProvenance,clangVersion:cp.repeat(257)},
   {...validProvenance,note:cp.repeat(1025)}
  ]){
   await assert.rejects(publishAtomicRelease({
    output:w.output,wasm:original.wasm,manifest:original.manifest,
    provenance
   }),/invalid producer record/);
   assert.deepEqual(await readFile(w.output+".current.json"),pointer);
  }
 }finally{await cleanup(w.dir)}
});

test("verified release reader disallows symlinked pointer files",async()=>{
 const w=await workspace();
 try{
  const compiled=await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const pointer=w.output+".current.json";
  const backup=pointer+".saved";
  await rename(pointer,backup);
  await symlink(backup,pointer);
  await assert.rejects(readAtomicRelease(w.output),/ELOOP|invalid file/);
  await unlink(pointer);
  await rename(backup,pointer);
  const restored=await readAtomicRelease(w.output);
  assert.equal(restored.releaseSha256,compiled.releaseSha256);
  assert.equal(execute(restored.wasm),42n);
 }finally{await cleanup(w.dir)}
});

test("closed publisher inputs reject hidden/symbol authority and never invoke digest accessors",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const release=await readAtomicRelease(w.output);
  const prior=await readFile(w.output+".current.json");
  const hidden={...release.provenance};
  Object.defineProperty(hidden,"privilegedToken",{value:"net",enumerable:false});
  const symbolic={...release.provenance};
  Object.defineProperty(symbolic,Symbol("privileged"),{value:"net"});
  let getterReads=0;
  const accessor={...release.provenance};
  Object.defineProperty(accessor,"wasmSha256",{enumerable:true,
   get(){getterReads++;throw Error("untrusted digest getter executed");}});
  for(const provenance of [hidden,symbolic,accessor]){
   await assert.rejects(publishAtomicRelease({output:w.output,
    wasm:release.wasm,manifest:release.manifest,provenance
   }),/invalid producer record/);
   assert.deepEqual(await readFile(w.output+".current.json"),prior);
  }
  assert.equal(getterReads,0);
  const badManifest={...release.manifest};
  Object.defineProperty(badManifest,Symbol("hostAuthority"),{value:true});
  await assert.rejects(publishAtomicRelease({output:w.output,
   wasm:release.wasm,manifest:badManifest,provenance:release.provenance
  }),/inconsistent manifest provenance/);
  assert.deepEqual(await readFile(w.output+".current.json"),prior);
 }finally{await cleanup(w.dir)}
});

test("FIFO pointer cannot block atomic release reader before type verification",async(t)=>{
 if(process.platform==="win32")return t.skip("POSIX FIFO-only regression");
 const w=await workspace();
 try{
  await compileOresToWasm({...w,environment:"browser",publication:"atomic"});
  const pointer=w.output+".current.json",backup=pointer+".saved";
  const mk=spawnSync("mkfifo",["--",pointer+".probe"],{timeout:5000});
  if(mk.status!==0)return t.skip("mkfifo is not installed");
  await unlink(pointer+".probe");
  await rename(pointer,backup);
  try{
   const status=spawnSync("mkfifo",["--",pointer],{timeout:5000});
   assert.equal(status.status,0,"FIFO setup failed");
   const moduleURL=new URL("../scripts/atomic-release.mjs",import.meta.url).href;
   const childSource=[
    "import {readAtomicRelease} from "+JSON.stringify(moduleURL)+";",
    "try{await readAtomicRelease("+JSON.stringify(w.output)+");process.exit(0)}",
    "catch(e){console.error(e.message);process.exit(12)}"
   ].join("\n");
   const child=spawnSync(process.execPath,["--input-type=module","--eval",childSource],
     {timeout:5000,encoding:"utf8"});
   assert.equal(child.status,12,
     "unsafe blocking FIFO reader: "+JSON.stringify({signal:child.signal,stderr:child.stderr}));
   assert.match(child.stderr,/invalid file/);
  }finally{
   await unlink(pointer);
   await rename(backup,pointer);
  }
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
 }finally{await cleanup(w.dir)}
});


test("dangling publication symlink entries never bypass mixed-mode exclusion",async()=>{
 for(const {mode,conflict} of [
  {mode:"atomic",conflict:""},
  {mode:"atomic",conflict:".artifact.json"},
  {mode:"atomic",conflict:".provenance.json"},
  {mode:"legacy",conflict:".current.json"},
  {mode:"legacy",conflict:".releases"}
 ]){
  const w=await workspace();
  try{
   const occupied=w.output+conflict;
   // The target is absent; stat() reports ENOENT even though this path is
   // occupied by a symlink and publishing would cross format boundaries.
   await symlink(join(w.dir,"nonexistent-conflict-target"),occupied);
   await assert.rejects(
    compileOresToWasm({...w,publication:mode,environment:"browser"}),
    /legacy and atomic artifact publications cannot share an output path/,
    mode+" should reject "+conflict
   );
   // A rejected format migration must leave the preexisting symlink alone.
   const entry=(await import("node:fs/promises")).lstat;
   assert.ok((await entry(occupied)).isSymbolicLink());
   await assert.rejects(readFile(w.output+".current.json"),/ENOENT/);
  }finally{await cleanup(w.dir)}
 }
});


test("publisher snapshots native typed-array storage without subclass getter authority",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const original=await readAtomicRelease(w.output);
  const pinnedPointer=await readFile(w.output+".current.json");
  let traps=0;
  class AdversarialWasm extends Uint8Array{
   get length(){traps++;return 0}
   get byteLength(){traps++;return 0}
   get byteOffset(){traps++;throw Error("subclass offset executed")}
   get buffer(){traps++;throw Error("subclass buffer executed")}
   [Symbol.iterator](){traps++;throw Error("subclass iterator executed")}
  }
  // The full bytes are still present in the intrinsic Uint8Array view.
  // Buffer.from(adversarial) alone would incorrectly copy zero bytes.
  const adversarial=new AdversarialWasm(original.wasm);
  const published=await publishAtomicRelease({
   output:w.output,wasm:adversarial,
   provenance:original.provenance,manifest:original.manifest
  });
  assert.equal(published.releaseSha256,original.releaseSha256);
  assert.equal(traps,0,"no untrusted subclass property may influence the snapshot");
  assert.deepEqual(await readFile(w.output+".current.json"),pinnedPointer);
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);

  // Forged prototypes carry no native byte-view internal slots.
  const counterfeit=Object.create(Uint8Array.prototype);
  await assert.rejects(publishAtomicRelease({
   output:w.output,wasm:counterfeit,provenance:original.provenance,
   manifest:original.manifest
  }),/invalid Wasm bytes/);
  // instanceof follows caller-mutable prototypes, not native element slots.
  const wrongElementType=new Uint16Array(8);
  Object.setPrototypeOf(wrongElementType,Uint8Array.prototype);
  assert.equal(wrongElementType instanceof Uint8Array,true);
  await assert.rejects(publishAtomicRelease({
   output:w.output,wasm:wrongElementType,provenance:original.provenance,
   manifest:original.manifest
  }),/invalid Wasm bytes/);

  if(typeof SharedArrayBuffer!=="undefined"){
   const sharedBacking=new SharedArrayBuffer(original.wasm.byteLength);
   const shared=new Uint8Array(sharedBacking);
   shared.set(original.wasm);
   await assert.rejects(publishAtomicRelease({
    output:w.output,wasm:shared,provenance:original.provenance,
    manifest:original.manifest
   }),/invalid Wasm bytes/);
   // The caller can mask a real SharedArrayBuffer's prototype: instanceof
   // says "false", but native slot inspection must still reject it.
   Object.setPrototypeOf(sharedBacking,ArrayBuffer.prototype);
   assert.equal(sharedBacking instanceof SharedArrayBuffer,false);
   await assert.rejects(publishAtomicRelease({
    output:w.output,wasm:shared,provenance:original.provenance,
    manifest:original.manifest
   }),/invalid Wasm bytes/);
  }
  assert.deepEqual(await readFile(w.output+".current.json"),pinnedPointer);
 }finally{await cleanup(w.dir)}
});

test("publisher rejects Proxy-backed metadata and Wasm without triggering traps",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const original=await readAtomicRelease(w.output);
  const selected=await readFile(w.output+".current.json");
  let traps=0;
  const poisonous=target=>new Proxy(target,{
   get(){traps++;throw Error("unexpected proxy get")},
   getPrototypeOf(){traps++;throw Error("unexpected proxy prototype read")},
   ownKeys(){traps++;throw Error("unexpected proxy enumeration")}
  });
  const variants=[
   {wasm:poisonous(original.wasm),provenance:original.provenance,manifest:original.manifest,
    pattern:/invalid Wasm bytes/},
   {wasm:original.wasm,provenance:poisonous(original.provenance),manifest:original.manifest,
    pattern:/invalid producer record/},
   {wasm:original.wasm,provenance:original.provenance,manifest:poisonous(original.manifest),
    pattern:/inconsistent manifest provenance/},
   {wasm:original.wasm,provenance:original.provenance,
    manifest:{...original.manifest,imports:poisonous([])},
    pattern:/inconsistent manifest provenance/},
   {wasm:original.wasm,provenance:original.provenance,
    manifest:{...original.manifest,requiredCapabilities:poisonous([])},
    pattern:/inconsistent manifest provenance/},
   {wasm:original.wasm,provenance:original.provenance,
    manifest:{...original.manifest,memory:poisonous(original.manifest.memory)},
    pattern:/inconsistent manifest provenance/},
   {wasm:original.wasm,provenance:original.provenance,
    manifest:{...original.manifest,producer:poisonous(original.manifest.producer)},
    pattern:/inconsistent manifest provenance/}
  ];
  for(const {pattern,...entry} of variants){
   await assert.rejects(publishAtomicRelease({output:w.output,...entry}),pattern);
   assert.equal(traps,0,"publisher must not invoke arbitrary caller Proxy traps");
   assert.deepEqual(await readFile(w.output+".current.json"),selected);
  }
 }finally{await cleanup(w.dir)}
});


test("fault matrix brackets both directory fsync and pointer rename without false rollback",async()=>{
 const w=await workspace();
 try{
  const baseline=await compileOresToWasm({
   ...w,publication:"atomic",environment:"browser"
  });
  const original=await readAtomicRelease(w.output);
  const selected=await readFile(w.output+".current.json");
  let trapped=0;
  for(const [name,hook] of [
   ["installed release rename but before release-root fsync","__testAfterReleaseRename"],
   ["durable temporary pointer but before pointer rename","__testBeforePointerRename"]
  ]){
   const provenance={...original.provenance,note:"simulated pre-commit failure: "+name};
   await assert.rejects(
    publishAtomicRelease({output:w.output,wasm:original.wasm,
      provenance,manifest:original.manifest,
      [hook]:()=>{trapped++;throw Error("injected failure "+name)}}),
    /injected failure/
   );
   assert.deepEqual(await readFile(w.output+".current.json"),selected,
    "before pointer rename the previous identity must stay selected");
   const still=await readAtomicRelease(w.output);
   assert.equal(still.releaseSha256,baseline.releaseSha256);
   const state=await inspectAtomicReleaseState(w.output);
   assert.equal(state.current,baseline.releaseSha256);
   assert.ok(state.unreferenced.length>=1,
    "a verified pre-commit release may be retained as an orphan");
  }
  assert.equal(trapped,2);

  const uncertainProvenance={...original.provenance,
   note:"simulated failure after pointer rename but before pointer-parent fsync"};
  let uncertain=null;
  await assert.rejects(
   publishAtomicRelease({
    output:w.output,wasm:original.wasm,manifest:original.manifest,
    provenance:uncertainProvenance,
    __testAfterPointerRename:()=>{throw Error("injected parent fsync failure")}
   }),
   error=>{
    uncertain=error;
    return error instanceof AtomicReleaseCommitUncertainError&&
      error.code==="ATOMIC_RELEASE_COMMIT_UNCERTAIN"&&
      error.mayBePublished===true&&
      error.cause?.message==="injected parent fsync failure";
   }
  );
  const current=await readAtomicRelease(w.output);
  assert.equal(current.releaseSha256,uncertain.releaseSha256);
  assert.notEqual(current.releaseSha256,baseline.releaseSha256);
  assert.equal(execute(current.wasm),42n);
  const inventory=await inspectAtomicReleaseState(w.output);
  assert.equal(inventory.current,uncertain.releaseSha256);
  assert.ok(inventory.unreferenced.includes(baseline.releaseSha256),
   "the previously selected reader-pinnable release must be retained");
 }finally{await cleanup(w.dir)}
});

test("hidden toJSON and symbol fields on empty authority arrays are rejected before invocation",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const current=await readAtomicRelease(w.output);
  const pointer=await readFile(w.output+".current.json");
  let called=0;
  for(const field of ["imports","requiredCapabilities"]){
   const variants=[];
   const hidden=[];
   Object.defineProperty(hidden,"toJSON",{configurable:true,
    value(){called++;throw Error("forbidden hidden array serializer")}});
   variants.push(hidden);
   const symbolic=[];
   Object.defineProperty(symbolic,Symbol("authority"),{value:"privileged",enumerable:false});
   variants.push(symbolic);
   const nonEnumerable=[];
   Object.defineProperty(nonEnumerable,"hiddenCapability",{value:"network",enumerable:false});
   variants.push(nonEnumerable);
   const subclass=Object.setPrototypeOf([],Object.create(Array.prototype));
   variants.push(subclass);
   for(const injected of variants){
    const manifest={...current.manifest,[field]:injected};
    await assert.rejects(publishAtomicRelease({output:w.output,
      wasm:current.wasm,manifest,provenance:current.provenance
    }),/inconsistent manifest provenance/);
    assert.equal(called,0,"hidden array authority must never run");
    assert.deepEqual(await readFile(w.output+".current.json"),pointer);
   }
  }
 }finally{await cleanup(w.dir)}
});

test("canonical sealed bytes never invoke inherited toJSON hooks",async()=>{
 const w=await workspace();
 let callbackCount=0;
 const oldObject=Object.getOwnPropertyDescriptor(Object.prototype,"toJSON");
 const oldArray=Object.getOwnPropertyDescriptor(Array.prototype,"toJSON");
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const old=await readAtomicRelease(w.output);
  Object.defineProperty(Object.prototype,"toJSON",{configurable:true,
   value(){callbackCount++;throw Error("inherited object toJSON invoked")}});
  Object.defineProperty(Array.prototype,"toJSON",{configurable:true,
   value(){callbackCount++;throw Error("inherited array toJSON invoked")}});
  const newlyPublished=await publishAtomicRelease({
    output:w.output,wasm:old.wasm,
    manifest:old.manifest,
    provenance:{...old.provenance,note:"prototype pollution canonicalization regression"}
  });
  const verified=await readAtomicRelease(w.output);
  assert.equal(verified.releaseSha256,newlyPublished.releaseSha256);
  assert.equal(execute(verified.wasm),42n);
  assert.equal(callbackCount,0,"canonical release metadata must never execute inherited serializers");
 }finally{
  if(oldObject)Object.defineProperty(Object.prototype,"toJSON",oldObject);
  else delete Object.prototype.toJSON;
  if(oldArray)Object.defineProperty(Array.prototype,"toJSON",oldArray);
  else delete Array.prototype.toJSON;
  await cleanup(w.dir);
 }
});


test("array prototype pollution cannot alter canonical release checks or digests",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const prior=await readAtomicRelease(w.output);
  const descriptors=["join","every","includes"].map(key=>
   Object.getOwnPropertyDescriptor(Array.prototype,key));
  const methods=["join","every","includes"];
  let invoked=0,good,badEnvironment,badCompiler;
  try{
   // Historically join could forge serialized bytes, includes could admit
   // unauthorized environment strings and every could skip SHA validation.
   const replacements=[
    function(){invoked++;return "FORGED_CANONICAL_BYTES"},
    function(){invoked++;return true},
    function(){invoked++;return true}
   ];
   for(let i=0;i<methods.length;i++)
    Object.defineProperty(Array.prototype,methods[i],{
     configurable:true,writable:true,value:replacements[i]
    });
   good=await publishAtomicRelease({
    output:w.output,wasm:prior.wasm,manifest:prior.manifest,
    provenance:{...prior.provenance,note:"prototype algorithm hardening"}
   });
   await readAtomicRelease(w.output);
   try{
    await publishAtomicRelease({
     output:w.output,wasm:prior.wasm,provenance:prior.provenance,
     manifest:{...prior.manifest,environment:"not-an-allowed-host"}
    });
   }catch(error){badEnvironment=error}
   try{
    await publishAtomicRelease({
     output:w.output,wasm:prior.wasm,manifest:prior.manifest,
     provenance:{...prior.provenance,compilerSha256:"invalid"}
    });
   }catch(error){badCompiler=error}
  }finally{
   for(let i=0;i<methods.length;i++)
    Object.defineProperty(Array.prototype,methods[i],descriptors[i]);
  }
  assert.match(good.releaseSha256,/^[0-9a-f]{64}$/);
  assert.match(String(badEnvironment?.message),/inconsistent manifest provenance/);
  assert.match(String(badCompiler?.message),/invalid producer record/);
  assert.equal(invoked,0,"metadata code must not invoke inherited collection algorithms");
  assert.equal((await readAtomicRelease(w.output)).releaseSha256,good.releaseSha256);
 }finally{await cleanup(w.dir)}
});

test("Unicode metadata length is not controlled by String prototype iterators",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const prior=await readAtomicRelease(w.output);
  const pointer=await readFile(w.output+".current.json");
  const original=Object.getOwnPropertyDescriptor(String.prototype,Symbol.iterator);
  let invoked=0,failure;
  try{
   Object.defineProperty(String.prototype,Symbol.iterator,{
    configurable:true,writable:true,
    value:function*(){invoked++;yield "x"}
   });
   try{
    await publishAtomicRelease({
     output:w.output,wasm:prior.wasm,manifest:prior.manifest,
     provenance:{...prior.provenance,clangVersion:"x".repeat(257)}
    });
   }catch(error){failure=error}
  }finally{
   if(original)Object.defineProperty(String.prototype,Symbol.iterator,original);
   else delete String.prototype[Symbol.iterator];
  }
  assert.match(String(failure?.message),/invalid producer record/);
  assert.equal(invoked,0,"codepoint admission must not use caller-controlled iterators");
  assert.deepEqual(await readFile(w.output+".current.json"),pointer);
 }finally{await cleanup(w.dir)}
});


test("compiler bridge fails closed under poisoned array admission predicates",async()=>{
 const w=await workspace();
 const {link,unlink}=await import("node:fs/promises");
 const originalIncludes=Object.getOwnPropertyDescriptor(Array.prototype,"includes");
 const originalSome=Object.getOwnPropertyDescriptor(Array.prototype,"some");
 let calls=0,modeFailure,collisionFailure,environmentFailure;
 try{
  await link(w.source,w.output);
  try{
   Object.defineProperty(Array.prototype,"includes",{configurable:true,writable:true,
    value(){calls++;return true}});
   Object.defineProperty(Array.prototype,"some",{configurable:true,writable:true,
    value(){calls++;return false}});
   try{await compileOresToWasm({...w,publication:"unsupported"})}
   catch(error){modeFailure=error}
   try{await compileOresToWasm({...w,publication:"legacy"})}
   catch(error){collisionFailure=error}
   await unlink(w.output);
   try{await compileOresToWasm({...w,publication:"atomic",environment:"evil-host"})}
   catch(error){environmentFailure=error}
  }finally{
   Object.defineProperty(Array.prototype,"includes",originalIncludes);
   Object.defineProperty(Array.prototype,"some",originalSome);
  }
  assert.match(String(modeFailure?.message),/invalid artifact publication mode/);
  assert.match(String(collisionFailure?.message),/overlaps a compiler\/source input/);
  assert.match(String(environmentFailure?.message),/unsupported portable host environment/);
  assert.equal(calls,0,"compiler admission must not invoke inherited array predicates");
  assert.equal(await readFile(w.source,"utf8"),"pub fnc main(): int { return 42; }\n");
 }finally{await cleanup(w.dir)}
});

test("legacy metadata sidecars do not invoke inherited toJSON",async()=>{
 const w=await workspace();
 const before=Object.getOwnPropertyDescriptor(Object.prototype,"toJSON");
 let invoked=0;
 try{
  try{
   Object.defineProperty(Object.prototype,"toJSON",{configurable:true,
    value(){invoked++;throw Error("forbidden inherited JSON serializer")}});
   await compileOresToWasm({...w,publication:"legacy",environment:"browser"});
  }finally{
   if(before)Object.defineProperty(Object.prototype,"toJSON",before);
   else delete Object.prototype.toJSON;
  }
  const record=JSON.parse(await readFile(w.output+".provenance.json","utf8"));
  const manifest=JSON.parse(await readFile(w.output+".artifact.json","utf8"));
  assert.equal(record.schemaVersion,1);
  assert.equal(manifest.environment,"browser");
  assert.equal(invoked,0);
 }finally{
  if(before)Object.defineProperty(Object.prototype,"toJSON",before);
  else delete Object.prototype.toJSON;
  await cleanup(w.dir);
 }
});


test("frozen original publication failure is not replaced by cleanup annotation",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const release=await readAtomicRelease(w.output);
  const pointer=await readFile(w.output+".current.json");
  const frozen=Object.freeze(new Error("frozen pre-commit failure"));
  await assert.rejects(publishAtomicRelease({
   output:w.output,wasm:release.wasm,manifest:release.manifest,
   provenance:{...release.provenance,note:"frozen-cleanup-primary"},
   __testBeforePointerRename:()=>{throw frozen},
   __testBeforeCleanup:()=>{throw Error("secondary cleanup fault")}
  }),error=>error===frozen);
  assert.deepEqual(await readFile(w.output+".current.json"),pointer);
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
 }finally{await cleanup(w.dir)}
});

test("compiler scratch cleanup cannot mask a failure through inherited receipt setters",async()=>{
 const w=await workspace();
 const descriptor=Object.getOwnPropertyDescriptor(Object.prototype,"cleanupFailures");
 const broken=join(w.dir,"fails.sh");
 let setterCalls=0;
 try{
  await writeFile(broken,"#!/bin/sh\nexit 72\n",{mode:0o700});
  try{
   Object.defineProperty(Object.prototype,"cleanupFailures",{configurable:true,
    set(){setterCalls++;throw Error("poisoned cleanupFailures setter")}});
   await assert.rejects(compileOresToWasm({
    ...w,compiler:broken,publication:"atomic",environment:"browser",
    __testAfterScratchCleanup:()=>{throw Error("secondary scratch cleanup failure")}
   }),/command failed/);
  }finally{
   if(descriptor)Object.defineProperty(Object.prototype,"cleanupFailures",descriptor);
   else delete Object.prototype.cleanupFailures;
  }
  assert.equal(setterCalls,0);
  await assert.rejects(readFile(w.output+".current.json"),/ENOENT/);
 }finally{
  if(descriptor)Object.defineProperty(Object.prototype,"cleanupFailures",descriptor);
  else delete Object.prototype.cleanupFailures;
  await cleanup(w.dir);
 }
});

test("canonical metadata encoder enforces exact aggregate UTF-8 byte budget",()=>{
 const exact={k:"x".repeat(16384-9)};
 const output=canonicalReleaseMetadata(exact);
 assert.equal(output.length,16384,"limit includes JSON punctuation and terminal newline");
 assert.equal(output.toString("utf8"),JSON.stringify(exact)+String.fromCharCode(10));
 assert.throws(()=>canonicalReleaseMetadata({k:"x".repeat(16384-8)}),
  /canonical metadata byte budget/);
 // Count UTF-8 bytes rather than JS UTF-16 units or Unicode code points.
 assert.throws(()=>canonicalReleaseMetadata({k:"😀".repeat(5000)}),
  /canonical metadata byte budget/);
 // Dense arrays must not be allowed to grow serialization output indefinitely.
 assert.throws(()=>canonicalReleaseMetadata(Array(9000).fill(0)),
  /canonical metadata byte budget/);
 const longKey={["k".repeat(16385)]:0};
 assert.throws(()=>canonicalReleaseMetadata(longKey),/canonical metadata byte budget/);
});


test("two publishers interleaved before pointer rename select only complete identities",{timeout:90000},async()=>{
 const w=await workspace();
 let resumeFirst=()=>{};
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const baseline=await readAtomicRelease(w.output);
  let entered;
  const atBarrier=new Promise(resolve=>{entered=resolve});
  const releaseBarrier=new Promise(resolve=>{resumeFirst=resolve});
  const provenanceA={...baseline.provenance,note:"interleave before pointer rename A"};
  const provenanceB={...baseline.provenance,note:"interleave before pointer rename B"};
  const a=publishAtomicRelease({
   output:w.output,wasm:baseline.wasm,manifest:baseline.manifest,
   provenance:provenanceA,
   __testBeforePointerRename:async()=>{entered();await releaseBarrier}
  });
  await Promise.race([atBarrier,a.then(
   ()=>{throw Error("writer A completed before its pre-rename checkpoint")},
   error=>{throw Error("writer A failed before its pre-rename checkpoint",{cause:error})}
  )]);
  assert.equal((await readAtomicRelease(w.output)).releaseSha256,baseline.releaseSha256,
   "a fully installed but unselected release must remain invisible to readers");
  const b=await publishAtomicRelease({output:w.output,wasm:baseline.wasm,
   manifest:baseline.manifest,provenance:provenanceB});
  assert.notEqual(b.releaseSha256,baseline.releaseSha256);
  assert.equal((await readAtomicRelease(w.output)).releaseSha256,b.releaseSha256);
  resumeFirst();
  const completedA=await a;
  assert.notEqual(completedA.releaseSha256,b.releaseSha256);
  const selected=await readAtomicRelease(w.output);
  assert.equal(selected.releaseSha256,completedA.releaseSha256);
  assert.equal(selected.provenance.note,provenanceA.note);
  assert.equal(selected.manifest.producer.sourceSha256,selected.provenance.sourceSha256);
  assert.equal(execute(selected.wasm),42n);
  const inventory=await inspectAtomicReleaseState(w.output);
  assert.deepEqual(inventory.invalid,[]);
  assert.ok(inventory.unreferenced.includes(b.releaseSha256));
  assert.ok(inventory.unreferenced.includes(baseline.releaseSha256));
 }finally{resumeFirst();await cleanup(w.dir)}
});

test("uncertain writer cannot claim current pointer after competing writer wins",{timeout:90000},async()=>{
 const w=await workspace();
 let resumeFirst=()=>{};
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const baseline=await readAtomicRelease(w.output);
  let entered;
  const afterRename=new Promise(resolve=>{entered=resolve});
  const releaseBarrier=new Promise(resolve=>{resumeFirst=resolve});
  const provenanceA={...baseline.provenance,note:"interleave after pointer rename A"};
  const provenanceB={...baseline.provenance,note:"interleave after pointer rename B"};
  const resultA=publishAtomicRelease({
   output:w.output,wasm:baseline.wasm,manifest:baseline.manifest,
   provenance:provenanceA,
   __testAfterPointerRename:async()=>{
    entered();
    await releaseBarrier;
    throw Error("simulated uncertain pointer-parent sync")
   }
  }).then(()=>({unexpectedSuccess:true}),error=>({error}));
  await Promise.race([afterRename,resultA.then(({error})=>{
   throw Error("writer A finished without reaching its post-rename checkpoint",{cause:error});
  })]);
  const selectedA=await readAtomicRelease(w.output);
  assert.equal(selectedA.provenance.note,provenanceA.note,
   "writer A must have made its release visible");
  const b=await publishAtomicRelease({output:w.output,wasm:baseline.wasm,
   manifest:baseline.manifest,provenance:provenanceB});
  assert.equal((await readAtomicRelease(w.output)).releaseSha256,b.releaseSha256);
  resumeFirst();
  const {error,unexpectedSuccess}=await resultA;
  assert.equal(unexpectedSuccess,undefined);
  assert.ok(error instanceof AtomicReleaseCommitUncertainError);
  assert.equal(error.code,"ATOMIC_RELEASE_COMMIT_UNCERTAIN");
  assert.equal(error.releaseSha256,selectedA.releaseSha256);
  assert.notEqual(error.releaseSha256,b.releaseSha256);
  assert.equal(error.mayBePublished,true);
  const current=await readAtomicRelease(w.output);
  assert.equal(current.releaseSha256,b.releaseSha256,
   "an uncertain receipt is not proof that its release remains selected");
  assert.equal(current.provenance.note,provenanceB.note);
  assert.equal(execute(current.wasm),42n);
  const inventory=await inspectAtomicReleaseState(w.output);
  assert.deepEqual(inventory.invalid,[]);
  assert.ok(inventory.unreferenced.includes(selectedA.releaseSha256));
 }finally{resumeFirst();await cleanup(w.dir)}
});

test("post-import poisoned own-property checks cannot execute metadata getters",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const previous=await readAtomicRelease(w.output);
  const pointer=await readFile(w.output+".current.json");
  let getters=0,poisonCalled=0;
  const poisoned={...previous.provenance};
  Object.defineProperty(poisoned,"note",{enumerable:true,configurable:true,
   get(){getters++;throw Error("metadata getter executed")}});
  const originalHasOwn=Object.getOwnPropertyDescriptor(Object,"hasOwn");
  const originalKeys=Object.getOwnPropertyDescriptor(Object,"keys");
  const originalOwnKeys=Object.getOwnPropertyDescriptor(Reflect,"ownKeys");
  let attempt;
  try{
   Object.defineProperty(Object,"hasOwn",{configurable:true,writable:true,
    value(){poisonCalled++;return true}});
   Object.defineProperty(Object,"keys",{configurable:true,writable:true,
    value(){poisonCalled++;return []}});
   Object.defineProperty(Reflect,"ownKeys",{configurable:true,writable:true,
    value(){poisonCalled++;return []}});
   // Admission is synchronous until the first filesystem await. Restore
   // intrinsic globals before Node's asynchronous test machinery resumes.
   attempt=publishAtomicRelease({output:w.output,wasm:previous.wasm,
    manifest:previous.manifest,provenance:poisoned});
  }finally{
   Object.defineProperty(Object,"hasOwn",originalHasOwn);
   Object.defineProperty(Object,"keys",originalKeys);
   Object.defineProperty(Reflect,"ownKeys",originalOwnKeys);
  }
  await assert.rejects(attempt,/invalid producer record/);
  assert.equal(getters,0,"metadata accessors must not be invoked");
  assert.equal(poisonCalled,0,"publisher must use captured own-key intrinsics");
  assert.deepEqual(await readFile(w.output+".current.json"),pointer);
 }finally{await cleanup(w.dir)}
});


test("regex prototype poisoning cannot bypass provenance SHA or reject valid publication",async()=>{
 const w=await workspace();
 const priorTest=Object.getOwnPropertyDescriptor(RegExp.prototype,"test");
 const priorExec=Object.getOwnPropertyDescriptor(RegExp.prototype,"exec");
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const baseline=await readAtomicRelease(w.output);
  const poisonedManifest={...baseline.manifest,
   producer:{...baseline.manifest.producer,compilerSha256:"not-a-sha"}};
  let good,bad,calls=0;
  try{
   // Native RegExp.test calls .exec, so capturing .test without .exec
   // still lets a compromised prototype forge regex admission results.
   Object.defineProperty(RegExp.prototype,"test",{configurable:true,writable:true,
    value(){calls++;return true}});
   Object.defineProperty(RegExp.prototype,"exec",{configurable:true,writable:true,
    value(){calls++;return ["FORGED_MATCH"]}});
   // Both requests run the entire synchronous admission phase before their
   // first filesystem await. Restore the global intrinsics before awaiting.
   good=publishAtomicRelease({output:w.output,wasm:baseline.wasm,
    manifest:baseline.manifest,
    provenance:{...baseline.provenance,note:"native-regex-publication"}});
   // Attach rejection ownership synchronously, before the next event-loop turn.
   bad=publishAtomicRelease({output:w.output,wasm:baseline.wasm,
    manifest:poisonedManifest,
    provenance:{...baseline.provenance,compilerSha256:"not-a-sha"}});
   bad.catch(()=>{});
  }finally{
   if(priorTest)Object.defineProperty(RegExp.prototype,"test",priorTest);
   else delete RegExp.prototype.test;
   if(priorExec)Object.defineProperty(RegExp.prototype,"exec",priorExec);
   else delete RegExp.prototype.exec;
  }
  const goodResult=await good;
  await assert.rejects(bad,/invalid producer record/);
  assert.equal(calls,0,"release admission must use captured native regex execution");
  assert.equal((await readAtomicRelease(w.output)).releaseSha256,goodResult.releaseSha256);
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
 }finally{await cleanup(w.dir)}
});

test("compiler bridge export admission ignores poisoned RegExp.test and exec",async()=>{
 const w=await workspace();
 try{
  const url=new URL("../scripts/compile-ores.mjs",import.meta.url).href;
  const options={compiler:w.compiler,source:w.source,
   output:w.output,publication:"atomic",environment:"browser",exportName:"invalid-name"};
  const childSource=[
   "import {compileOresToWasm} from "+JSON.stringify(url)+";",
   "RegExp.prototype.test=()=>true;RegExp.prototype.exec=()=>['FORGED_MATCH'];",
   "try{await compileOresToWasm("+JSON.stringify(options)+");process.exitCode=7}",
   "catch(e){if(String(e?.message).includes('unsupported export name'))process.exitCode=0;",
   "else {console.error(e);process.exitCode=8}}"
  ].join("\n");
  const child=spawnSync(process.execPath,["--input-type=module","--eval",childSource],
   {timeout:15000,encoding:"utf8"});
  assert.equal(child.status,0,"compiler accepted invalid export or failed unexpectedly: "+
   JSON.stringify({status:child.status,signal:child.signal,stderr:child.stderr}));
  await assert.rejects(readFile(w.output+".current.json"),/ENOENT/);
 }finally{await cleanup(w.dir)}
});

test("verified sealed directories reject untracked sidecars and symlinks",async()=>{
 for(const withManifest of [false,true]){
  const w=await workspace();
  try{
   await compileOresToWasm({...w,publication:"atomic",
    ...(withManifest?{environment:"browser"}:{})});
   const release=await readAtomicRelease(w.output);
   const pointer=await readFile(w.output+".current.json");
   const sealed=join(w.output+".releases",release.releaseSha256);
   await chmod(sealed,0o700);
   const rogue=join(sealed,"unsealed-sidecar.json");
   await writeFile(rogue,'{"unsealedAuthority":true}');
   await assert.rejects(readAtomicRelease(w.output),
    /unexpected sealed release entry/);
   // A publisher must also refuse to reuse a contaminated identical digest.
   await assert.rejects(publishAtomicRelease({output:w.output,
    wasm:release.wasm,manifest:release.manifest,provenance:release.provenance}),
    /unexpected sealed release entry/);
   assert.deepEqual(await readFile(w.output+".current.json"),pointer);
   await unlink(rogue);
   assert.equal((await readAtomicRelease(w.output)).releaseSha256,release.releaseSha256);
   const dangling=join(sealed,"unsealed-symlink");
   await symlink(join(w.dir,"absent-target"),dangling);
   await assert.rejects(readAtomicRelease(w.output),
    /unexpected sealed release entry/);
   await unlink(dangling);
   assert.equal((await readAtomicRelease(w.output)).releaseSha256,release.releaseSha256);
  }finally{await cleanup(w.dir)}
 }
});

test("verified pointers and payloads reject external hard links",async()=>{
 const w=await workspace();
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const baseline=await readAtomicRelease(w.output);
  const pointer=w.output+".current.json";
  const pointerBytes=await readFile(pointer);
  const sealed=join(w.output+".releases",baseline.releaseSha256);
  const entries=[pointer,join(sealed,"seal.json"),join(sealed,"guest.wasm"),
   join(sealed,"provenance.json"),join(sealed,"artifact.json")];
  for(let i=0;i<entries.length;i++){
   const alias=join(w.dir,"outside-hard-link-"+i);
   await link(entries[i],alias);
   try{
    await assert.rejects(readAtomicRelease(w.output),/invalid file/);
    // A same-digest publisher must not reuse a release if one of its
    // supposedly immutable payloads has an unsealed external inode alias.
    if(i!==0){
     await assert.rejects(publishAtomicRelease({output:w.output,
      wasm:baseline.wasm,manifest:baseline.manifest,
      provenance:baseline.provenance}),/invalid file/);
    }
    assert.deepEqual(await readFile(pointer),pointerBytes);
   }finally{await unlink(alias)}
   const verified=await readAtomicRelease(w.output);
   assert.equal(verified.releaseSha256,baseline.releaseSha256,
    "removing external alias restores valid sealed identity");
  }
 }finally{await cleanup(w.dir)}
});


test("independent processes racing as publishers and readers never select partial releases",
 {timeout:90000},async()=>{
 const w=await workspace();
 let child=null;
 try{
  await compileOresToWasm({...w,publication:"atomic",environment:"browser"});
  const baseline=await readAtomicRelease(w.output);
  const moduleURL=new URL("../scripts/atomic-release.mjs",import.meta.url).href;
  // A separate Node process acts as both a reader and a real independent
  // publisher, with no mocked transport, hook or host-side callback.
  const childSource=[
   "import {readAtomicRelease,publishAtomicRelease} from "+JSON.stringify(moduleURL)+";",
   "const output="+JSON.stringify(w.output)+";",
   "const initial=await readAtomicRelease(output);",
   "process.stdout.write('READY\\n');",
   "await new Promise(resolve=>process.stdin.once('data',resolve));",
   "async function check(){",
   " const r=await readAtomicRelease(output);",
   " if(new WebAssembly.Instance(new WebAssembly.Module(r.wasm)).exports.main()!==42n)",
   "  throw Error('reader observed wrong Wasm');",
   " if(!r.manifest||r.manifest.producer.sourceSha256!==r.provenance.sourceSha256)",
   "  throw Error('reader observed mixed provenance');",
   "}",
   "for(let i=0;i<15;i++)await check();",
   "const x=await publishAtomicRelease({output,wasm:initial.wasm,",
   " manifest:initial.manifest,provenance:{...initial.provenance,note:'external-writer'}});",
   "for(let i=0;i<15;i++)await check();",
   "process.stdout.write('PUBLISHED '+x.releaseSha256+'\\n');"
  ].join("\n");
  child=spawn(process.execPath,["--input-type=module","--eval",childSource],
   {stdio:["pipe","pipe","pipe"]});
  let stdout="",stderr="";
  const done=new Promise((resolve,reject)=>{
   child.once("error",reject);
   child.once("exit",(code,signal)=>{
    if(code===0)resolve();
    else reject(Error("external release process failed: "+JSON.stringify({
     code,signal,stderr:stderr.slice(0,2000),stdout:stdout.slice(0,2000)
    })));
   });
  });
  child.stdout.on("data",chunk=>{stdout+=chunk.toString("utf8")});
  child.stderr.on("data",chunk=>{stderr+=chunk.toString("utf8")});
  await Promise.race([
   new Promise(resolve=>{
    const checkReady=()=>{if(stdout.includes("READY\\n"))resolve();
     else child.stdout.once("data",checkReady)};
    checkReady();
   }),
   done.then(()=>{throw Error("child completed without readiness handshake")})
  ]);
  const parents=[];
  for(let i=0;i<4;i++)
   parents[parents.length]=publishAtomicRelease({
    output:w.output,wasm:baseline.wasm,manifest:baseline.manifest,
    provenance:{...baseline.provenance,note:"parent-writer-"+i}
   });
  child.stdin.write("GO\\n");
  await Promise.all(parents);
  for(let i=0;i<10;i++){
   const current=await readAtomicRelease(w.output);
   assert.equal(execute(current.wasm),42n);
   assert.equal(current.manifest.producer.sourceSha256,current.provenance.sourceSha256);
  }
  await done;
  assert.match(stdout,/PUBLISHED [0-9a-f]{64}/);
  const external=stdout.match(/PUBLISHED ([0-9a-f]{64})/)[1];
  const inventory=await inspectAtomicReleaseState(w.output);
  assert.deepEqual(inventory.invalid,[]);
  assert.ok(inventory.current===external||inventory.unreferenced.includes(external));
  assert.equal(execute((await readAtomicRelease(w.output)).wasm),42n);
 }finally{
  if(child&&!child.killed)child.kill();
  await cleanup(w.dir);
 }
});
