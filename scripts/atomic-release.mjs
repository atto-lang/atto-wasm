/** Atomic content-addressed releases; requires a trusted private filesystem.
 * An adversary who can replace files inside the release root is outside this
 * trust boundary. Immutable means nonoverwriting via this API, not WORM media.
 */
import {createHash} from "node:crypto";
import {readFile,rename,rm,mkdir,mkdtemp,lstat,chmod,open,readdir} from "node:fs/promises";
import {join,dirname,resolve} from "node:path";
import {assertCoreI64Entry} from "./core-i64-abi.mjs";
import {inspectWasmBytes} from "./inspect-core-memory.mjs";
const digest=b=>createHash("sha256").update(b).digest("hex");
const hex=x=>typeof x==="string"&&/^[0-9a-f]{64}$/.test(x);
const fail=x=>{throw Error("invalid atomic Oreslang release: "+x)};
// A pointer rename is the visibility/linearization point. If the subsequent
// directory sync fails, the pointer might already be visible or durable.
// Never translate that condition into an ordinary "nothing published" error.
export class AtomicReleaseCommitUncertainError extends Error {
 constructor({pointer,releaseSha256,cause}) {
  super("atomic release pointer was renamed but durable commit is unconfirmed; inspect the verified current pointer before retrying",{cause});
  this.name="AtomicReleaseCommitUncertainError";
  this.code="ATOMIC_RELEASE_COMMIT_UNCERTAIN";
  this.pointer=pointer;
  this.releaseSha256=releaseSha256;
  this.mayBePublished=true;
 }
}
const paths=output=>({root:output+".releases",pointer:output+".current.json"});
const canonical=x=>Buffer.from(JSON.stringify(x)+"\n");
// Explicit Linux/POSIX durability barrier. On filesystems without directory
// fsync support this fails closed rather than claiming persistence.
async function fsyncDirectory(dir){
 const handle=await open(dir,"r");
 try{await handle.sync()}finally{await handle.close()}
}
async function durableWrite(path,bytes){
 const handle=await open(path,"wx",0o400);
 try{await handle.writeFile(bytes);await handle.sync()}
 finally{await handle.close()}
}

async function safeFile(path,limit){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)fail("invalid file");
 const bytes=await readFile(path);
 if(bytes.length>limit)fail("oversized file");
 return bytes;
}
async function safeJSON(path){
 let value;
 try{value=JSON.parse((await safeFile(path,16384)).toString("utf8"))}
 catch{fail("invalid JSON file")}
 if(!value||typeof value!=="object"||Array.isArray(value))fail("invalid JSON object");
 return value;
}
function descriptorFor(wasm,manifest,provenance){
 if(wasm.length<8||wasm.length>16777216)fail("Wasm budget");
 if(provenance?.wasmSha256!==digest(wasm))fail("invalid provenance digest");
 if(!WebAssembly.validate(wasm))fail("invalid executable Wasm");
 if(!provenance||typeof provenance!=="object"||Array.isArray(provenance)||
    !["llvm-ores-to-wasm32-core-experimental"].includes(provenance.kind)||
    provenance.schemaVersion!==1||
    !["compilerSha256","sourceSha256","llvmIrSha256"].every(k=>
      hex(provenance[k]))||!hex(provenance.wasmSha256)||
    !Number.isSafeInteger(provenance.wasmBytes)||provenance.wasmBytes!==wasm.length||
    typeof provenance.exportName!=="string"||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provenance.exportName))
   fail("invalid producer record");
 if(WebAssembly.Module.imports(new WebAssembly.Module(wasm)).length!==0)
   fail("guest Wasm host imports forbidden");
 try{assertCoreI64Entry(wasm,provenance.exportName)}
 catch{fail("invalid core i64 entry ABI")}
 const memory=inspectWasmBytes(wasm,{maxModuleBytes:16777216,maxMemoryPages:2});
 if(memory.memoryCount!==1||!memory.hasMemoryMaximum||memory.memoryMaximum!==2)
   fail("invalid bounded 2-page guest memory");

 if(manifest!==null&&(manifest?.schemaVersion!==1||
   manifest.artifactType!=="oreslang.core-wasm.i64-v1"||
   manifest.target!=="wasm32"||manifest.backend!=="wasm"||
   !["browser","edge-js","edge-wasi"].includes(manifest.environment)||
   manifest.entry!==provenance.exportName||
   manifest.wasmBytes!==wasm.length||manifest.memory?.maximumPages!==2||
   !Array.isArray(manifest.imports)||manifest.imports.length!==0||
   !Array.isArray(manifest.requiredCapabilities)||
   manifest.requiredCapabilities.length!==0||
   manifest?.wasmSha256!==digest(wasm)||
   manifest.producer?.sourceSha256!==provenance.sourceSha256||
   manifest.producer?.compilerSha256!==provenance.compilerSha256||
   manifest.producer?.llvmIrSha256!==provenance.llvmIrSha256))
  fail("inconsistent manifest provenance");
 const fileHashes={wasm:digest(wasm),manifest:manifest===null?null:digest(canonical(manifest)),
   provenance:digest(canonical(provenance))};
 const seal={schemaVersion:1,type:"oreslang.atomic-release-v1",fileHashes};
 return {seal,releaseSha256:digest(canonical(seal))};
}
async function verifyDir(dir,id){
 if(!hex(id))fail("invalid identity");
 const st=await lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink())fail("release is not a real directory");
 const seal=await safeJSON(join(dir,"seal.json"));
 if(seal.schemaVersion!==1||seal.type!=="oreslang.atomic-release-v1"||
    !hex(seal.fileHashes?.wasm)||!hex(seal.fileHashes?.provenance)||
    !(seal.fileHashes.manifest===null||hex(seal.fileHashes.manifest))||
    digest(canonical(seal))!==id)fail("bad release seal");
 const wasm=await safeFile(join(dir,"guest.wasm"),16777216);
 const provenanceBytes=await safeFile(join(dir,"provenance.json"),16384);
 const manifestBytes=seal.fileHashes.manifest===null?null:
   await safeFile(join(dir,"artifact.json"),16384);
 if(digest(wasm)!==seal.fileHashes.wasm||
    digest(provenanceBytes)!==seal.fileHashes.provenance||
    (manifestBytes&&digest(manifestBytes)!==seal.fileHashes.manifest))
   fail("release content mutated");
 let manifest,provenance;
 try{provenance=JSON.parse(provenanceBytes);
     manifest=manifestBytes?JSON.parse(manifestBytes):null}
 catch{fail("invalid release metadata")}
 const computed=descriptorFor(wasm,manifest,provenance);
 if(computed.releaseSha256!==id)fail("release metadata mismatch");
 return {wasm,manifest,provenance,releaseSha256:id,directory:dir};
}
export async function readAtomicRelease(output){
 const {root,pointer}=paths(resolve(output));
 const st=await lstat(root);
 if(!st.isDirectory()||st.isSymbolicLink())fail("invalid release root");
 const pointerBytes=await safeFile(pointer,16384);
 let p;
 try{p=JSON.parse(pointerBytes.toString("utf8"))}
 catch{fail("invalid current pointer JSON")}
 // Publisher emits a single canonical encoding. Reject duplicate JSON keys,
 // reordered fields or alternate encodings instead of trusting last-key-wins.
 if(!p||typeof p!=="object"||Array.isArray(p)||
    Object.keys(p).join(",")!=="schemaVersion,releaseSha256"||
    !pointerBytes.equals(canonical(p)))fail("noncanonical current pointer");
 if(p.schemaVersion!==1||!hex(p.releaseSha256)||
    Object.keys(p).sort().join(",")!=="releaseSha256,schemaVersion")
  fail("invalid current pointer");
 return verifyDir(join(root,p.releaseSha256),p.releaseSha256);
}

/** A failed build leaves the previous current pointer unchanged. The new
 * release directory is written privately, independently checked, and moved
 * into place before one pointer rename (the linearization point).
 * Concurrent writers are last-writer-wins among verified complete releases.
 */
export async function publishAtomicRelease({
 output,wasm,manifest=null,provenance,
 // Test-only fault hooks run AFTER genuine IO barriers. They can only cause
 // a failure, never suppress fsync or alter the contents being sealed.
 __testAfterReleaseInstall,__testAfterPointerRename,__testBeforeCleanup
}){
 if(typeof output!=="string"||!output)fail("missing output");
 if(!(wasm instanceof Uint8Array))fail("invalid Wasm bytes");
 const destination=resolve(output),{root,pointer}=paths(destination);
 const bytes=Buffer.from(wasm);
 const {seal,releaseSha256}=descriptorFor(bytes,manifest,provenance);
 const provenanceBytes=canonical(provenance);
 const manifestBytes=manifest===null?null:canonical(manifest);
 if(provenanceBytes.length>16384||(manifestBytes&&manifestBytes.length>16384))
  fail("metadata exceeds 16 KiB");
 await mkdir(dirname(destination),{recursive:true});
 await mkdir(root,{recursive:true,mode:0o700});
 const rootStat=await lstat(root);
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink())fail("release root symlink");
 // Persist the release-root directory entry before any pointer can refer to it.
 await fsyncDirectory(dirname(root));
 const stage=await mkdtemp(join(root,".staging-"));
 let pointerDir=null,primaryError=null,committedResult=null;
 try{
  await durableWrite(join(stage,"guest.wasm"),bytes);
  await durableWrite(join(stage,"provenance.json"),provenanceBytes);
  if(manifestBytes)await durableWrite(join(stage,"artifact.json"),manifestBytes);
  await durableWrite(join(stage,"seal.json"),canonical(seal));
  await verifyDir(stage,releaseSha256);
  await fsyncDirectory(stage);
  await chmod(stage,0o500);
  await fsyncDirectory(stage);
  const destinationDir=join(root,releaseSha256);
  try{await rename(stage,destinationDir)}
  catch(error){
   if(!["EEXIST","ENOTEMPTY"].includes(error.code))throw error;
  }
  // Reject preexisting conflicting/replaced content, even if name matches.
  await verifyDir(destinationDir,releaseSha256);
  // Release directory entry becomes durable before we expose its identity.
  await fsyncDirectory(root);
  if(__testAfterReleaseInstall)await __testAfterReleaseInstall();
  pointerDir=await mkdtemp(join(dirname(pointer),".oreslang-pointer-"));
  const temporaryPointer=join(pointerDir,"current.json");
  await durableWrite(temporaryPointer,canonical({schemaVersion:1,releaseSha256}));
  await fsyncDirectory(pointerDir);
  await rename(temporaryPointer,pointer);
  // The pointer is already visible here, even if the next sync fails.
  // A retrying caller must NOT assume that the previous pointer remains.
  try {
   if(__testAfterPointerRename)await __testAfterPointerRename();
   await fsyncDirectory(dirname(pointer));
  }catch(error){
   throw new AtomicReleaseCommitUncertainError({pointer,releaseSha256,cause:error});
  }
  committedResult={releaseSha256,pointer,directory:destinationDir,wasmSha256:seal.fileHashes.wasm};
  return committedResult;
 }catch(error){
  primaryError=error;
  throw error;
 }finally{
  // Cleanup errors must not erase the more important commit outcome.
  // A crashed/failed cleanup may leave an orphan requiring inspection.
  try{
   if(__testBeforeCleanup)await __testBeforeCleanup();
   try{await chmod(stage,0o700)}
   catch(error){if(error.code!=="ENOENT")throw error}
   await rm(stage,{recursive:true,force:true});
   if(pointerDir)await rm(pointerDir,{recursive:true,force:true});
  }catch(cleanupError){
   if(primaryError){
    primaryError.cleanupFailure=String(cleanupError?.message||cleanupError).slice(0,256);
   }else if(committedResult){
    // Durable publication is a success, not an abort. Surface the orphaned
    // temp cleanup as a warning for operator inspection.
    committedResult.cleanupWarning={
     code:"ATOMIC_RELEASE_POST_COMMIT_CLEANUP_FAILED",
     message:String(cleanupError?.message||cleanupError).slice(0,256)
    };
   }else{
    throw cleanupError;
   }
  }
 }
}

// Read-only recovery inspection. Never collect orphans automatically:
// a concurrently executing reader may still have pinned their identity.
export async function inspectAtomicReleaseState(output){
 if(typeof output!=="string"||!output)fail("missing output");
 const {root}=paths(resolve(output));
 let current=null,pointerError=null;
 try{current=(await readAtomicRelease(output)).releaseSha256}
 catch(error){pointerError=String(error?.message||error).slice(0,256)}
 let entries;
 try{
  const stat=await lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink())fail("invalid release root");
  entries=await readdir(root,{withFileTypes:true});
 }catch(error){
  if(error?.code==="ENOENT")
   return {current,pointerError,staging:[],unreferenced:[],invalid:[]};
  throw error;
 }
 if(entries.length>4096)fail("recovery scan exceeds entry budget");
 const staging=[],unreferenced=[],invalid=[];
 for(const entry of entries){
  if(entry.name.startsWith(".staging-")){staging.push(entry.name);continue}
  if(!hex(entry.name)){invalid.push(entry.name);continue}
  if(entry.name===current)continue;
  try{await verifyDir(join(root,entry.name),entry.name);unreferenced.push(entry.name)}
  catch{invalid.push(entry.name)}
 }
 return {current,pointerError,staging,unreferenced,invalid};
}
