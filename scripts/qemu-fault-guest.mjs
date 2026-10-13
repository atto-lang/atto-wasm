// Runs INSIDE disposable QEMU guest. The host kills QEMU, not Node, when
// GUEST_POWER_CUT_BOUNDARY appears on the serial console. A second cold boot
// reads the same ext4 block image and independently validates the pointer.
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {publishAtomicRelease,readAtomicRelease,inspectAtomicReleaseState}
 from "./scripts/atomic-release.mjs";
const output="/workspace/slot.wasm";
const modes=new Set(["__testAfterReleaseRename","__testAfterReleaseInstall",
 "__testBeforePointerRename","__testAfterPointerRename","__testBeforeCleanup"]);
const args=(await readFile("/proc/cmdline","utf8")).trim().split(/\s+/);
const get=(name)=>args.find(x=>x.startsWith(name+"="))?.slice(name.length+1);
const mode=get("faultmode"),checkpoint=get("checkpoint");
const expected=JSON.parse(await readFile("/workspace/payload/expected.json","utf8"));
const original=expected[0];
if(mode==="publish"&&modes.has(checkpoint)){
 const selected=await readAtomicRelease(output);
 if(selected.releaseSha256!==original.releaseSha256)throw Error("unexpected initial selected identity");
 const wasm=await readFile("/workspace/payload/artifact-43.wasm");
 const manifest=JSON.parse(await readFile("/workspace/payload/next-manifest-43.json","utf8"));
 const provenance=JSON.parse(await readFile("/workspace/payload/next-provenance-43.json","utf8"));
 await publishAtomicRelease({output,wasm,manifest,provenance,
  [checkpoint]:async()=>{
   process.stdout.write("GUEST_POWER_CUT_BOUNDARY "+checkpoint+"\n");
   await new Promise(()=>setInterval(()=>{},60000));
  }
 });
 throw Error("publisher returned without host power cut");
}
if(mode==="verify"&&modes.has(checkpoint)){
 const result=await readAtomicRelease(output);
 const selected=result.releaseSha256;
 const val=new WebAssembly.Instance(new WebAssembly.Module(result.wasm)).exports.main();
 const allowed=expected.find(x=>x.expected===Number(val));
 const actualHash=createHash("sha256").update(result.wasm).digest("hex");
 if(!allowed||selected!==allowed.releaseSha256||
    actualHash!==allowed.wasmSha256)
   throw Error("cold-boot pointer chose an unrecognized release identity or Wasm digest");
 const before=new Set(["__testAfterReleaseRename","__testAfterReleaseInstall",
   "__testBeforePointerRename"]);
 if(before.has(checkpoint)){
  if(selected!==original.releaseSha256||val!==42n)
   throw Error("pre-rename crash changed previous release");
 }else if(checkpoint==="__testBeforeCleanup"){
  if(val!==43n)throw Error("post-sync crash failed to retain new release");
 }else if(![42n,43n].includes(val))throw Error("invalid uncertain-rename outcome");
 const state=await inspectAtomicReleaseState(output);
 if(state.current!==selected||state.invalid.length)
  throw Error("cold-boot recovery selected invalid release");
 process.stdout.write("GUEST_COLD_BOOT_RECOVERY_OK "+checkpoint+
  " value="+val+" identity="+selected+"\n");
}else{
 throw Error("invalid QEMU guest mode or checkpoint");
}
