import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,stat,rename,symlink,rm,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readBounded,compileOresToWasm} from "../scripts/compile-ores.mjs";

const withDirectory = async run => {
  const directory = await mkdtemp(join(tmpdir(),"atto-wasm-fd-admission-"));
  try {await run(directory);}
  finally {await rm(directory,{recursive:true,force:true});}
};

test("bounded descriptor accepts exact preflight file identity and bytes",async()=>{
 await withDirectory(async directory=>{
  const path=join(directory,"guest.atto");
  const original=Buffer.from("fnc main():int{return 42;}","utf8");
  await writeFile(path,original);
  const before=await stat(path);
  const actual=await readBounded(path,1024,"source",before);
  assert.deepEqual(actual,original);
 });
});

test("bounded source reader rejects an input swapped after preflight",async()=>{
 await withDirectory(async directory=>{
  const input=join(directory,"guest.atto");
  const moved=join(directory,"original.atto");
  await writeFile(input,"fnc main():int{return 42;}");
  const before=await stat(input);
  await rename(input,moved); // retain old inode; replacement MUST differ
  await writeFile(input,"fnc main():int{return 17;}");
  await assert.rejects(readBounded(input,1024,"source",before),
    /changed between preflight and bounded snapshot/);
 });
});

test("no-follow admission rejects symlink and nonregular source",async()=>{
 await withDirectory(async directory=>{
  const input=join(directory,"guest.atto");
  const alias=join(directory,"alias.atto");
  await writeFile(input,"fnc main():int{return 42;}");
  await symlink(input,alias);
  await assert.rejects(readBounded(alias,1024,"source"),/./);
  const folder=join(directory,"directory.atto");
  await mkdir(folder);
  await assert.rejects(readBounded(folder,1024,"source"),/regular file|EISDIR|invalid/i);
 });
});

test("input size and empty-file limits fail without allocating an unbounded copy",async()=>{
 await withDirectory(async directory=>{
  const empty=join(directory,"empty.atto");
  const oversized=join(directory,"oversized.atto");
  await writeFile(empty,Buffer.alloc(0));
  await writeFile(oversized,Buffer.alloc(1025));
  await assert.rejects(readBounded(empty,1024,"source"),/empty/);
  await assert.rejects(readBounded(oversized,1024,"source"),/1 MiB/);
  await assert.rejects(readBounded(oversized,-1,"source"),/invalid bounded/);
 });
});

test("full compiler bridge rejects original source symlink leaf before execution",async()=>{
 await withDirectory(async directory=>{
  const actual=join(directory,"original.atto");
  const source=join(directory,"untrusted.atto");
  const compiler=join(directory,"compiler");
  const output=join(directory,"wasm-output.wasm");
  await writeFile(actual,"fnc main():int{return 42;}");
  await writeFile(compiler,"not a compiler: should never be executed");
  await symlink(actual,source);
  await assert.rejects(
    compileOresToWasm({compiler,source,output}),
    /ELOOP|symbolic link|symlink/i
  );
 });
});
