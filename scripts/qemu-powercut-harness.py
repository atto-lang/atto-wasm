#!/usr/bin/env python3
"""Destructive, isolated QEMU ext4 power-cut qualification.

QEMU is killed by the *host* with SIGKILL at guest-logged checkpoints, then
booted anew with the same ext4 virtual disk. This models unclean VM power
removal, NOT loss of host physical power, controller cache persistence,
enterprise filesystem safety, or a signed machine provenance.
Only run with freshly created temporary disk images.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parent.parent
CHECKPOINTS=(
 "__testAfterReleaseRename",
 "__testAfterReleaseInstall",
 "__testBeforePointerRename",
 "__testAfterPointerRename",
 "__testBeforeCleanup",
)
MULTI_CHECKPOINTS=("multi2","multi3")
MAX_LOG=1024*1024

def sha256(path):
 h=hashlib.sha256()
 with open(path,"rb") as file:
  for chunk in iter(lambda:file.read(1<<20),b""):
   h.update(chunk)
 return h.hexdigest()

def copy_binary_with_libraries(binary,destination):
 source=Path(binary).resolve(strict=True)
 target=destination/"usr/bin/node"
 target.parent.mkdir(parents=True,exist_ok=True)
 shutil.copy2(source,target)
 output=subprocess.check_output(["ldd",str(binary)],text=True)
 paths=set(re.findall(r"(/[A-Za-z0-9_./+\\-]+)",output))
 if not paths:
  raise RuntimeError("cannot resolve guest Node dynamic libraries")
 for name in paths:
  src=Path(name)
  if not src.is_file():
   continue
  dest=destination/name.lstrip("/")
  dest.parent.mkdir(parents=True,exist_ok=True)
  shutil.copy2(src,dest)

def create_guest_tree(root):
 for name in ("bin","sbin","proc","sys","dev","run","tmp","workspace/scripts"):
  (root/name).mkdir(parents=True,exist_ok=True)
 busybox=shutil.which("busybox")
 node=shutil.which("node")
 if not busybox or not node:
  raise RuntimeError("static busybox and Node 22 required")
 shutil.copy2(busybox,root/"bin/busybox")
 (root/"bin/sh").symlink_to("busybox")
 # Copy the Node executable and all dynamically linked dependency bytes.
 copy_binary_with_libraries(node,root)
 for filename in ("atomic-release.mjs","core-i64-abi.mjs","inspect-core-memory.mjs"):
  shutil.copy2(ROOT/"scripts"/filename,root/"workspace/scripts"/filename)
 shutil.copy2(ROOT/"scripts/qemu-fault-guest.mjs",root/"workspace/qemu-fault-guest.mjs")
 shutil.copy2(ROOT/"scripts/qemu-multiwriter-guest.mjs",root/"workspace/qemu-multiwriter-guest.mjs")
 init="""#!/bin/sh
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sys /sys
/bin/busybox mount -t devtmpfs devtmpfs /dev
/usr/bin/node /workspace/qemu-fault-guest.mjs
result=$?
if [ "$result" -ne 0 ]; then
  echo GUEST_PROCESS_ERROR=$result
else
  echo GUEST_PROCESS_CLEAN_FINISH
fi
/bin/busybox poweroff -f
"""
 (root/"sbin/init").write_text(init)
 (root/"sbin/init").chmod(0o755)
 subprocess.run(["node","scripts/qemu-fault-prepare.mjs",str(root/"workspace")],
                cwd=ROOT,check=True,timeout=45)

def disk_image(root,disk):
 with open(disk,"wb") as stream:
  stream.truncate(192*1024*1024)
 subprocess.run(["mkfs.ext4","-q","-F","-d",str(root),str(disk)],
                check=True,timeout=40)

def qemu_command(kernel,initrd,disk,mode,checkpoint):
 return [
  "qemu-system-x86_64","-machine","q35,accel=tcg","-cpu","max",
  "-m","768","-smp","1","-nographic","-no-reboot",
  "-kernel",str(kernel),"-initrd",str(initrd),
  "-append","root=/dev/vda rw rootwait console=ttyS0 init=/sbin/init"+
   " faultmode="+mode+" checkpoint="+checkpoint,
  "-drive","if=virtio,format=raw,file="+str(disk)+",cache=writeback",
  "-serial","mon:stdio",
 ]

def validate_cold_boot_receipt(serial_output,checkpoint,returncode):
 """Fail closed unless the verified guest reached a clean power-off path.

 A marker alone is NOT evidence that the guest process exited successfully;
 it can be printed before an unhandled exception or failed final cleanup.
 """
 lines=[line.strip() for line in serial_output.splitlines()]
 # The guest is trusted code, but its serial stream is still an unstructured
 # transport. Never accept prefix matches, extra fields, truncated digests,
 # arbitrary values, or receipt output for the wrong crash checkpoint.
 prefix="GUEST_COLD_BOOT_RECOVERY_OK "
 markers=[line for line in lines if line.startswith(prefix)]
 if len(markers)!=1:
  raise RuntimeError("cold-boot verification receipt missing or repeated")
 wanted=prefix+re.escape(checkpoint)
 match=re.fullmatch(wanted+r" value=(42|43|45) identity=([0-9a-f]{64})",markers[0])
 if not match:
  raise RuntimeError("malformed cold-boot recovery receipt")
 value=int(match.group(1))
 if checkpoint in CHECKPOINTS and value==45:
  raise RuntimeError("single-publisher fixture cannot recover third-writer release")
 if checkpoint in ("__testAfterReleaseRename","__testAfterReleaseInstall",
                   "__testBeforePointerRename") and value!=42:
  raise RuntimeError("pre-rename receipt selected wrong release")
 if checkpoint=="__testBeforeCleanup" and value!=43:
  raise RuntimeError("post-commit receipt selected wrong release")
 if checkpoint=="multi2" and value!=43:
  raise RuntimeError("two-publisher recovery selected wrong release")
 if checkpoint=="multi3" and value not in (43,45):
  raise RuntimeError("three-publisher recovery selected wrong release")
 if checkpoint not in CHECKPOINTS+MULTI_CHECKPOINTS:
  raise RuntimeError("unsupported cold-boot checkpoint")
 if returncode!=0:
  raise RuntimeError("QEMU cold-boot exited abnormally: "+str(returncode))
 if any("GUEST_PROCESS_ERROR=" in line for line in lines):
  raise RuntimeError("guest verifier reported a nonzero process result")
 if lines.count("GUEST_PROCESS_CLEAN_FINISH")!=1:
  raise RuntimeError("guest verifier did not complete cleanly")
 return markers[0]


def boot_until(kernel,initrd,disk,mode,checkpoint):
 wanted=(("GUEST_POWER_CUT_BOUNDARY " if mode=="publish" else
         "GUEST_MULTIWRITER_CUT_READY ") if mode.startswith("publish") else
         "GUEST_COLD_BOOT_RECOVERY_OK ")+checkpoint
 cmd=qemu_command(kernel,initrd,disk,mode,checkpoint)
 process=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,
   stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
 stream=process.stdout
 selector=selectors.DefaultSelector()
 selector.register(stream,selectors.EVENT_READ)
 output=b""
 deadline=time.monotonic()+120
 success=False
 try:
  while time.monotonic()<deadline:
   if process.poll() is not None and not selector.select(timeout=0):
    break
   for key,_ in selector.select(timeout=1):
    data=os.read(key.fileobj.fileno(),65536)
    if not data:
     break
    output=(output+data)[-MAX_LOG:]
    if wanted.encode() in output:
     success=True
     if mode.startswith("publish"):
      # QEMU process dies abruptly. Do NOT issue ACPI poweroff, sync, a
      # guest SIGKILL, or a graceful monitor quit command.
      os.killpg(process.pid,signal.SIGKILL)
     break
   if success:
    break
  if not success:
   raise RuntimeError("QEMU did not reach "+wanted+
     "; guest serial tail:\n"+output.decode(errors="replace")[-6000:])
  if mode.startswith("verify"):
   try:
    tail,_=process.communicate(timeout=15)
   except subprocess.TimeoutExpired as error:
    raise RuntimeError("cold-boot recovery guest did not power off cleanly") from error
   output=(output+tail)[-MAX_LOG:]
   try:
    receipt=validate_cold_boot_receipt(
      output.decode(errors="replace"),checkpoint,process.returncode)
   except RuntimeError as error:
    raise RuntimeError(str(error)+
       "; guest serial tail:\\n"+output.decode(errors="replace")[-8000:]) from error
   print("QEMU_VALIDATED_GUEST_RECEIPT",receipt,flush=True)
  print(("QEMU_UNCLEAN_POWER_CUT" if mode.startswith("publish") else
         "QEMU_COLD_BOOT_RECOVERY_VERIFIED"),checkpoint,flush=True)
 finally:
  if process.poll() is None:
   os.killpg(process.pid,signal.SIGKILL)
  process.wait(timeout=10)
  selector.close()
 return output.decode(errors="replace")

def main():
 if len(sys.argv) not in (3,4) or (len(sys.argv)==4 and sys.argv[3]!="--multi-only"):
  raise SystemExit("usage: qemu-powercut-harness.py KERNEL INITRD [--multi-only]")
 kernel,initrd=map(Path,sys.argv[1:3])
 multi_only=len(sys.argv)==4
 if not kernel.is_file() or not initrd.is_file():
  raise SystemExit("missing verified guest kernel/initrd")
 print("QEMU_KERNEL_SHA256",sha256(kernel),flush=True)
 print("QEMU_INITRD_SHA256",sha256(initrd),flush=True)
 print("QEMU_EXECUTABLE_SHA256",sha256(shutil.which("qemu-system-x86_64")),flush=True)
 print("QEMU_HOST_MODE", "TCG / no KVM, virtio-blk, ext4 ordered",flush=True)
 with tempfile.TemporaryDirectory(prefix="ores-qemu-powercut-") as work:
  base=Path(work)
  root=base/"root"
  create_guest_tree(root)
  passed=[]
  for hook in (MULTI_CHECKPOINTS if multi_only else CHECKPOINTS):
   disk=base/(hook+".img")
   disk_image(root,disk)
   boot_until(kernel,initrd,disk,"publish-multi" if multi_only else "publish",hook)
   boot_until(kernel,initrd,disk,"verify-multi" if multi_only else "verify",hook)
   disk.unlink()
   passed.append(hook)
   print("QEMU_POWER_CUT_CASE_PASS",hook,flush=True)
 evidence={
  "schemaVersion":1,
  "kind":("oreslang.qemu-ext4-multiwriter-recovery-v1" if multi_only else
          "oreslang.qemu-ext4-unclean-powercut-recovery-v1"),
  "sourceTree":subprocess.check_output(["git","rev-parse","HEAD^{tree}"],
                                    cwd=ROOT,text=True).strip(),
  "sourceCommit":subprocess.check_output(["git","rev-parse","HEAD"],
                                      cwd=ROOT,text=True).strip(),
  "kernelSha256":sha256(kernel),
  "initrdSha256":sha256(initrd),
  "qemuSha256":sha256(shutil.which("qemu-system-x86_64")),
  "disk":"raw-ext4-virtio-blk-cache-writeback",
  "mode":"qemu-tcg-x86_64-no-kvm",
  "uncleanHypervisorStops":len(passed),
  "verifiedColdBoots":len(passed),
  "checkpoints":passed,
  "limitations":"QEMU process kill is not host hardware power loss or controller cache test"
 }
 path=ROOT/("build/qemu-multiwriter-evidence.json" if multi_only else
             "build/qemu-powercut-evidence.json")
 path.parent.mkdir(parents=True,exist_ok=True)
 path.write_text(json.dumps(evidence,sort_keys=True,indent=2)+"\n")
 print("QEMU_POWER_CUT_EVIDENCE_SHA256",sha256(path),flush=True)
 print("QEMU_MULTIWRITER_MATRIX_PASS" if multi_only else
       "QEMU_POWER_CUT_MATRIX_PASS",len(passed),flush=True)

if __name__=="__main__":
 main()
