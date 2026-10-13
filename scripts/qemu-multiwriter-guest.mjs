// An isolated QEMU guest exercises distinct OS publisher processes.
// Publisher 43 stops after an *actual pointer rename*; other independent
// publisher(s) complete a verified fsync of a later pointer. The hypervisor
// is then SIGKILLed, and the same ext4 disk is cold-booted for verification.
// No multi-writer consensus or atomic compare-and-swap is claimed.
import {spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {assertStalledPublisherAlive} from "./scripts/qemu-writer-liveness.mjs";
import {publishAtomicRelease,readAtomicRelease,inspectAtomicReleaseState}
  from "./scripts/atomic-release.mjs";

const output="/workspace/slot.wasm",script=fileURLToPath(import.meta.url);
const args=(await readFile("/proc/cmdline","utf8")).trim().split(/\s+/);
const get=(key)=>args.find(x=>x.startsWith(key+"="))?.slice(key.length+1);
const mode=get("faultmode"),checkpoint=get("checkpoint");
const count=checkpoint==="multi2"?2:checkpoint==="multi3"?3:0;
if(!count||!["multi-publish","multi-verify"].includes(mode))
 throw Error("invalid multiwriter QEMU mode");
const expected=JSON.parse(await readFile("/workspace/payload/expected.json","utf8"));
const candidate=value=>{
 const hit=expected.find(x=>x.expected===value);
 if(!hit||!hit.releaseSha256||!hit.wasmSha256)throw Error("unrecognized writer");
 return hit;
};
const checksum=x=>createHash("sha256").update(x).digest("hex");

if(process.env.QEMU_WRITER_VAL){
 const value=Number(process.env.QEMU_WRITER_VAL);
 const accepted=candidate(value);
 const wasm=await readFile("/workspace/payload/artifact-"+value+".wasm");
 const manifest=JSON.parse(await readFile("/workspace/payload/next-manifest-"+value+".json","utf8"));
 const provenance=JSON.parse(await readFile("/workspace/payload/next-provenance-"+value+".json","utf8"));
 if(checksum(wasm)!==accepted.wasmSha256)throw Error("candidate fixture SHA mismatched");
 const hook=value===43?{__testAfterPointerRename:async()=>{
   process.stdout.write("GUEST_STALLED_WRITER 43 "+accepted.releaseSha256+"\n");
   await new Promise(()=>setInterval(()=>{},60000));
 }}:{};
 const published=await publishAtomicRelease({output,wasm,manifest,provenance,...hook});
 if(published.releaseSha256!==accepted.releaseSha256)throw Error("unexpected writer release hash");
 console.log("GUEST_PUBLISH_CONFIRMED",value,published.releaseSha256);
}else if(mode==="multi-publish"){
 const original=await readAtomicRelease(output);
 if(original.releaseSha256!==candidate(42).releaseSha256)
  throw Error("unexpected initial release");
 const children=[];
 const run=value=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[script],{
    env:{...process.env,QEMU_WRITER_VAL:String(value)},stdio:["ignore","pipe","pipe"]});
   children.push(child);
   let chunks="",errors="",seen=false,done=false;
   const timer=setTimeout(()=>reject(Error("child publisher timed out "+value)),25000);
   const end=(err,result)=>{
    if(done)return;
    done=true;clearTimeout(timer);
    err?reject(err):resolve(result);
   };
   child.stdout.on("data",buf=>{
    chunks+=buf.toString("utf8");
    for(const line of chunks.split("\n").slice(0,-1)){
     if(value===43&&line==="GUEST_STALLED_WRITER 43 "+candidate(43).releaseSha256){
      seen=true;
      end(null,{value,stalled:true,pid:child.pid});
     }
     if(value!==43&&line==="GUEST_PUBLISH_CONFIRMED "+value+" "+candidate(value).releaseSha256)seen=true;
    }
    chunks=chunks.slice(chunks.lastIndexOf("\n")+1);
   });
   child.stderr.on("data",buf=>{errors=(errors+buf.toString("utf8")).slice(-2048)});
   child.once("error",err=>end(err));
   child.once("close",(code,signal)=>{
    if(value===43)end(Error("stalled publisher unexpectedly exited "+code+"/"+signal));
    else if(code!==0||!seen)end(Error("publisher "+value+" failed: "+code+" "+errors));
    else end(null,{value,stalled:false,pid:child.pid});
   });
 });
 try{
  const first=await run(43);
  if(!first.stalled)throw Error("writer 43 did not stop after pointer rename");
  assertStalledPublisherAlive(children[0],first.pid);
  console.log("GUEST_OVERLAPPED_WRITER",first.value,first.pid);
  for(const value of (count===2?[44]:[44,45])){
   const result=await run(value);
   if(result.stalled||result.pid===first.pid)throw Error("publisher processes not independent");
   assertStalledPublisherAlive(children[0],first.pid);
   console.log("GUEST_SEPARATE_WRITER_COMPLETED",value,result.pid);
  }
  const newest=candidate(count===2?44:45);
  assertStalledPublisherAlive(children[0],first.pid);
  console.log("GUEST_LIVE_STALLED_PUBLISHER_CONFIRMED",first.pid);
  console.log("GUEST_POWER_CUT_BOUNDARY",checkpoint,"final="+newest.releaseSha256);
  await new Promise(()=>setInterval(()=>{},60000));
 }finally{
  for(const child of children)if(child.exitCode===null)child.kill("SIGKILL");
 }
}else{
 const selected=await readAtomicRelease(output);
 const latest=candidate(count===2?44:45);
 const val=new WebAssembly.Instance(new WebAssembly.Module(selected.wasm)).exports.main();
 if(selected.releaseSha256!==latest.releaseSha256||
    checksum(selected.wasm)!==latest.wasmSha256||val!==BigInt(latest.expected))
  throw Error("last successful concurrent publisher was not recovered");
 const inventory=await inspectAtomicReleaseState(output);
 if(inventory.current!==latest.releaseSha256||inventory.invalid.length||
    !inventory.unreferenced.includes(candidate(42).releaseSha256)||
    !inventory.unreferenced.includes(candidate(43).releaseSha256))
   throw Error("published/abandoned release inventory is inconsistent");
 if(count===3&&!inventory.unreferenced.includes(candidate(44).releaseSha256))
   throw Error("prior completed publisher release was improperly reclaimed");
 console.log("GUEST_COLD_BOOT_RECOVERY_OK",checkpoint,
   "value="+val,"identity="+selected.releaseSha256);
}
