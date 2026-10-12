import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp,writeFile,readFile,rm,chmod,mkdir,readdir,rename,symlink,unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
import {publishAtomicRelease,readAtomicRelease,inspectAtomicReleaseState,AtomicReleaseCommitUncertainError} from "../scripts/atomic-release.mjs";

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


test("process termination at three publication barriers never exposes a partial release",async()=>{
 const moduleURL=new URL("../scripts/atomic-release.mjs",import.meta.url).href;
 for(const checkpoint of ["__testAfterReleaseInstall","__testAfterPointerRename","__testBeforeCleanup"]){
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
   const beforeRename=checkpoint==="__testAfterReleaseInstall";
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
