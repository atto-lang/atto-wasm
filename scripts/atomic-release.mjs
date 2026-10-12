/** Atomic content-addressed releases; requires a trusted private filesystem.
 * An adversary who can replace files inside the release root is outside this
 * trust boundary. Immutable means nonoverwriting via this API, not WORM media.
 */
import {createHash} from "node:crypto";
import {readFile,writeFile,rename,rm,mkdir,mkdtemp,lstat,chmod} from "node:fs/promises";
import {join,dirname,resolve} from "node:path";
const digest=b=>createHash("sha256").update(b).digest("hex");
const hex=x=>typeof x==="string"&&/^[0-9a-f]{64}$/.test(x);
const fail=x=>{throw Error("invalid atomic Oreslang release: "+x)};
const paths=output=>({root:output+".releases",pointer:output+".current.json"});
const canonical=x=>Buffer.from(JSON.stringify(x)+"\n");
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
 if(manifest!==null&&(manifest?.wasmSha256!==digest(wasm)||
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
 const p=await safeJSON(pointer);
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
export async function publishAtomicRelease({output,wasm,manifest=null,provenance}){
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
 const stage=await mkdtemp(join(root,".staging-"));
 let pointerDir=null;
 try{
  await writeFile(join(stage,"guest.wasm"),bytes,{mode:0o400,flag:"wx"});
  await writeFile(join(stage,"provenance.json"),provenanceBytes,{mode:0o400,flag:"wx"});
  if(manifestBytes)await writeFile(join(stage,"artifact.json"),manifestBytes,{mode:0o400,flag:"wx"});
  await writeFile(join(stage,"seal.json"),canonical(seal),{mode:0o400,flag:"wx"});
  await verifyDir(stage,releaseSha256);
  await chmod(stage,0o500);
  const destinationDir=join(root,releaseSha256);
  try{await rename(stage,destinationDir)}
  catch(error){
   if(!["EEXIST","ENOTEMPTY"].includes(error.code))throw error;
  }
  // Reject preexisting conflicting/replaced content, even if name matches.
  await verifyDir(destinationDir,releaseSha256);
  pointerDir=await mkdtemp(join(dirname(pointer),".oreslang-pointer-"));
  const temporaryPointer=join(pointerDir,"current.json");
  await writeFile(temporaryPointer,canonical({schemaVersion:1,releaseSha256}),
    {mode:0o400,flag:"wx"});
  await rename(temporaryPointer,pointer);
  return {releaseSha256,pointer,directory:destinationDir,wasmSha256:seal.fileHashes.wasm};
 }finally{
  await rm(stage,{recursive:true,force:true});
  if(pointerDir)await rm(pointerDir,{recursive:true,force:true});
 }
}
