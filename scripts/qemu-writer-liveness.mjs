// QEMU qualification must prove that an allegedly stalled publisher really
// overlaps later writers; a printed pause marker alone is insufficient.
export function assertStalledPublisherAlive(child,expectedPid){
 if(!child||!Number.isSafeInteger(expectedPid)||expectedPid<1||
    child.pid!==expectedPid||child.exitCode!==null||
    child.signalCode!==null||child.killed===true){
  throw Error("stalled publisher exited before competing writer completed");
 }
 try{process.kill(expectedPid,0)}
 catch{throw Error("stalled publisher is no longer a live OS process")}
 return expectedPid;
}
