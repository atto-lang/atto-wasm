import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {assertStalledPublisherAlive} from "../scripts/qemu-writer-liveness.mjs";

test("paused child actually alive before competing writer",async()=>{
 const child=spawn(process.execPath,["-e","setInterval(()=>{},10000)"],
   {stdio:"ignore"});
 try{
  await once(child,"spawn");
  assert.equal(assertStalledPublisherAlive(child,child.pid),child.pid);
  assert.throws(()=>assertStalledPublisherAlive(child,child.pid+1),/exited/);
 }finally{
  child.kill("SIGKILL");
  await once(child,"close");
 }
 assert.throws(()=>assertStalledPublisherAlive(child,child.pid),/exited/);
});

test("recovery gate rejects exited, killed, substituted and nonsensical child IDs",()=>{
 const pid=process.pid;
 const live={pid,exitCode:null,signalCode:null,killed:false};
 assert.equal(assertStalledPublisherAlive(live,pid),pid);
 for(const fake of [
  {...live,exitCode:1}, {...live,signalCode:"SIGKILL"},
  {...live,killed:true}, {...live,pid:pid+1}
 ]){
  assert.throws(()=>assertStalledPublisherAlive(fake,pid),/exited/);
 }
 for(const invalid of [0,-1,1.2,NaN,null,"123"]){
  assert.throws(()=>assertStalledPublisherAlive(live,invalid),/exited/);
 }
});
