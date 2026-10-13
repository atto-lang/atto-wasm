// Two/three concurrent publisher *operations* inside a disposable guest.
// A complete 43 commit races with a paused 44 and (for multi3) an uncertain
// 45 rename. This deliberately does not claim multi-process or cross-host
// writer safety; each operation invokes the real atomic-release API.
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {publishAtomicRelease,readAtomicRelease,inspectAtomicReleaseState}
 from "./scripts/atomic-release.mjs";

const output="/workspace/slot.wasm";
const sha=b=>createHash("sha256").update(b).digest("hex");
const parked=()=>new Promise(()=>{});
const scenarios=new Set(["multi2","multi3"]);
const fixtures=JSON.parse(await readFile("/workspace/payload/expected.json","utf8"));
const named=new Map(fixtures.map(x=>[x.expected,x]));
const assertFixture=(release)=>{
 const wasm=new WebAssembly.Module(release.wasm);
 const value=Number(new WebAssembly.Instance(wasm).exports.main());
 const wanted=named.get(value);
 if(!wanted||release.releaseSha256!==wanted.releaseSha256||
    sha(release.wasm)!==wanted.wasmSha256)
  throw Error("publisher recovery selected unrecognized release bytes");
 return value;
};
async function publish(value,hooks){
 const wasm=await readFile("/workspace/payload/artifact-"+value+".wasm");
 const manifest=JSON.parse(await readFile(
  "/workspace/payload/next-manifest-"+value+".json","utf8"));
 const provenance=JSON.parse(await readFile(
  "/workspace/payload/next-provenance-"+value+".json","utf8"));
 return publishAtomicRelease({output,wasm,manifest,provenance,...hooks});
}

export async function publishMulti(scenario){
 if(!scenarios.has(scenario))throw Error("unknown writer scenario");
 const concurrency=scenario==="multi2"?2:3;
 if(assertFixture(await readAtomicRelease(output))!==42)
  throw Error("missing initial 42 baseline");
 const atBarrier=new Set();
 let unblockAll;
 const allReady=new Promise(resolve=>{unblockAll=resolve});
 let permit45;
 const committed43=new Promise(resolve=>{permit45=resolve});
 const atPreRename=async(value)=>{
  if(atBarrier.has(value))throw Error("duplicate publisher barrier");
  atBarrier.add(value);
  if(atBarrier.size===concurrency)unblockAll();
  if(value===43)await allReady;
  if(value===44)await parked();
  if(value===45)await committed43;
 };
 const tasks=[
  publish(43,{__testBeforePointerRename:()=>atPreRename(43)})
    .then(async()=>{
      if(assertFixture(await readAtomicRelease(output))!==43)
       throw Error("first fully committed writer not selected");
      permit45();
      if(scenario==="multi2"){
       process.stdout.write("GUEST_MULTIWRITER_CUT_READY multi2\n");
       await parked();
      }
    }),
  publish(44,{__testBeforePointerRename:()=>atPreRename(44)})
 ];
 if(concurrency===3){
  tasks.push(publish(45,{
   __testBeforePointerRename:()=>atPreRename(45),
   __testAfterPointerRename:async()=>{
     if(assertFixture(await readAtomicRelease(output))!==45)
       throw Error("third publisher failed before uncertain pointer stage");
     process.stdout.write("GUEST_MULTIWRITER_CUT_READY multi3\n");
     await parked();
   }
  }));
 }
 await Promise.all(tasks);
 throw Error("concurrent publication returned without QEMU termination");
}
export async function verifyMulti(scenario){
 if(!scenarios.has(scenario))throw Error("unknown recovery scenario");
 const release=await readAtomicRelease(output);
 const value=assertFixture(release);
 const allowed=scenario==="multi2"?[43]:[43,45];
 if(!allowed.includes(value))
  throw Error("cold-boot exposed incomplete, stale or unauthorized writer");
 const state=await inspectAtomicReleaseState(output);
 if(state.pointerError||state.invalid.length||state.current!==release.releaseSha256)
  throw Error("cold-boot multiwriter inspection is inconsistent");
 // Writer 44 reached the fsync'd pre-pointer-rename barrier; it must be
 // a complete *orphan*, not selected or reclaimed.
 if(!state.unreferenced.includes(named.get(44).releaseSha256))
  throw Error("paused publisher 44 orphan was discarded or not verifiable");
 process.stdout.write("GUEST_COLD_BOOT_RECOVERY_OK "+scenario+
  " value="+value+" identity="+release.releaseSha256+"\n");
}
