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
