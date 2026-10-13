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
        with self.assertRaisesRegex(RuntimeError,"malformed"):
            qemu.validate_cold_boot_receipt(
                transcript("__testBeforePointerRename"),HOOK,0)

    def test_duplicate_marker_is_not_success(self):
        t=transcript()+"GUEST_COLD_BOOT_RECOVERY_OK "+HOOK+" value=42 identity=x\n"
        with self.assertRaisesRegex(RuntimeError,"repeated"):
            qemu.validate_cold_boot_receipt(t,HOOK,0)

    def test_malformed_value_or_identity_never_certifies_recovery(self):
        baseline=transcript()
        for forged in (
            "value=45 identity="+"a"*64,
            "value=43 identity=xyz",
            "value=43 identity="+"A"*64,
            "value=43 identity="+"a"*63,
            "value=43 identity="+"a"*64+" extra=true",
        ):
            with self.subTest(forged=forged[:45]):
                receipt=baseline.replace("value=43 identity="+"a"*64,forged)
                with self.assertRaises(RuntimeError):
                    qemu.validate_cold_boot_receipt(receipt,HOOK,0)

    def test_pre_rename_cannot_claim_new_release(self):
        hook="__testBeforePointerRename"
        with self.assertRaisesRegex(RuntimeError,"pre-rename"):
            qemu.validate_cold_boot_receipt(transcript(hook),hook,0)
        old=transcript(hook).replace("value=43 ","value=42 ")
        self.assertIn("value=42",qemu.validate_cold_boot_receipt(old,hook,0))

    def test_post_commit_cannot_claim_old_release(self):
        hook="__testBeforeCleanup"
        old=transcript(hook).replace("value=43 ","value=42 ")
        with self.assertRaisesRegex(RuntimeError,"post-commit"):
            qemu.validate_cold_boot_receipt(old,hook,0)
        self.assertIn("value=43",qemu.validate_cold_boot_receipt(transcript(hook),hook,0))

    def test_invalid_checkpoint_never_admitted(self):
        invalid="__testNotARealBarrier"
        with self.assertRaisesRegex(RuntimeError,"unsupported"):
            qemu.validate_cold_boot_receipt(transcript(invalid),invalid,0)

    def test_two_and_three_writer_receipts_require_final_durable_release(self):
        for checkpoint,value in (("multi2",44),("multi3",45)):
            with self.subTest(checkpoint=checkpoint):
                good=transcript(checkpoint).replace("value=43 ","value="+str(value)+" ")
                self.assertIn("value="+str(value),qemu.validate_cold_boot_receipt(good,checkpoint,0))
                for wrong in (42,43,44,45):
                    if wrong==value:
                        continue
                    bad=transcript(checkpoint).replace("value=43 ","value="+str(wrong)+" ")
                    with self.assertRaisesRegex(RuntimeError,"writer receipt"):
                        qemu.validate_cold_boot_receipt(bad,checkpoint,0)

    def test_multiwriter_receipt_still_requires_clean_guest_termination(self):
        report=transcript("multi3").replace("value=43 ","value=45 ")
        with self.assertRaisesRegex(RuntimeError,"did not complete"):
            qemu.validate_cold_boot_receipt(
                report.replace("GUEST_PROCESS_CLEAN_FINISH",""),"multi3",0)
        with self.assertRaisesRegex(RuntimeError,"abnormally"):
            qemu.validate_cold_boot_receipt(report,"multi3",137)

    def test_substring_and_console_echo_do_not_count(self):
        data="shell: echo GUEST_COLD_BOOT_RECOVERY_OK "+HOOK+" value=42\nGUEST_PROCESS_CLEAN_FINISH\n"
        with self.assertRaisesRegex(RuntimeError,"missing"):
            qemu.validate_cold_boot_receipt(data,HOOK,0)

if __name__=="__main__":
    unittest.main()
