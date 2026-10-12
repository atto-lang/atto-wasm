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

def boot_until(kernel,initrd,disk,mode,checkpoint):
 wanted=("GUEST_POWER_CUT_BOUNDARY " if mode=="publish" else
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
     if mode=="publish":
      # QEMU process dies abruptly. Do NOT issue ACPI poweroff, sync, a
      # guest SIGKILL, or a graceful monitor quit command.
      os.killpg(process.pid,signal.SIGKILL)
     break
   if success:
    break
  if not success:
   raise RuntimeError("QEMU did not reach "+wanted+
     "; guest serial tail:\n"+output.decode(errors="replace")[-6000:])
  if mode=="verify":
   try:
    process.wait(timeout=15)
   except subprocess.TimeoutExpired:
    raise RuntimeError("cold-boot recovery guest did not power off cleanly")
  print(("QEMU_UNCLEAN_POWER_CUT" if mode=="publish" else
         "QEMU_COLD_BOOT_RECOVERY_VERIFIED"),checkpoint,flush=True)
 finally:
  if process.poll() is None:
   os.killpg(process.pid,signal.SIGKILL)
  process.wait(timeout=10)
  selector.close()
 return output.decode(errors="replace")

def main():
 if len(sys.argv)!=3:
  raise SystemExit("usage: qemu-powercut-harness.py KERNEL INITRD")
 kernel,initrd=map(Path,sys.argv[1:])
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
  for hook in CHECKPOINTS:
   disk=base/(hook+".img")
   disk_image(root,disk)
   boot_until(kernel,initrd,disk,"publish",hook)
   boot_until(kernel,initrd,disk,"verify",hook)
   disk.unlink()
   passed.append(hook)
   print("QEMU_POWER_CUT_CASE_PASS",hook,flush=True)
 evidence={
  "schemaVersion":1,
  "kind":"oreslang.qemu-ext4-unclean-powercut-recovery-v1",
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
 path=ROOT/"build/qemu-powercut-evidence.json"
 path.parent.mkdir(parents=True,exist_ok=True)
 path.write_text(json.dumps(evidence,sort_keys=True,indent=2)+"\\n")
 print("QEMU_POWER_CUT_EVIDENCE_SHA256",sha256(path),flush=True)
 print("QEMU_POWER_CUT_MATRIX_PASS",len(CHECKPOINTS),flush=True)

if __name__=="__main__":
 main()
