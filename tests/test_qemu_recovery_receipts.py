"""Adversarial QEMU serial-receipt parser tests (no QEMU required)."""
import importlib.util
from pathlib import Path
import unittest

MODULE=Path(__file__).resolve().parents[1]/"scripts/qemu-powercut-harness.py"
spec=importlib.util.spec_from_file_location("qemu_recovery_harness",MODULE)
qemu=importlib.util.module_from_spec(spec)
spec.loader.exec_module(qemu)

HOOK="__testAfterPointerRename"

def transcript(checkpoint=HOOK,clean=True,error=False):
    return ("kernel: mounted ext4 successfully\n"
            "GUEST_COLD_BOOT_RECOVERY_OK "+checkpoint+
            " value=43 identity="+"a"*64+"\n"+
            ("GUEST_PROCESS_ERROR=2\n" if error else "")+
            ("GUEST_PROCESS_CLEAN_FINISH\n" if clean else "")+
            "reboot: Power down\n")

class QemuRecoveryReceiptTest(unittest.TestCase):
    def test_complete_clean_guest(self):
        receipt=qemu.validate_cold_boot_receipt(transcript(),HOOK,0)
        self.assertTrue(receipt.startswith("GUEST_COLD_BOOT_RECOVERY_OK "+HOOK))

    def test_marker_without_completion_is_not_success(self):
        with self.assertRaisesRegex(RuntimeError,"did not complete"):
            qemu.validate_cold_boot_receipt(transcript(clean=False),HOOK,0)

    def test_guest_error_after_marker_is_not_success(self):
        with self.assertRaisesRegex(RuntimeError,"nonzero process"):
            qemu.validate_cold_boot_receipt(transcript(error=True),HOOK,0)

    def test_abnormal_qemu_exit_is_not_success(self):
        with self.assertRaisesRegex(RuntimeError,"abnormally"):
            qemu.validate_cold_boot_receipt(transcript(),HOOK,137)

    def test_different_checkpoint_is_not_success(self):
        with self.assertRaisesRegex(RuntimeError,"missing"):
            qemu.validate_cold_boot_receipt(
                transcript("__testBeforePointerRename"),HOOK,0)

    def test_duplicate_marker_is_not_success(self):
        t=transcript()+"GUEST_COLD_BOOT_RECOVERY_OK "+HOOK+" value=42 identity=x\n"
        with self.assertRaisesRegex(RuntimeError,"repeated"):
            qemu.validate_cold_boot_receipt(t,HOOK,0)

    def test_substring_and_console_echo_do_not_count(self):
        data="shell: echo GUEST_COLD_BOOT_RECOVERY_OK "+HOOK+" value=42\nGUEST_PROCESS_CLEAN_FINISH\n"
        with self.assertRaisesRegex(RuntimeError,"missing"):
            qemu.validate_cold_boot_receipt(data,HOOK,0)

if __name__=="__main__":
    unittest.main()
