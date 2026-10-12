"""Fail-closed native apt lock grammar regressions (stdlib-only)."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

ROOT=pathlib.Path(__file__).resolve().parents[1]
MODULE=ROOT/"scripts/verify-native-toolchain-lock.py"
spec=importlib.util.spec_from_file_location("native_lock_contract",MODULE)
lock=importlib.util.module_from_spec(spec)
spec.loader.exec_module(lock)

class NativeToolchainLockParserTest(unittest.TestCase):
    def setUp(self):
        self.original=lock.LOCK.read_bytes()
        self.valid=json.loads(self.original)

    def check_raw(self,raw,should_accept):
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/"native-toolchain.lock.json"
            path.write_bytes(raw)
            with patch.object(lock,"LOCK",path):
                if should_accept:
                    parsed,digest=lock.locked()
                    self.assertEqual(parsed["schemaVersion"],1)
                    self.assertEqual(len(digest),64)
                else:
                    with self.assertRaises(SystemExit):
                        lock.locked()

    def check_obj(self,change):
        obj=json.loads(self.original)
        change(obj)
        self.check_raw(json.dumps(obj).encode("utf-8"),False)

    def test_checked_in_lock_is_admitted(self):
        self.check_raw(self.original,True)

    def test_reject_noninteger_schema_versions(self):
        for value in (True,1.0,"1",None):
            with self.subTest(value=value):
                self.check_obj(lambda o:o.__setitem__("schemaVersion",value))

    def test_reject_invalid_note_values(self):
        for value in (None,False,0,"","a"*1025,"a"+chr(0)+"b"):
            with self.subTest(value=repr(value)[:35]):
                self.check_obj(lambda o:o.__setitem__("note",value))

    def test_duplicate_root_and_nested_keys(self):
        text=self.original.decode("utf-8")
        self.assertIn('"schemaVersion": 1,',text)
        self.check_raw(text.replace('"schemaVersion": 1,',
            '"schemaVersion": 1, "schemaVersion": 1,',1).encode(),False)
        self.assertIn('"clang": "1:18.0-59~exp2",',text)
        self.check_raw(text.replace('"clang": "1:18.0-59~exp2",',
            '"clang": "1:18.0-59~exp2", "clang": "1:18.0-59~exp2",',1).encode(),False)

    def test_reject_non_json_constants_and_invalid_utf8(self):
        self.check_raw(self.original.replace(b'"schemaVersion": 1',b'"schemaVersion": NaN',1),False)
        self.check_raw(self.original.replace(b'"note": "',b'"note": "\\xff',1),False)
        self.check_raw(b"\xff",False)

if __name__=="__main__":
    unittest.main()
