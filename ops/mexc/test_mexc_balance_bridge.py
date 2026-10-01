#!/usr/bin/env python3
"""Offline bridge peer and output guards; every socket/process is mocked."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import struct
import subprocess
import types
import unittest
from unittest import mock


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load("mexc_bridge_test", "mexc-balance-bridge.py")
report = load("mexc_report_test", "mexc-balance-report.py")
FAKE_INPUT = b'{"apiKey":"FAKE_ACCESS_KEY","apiSecret":"FAKE_SECRET_KEY"}'
GOOD_REPORT = {"schema": 1, "venue": "mexc", "scope": "spot", "authenticatedRead": True,
               "checkedAt": "2026-09-21T12:34:56Z", "totalAssets": 1, "zeroAssets": 0,
               "balances": [{"currency": "USDT", "free": "1.2500", "locked": "0", "available": None}]}


class BridgeTests(unittest.TestCase):
    def test_legacy_pair_stays_in_memory_and_uses_only_exact_active_reference(self):
        fake_registry = {"secrets": {bridge.REF: {"status": "active", "description": "mexc api/ Access Key: FAKE_ACCESS_KEY"}}}
        with mock.patch.object(bridge.Path, "read_text", return_value=json.dumps(fake_registry)):
            raw = bytearray(b"FAKE_SECRET_KEY")
            self.assertEqual(json.loads(bridge.prepare_payload(raw)), {"apiKey": "FAKE_ACCESS_KEY", "apiSecret": "FAKE_SECRET_KEY"})
            fake_registry["secrets"][bridge.REF]["status"] = "revoked"
        with mock.patch.object(bridge.Path, "read_text", return_value=json.dumps(fake_registry)):
            with self.assertRaises(ValueError):
                bridge.prepare_payload(raw)
        with mock.patch.object(bridge.Path, "read_text") as read:
            complete = bytearray(FAKE_INPUT)
            self.assertIs(bridge.prepare_payload(complete), complete)
            read.assert_not_called()

    def test_legacy_arbitrary_description_is_not_guessed_or_returned(self):
        raw = bytearray(b"FAKE_SECRET_KEY")
        for label in ["unlabelled FAKE_ACCESS_KEY", "Access Key: FAKE_ACCESS_KEY extra", "Access Key: x\nSecret Key: y"]:
            fake_registry = {"secrets": {bridge.REF: {"status": "active", "description": label}}}
            with mock.patch.object(bridge.Path, "read_text", return_value=json.dumps(fake_registry)):
                self.assertIs(bridge.prepare_payload(raw), raw)

    def consumer(self, uid, acknowledgement=b"1"):
        conn = mock.MagicMock()
        conn.__enter__.return_value = conn
        conn.getsockopt.return_value = struct.pack("3i", 123, uid, 456)
        conn.recv.return_value = acknowledgement
        stdin = types.SimpleNamespace(buffer=io.BytesIO(FAKE_INPUT))
        with mock.patch.object(bridge.sys, "stdin", stdin), mock.patch.object(bridge.socket, "socket", return_value=conn), mock.patch.object(bridge, "wipe", wraps=bridge.wipe) as wipe:
            result = bridge.consumer()
        self.assertEqual(wipe.call_count, 1)
        self.assertEqual(wipe.call_args.args[0], bytearray(len(FAKE_INPUT)))
        return result, conn

    def test_consumer_never_sends_payload_to_nonroot_peer(self):
        result, conn = self.consumer(1000)
        self.assertEqual(result, 66)
        conn.sendall.assert_not_called()

    def test_consumer_frames_only_stdin_and_requires_success_ack(self):
        for acknowledgement, expected in [(b"1", 0), (b"0", 67)]:
            result, conn = self.consumer(0, acknowledgement)
            self.assertEqual(result, expected)
            self.assertEqual(conn.sendall.call_args_list[0], mock.call(struct.pack("!I", len(FAKE_INPUT))))
            self.assertEqual(conn.sendall.call_count, 2)
            # Payload was zeroed after transfer; no argv/environment or output channel exists.
            self.assertEqual(conn.sendall.call_args_list[1].args[0], bytearray(len(FAKE_INPUT)))

    def run_server(self, peer_uid=456, output=None):
        listener, conn = mock.MagicMock(), mock.MagicMock()
        listener.__enter__.return_value = listener
        listener.accept.return_value = (conn, None)
        conn.__enter__.return_value = conn
        conn.getsockopt.return_value = struct.pack("3i", 123, peer_uid, 456)
        conn.recv.side_effect = [struct.pack("!I", len(FAKE_INPUT)), FAKE_INPUT]
        metadata = types.SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o755)
        completed = subprocess.CompletedProcess([], 0, json.dumps(output or GOOD_REPORT).encode())
        spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda module: None))
        stdout = io.StringIO()
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.object(bridge.os, "geteuid", return_value=0))
        stack.enter_context(mock.patch.object(bridge.pwd, "getpwnam", return_value=types.SimpleNamespace(pw_uid=456)))
        stack.enter_context(mock.patch.object(bridge.grp, "getgrnam", return_value=types.SimpleNamespace(gr_gid=456)))
        stack.enter_context(mock.patch.object(bridge.socket, "socket", return_value=listener))
        stack.enter_context(mock.patch.object(bridge.os, "chown"))
        stack.enter_context(mock.patch.object(bridge.os, "chmod"))
        stack.enter_context(mock.patch.object(bridge.os, "stat", return_value=metadata))
        stack.enter_context(mock.patch.object(bridge.os, "unlink"))
        stack.enter_context(mock.patch.object(bridge.Path, "read_text", return_value="print('public source')"))
        stack.enter_context(mock.patch.object(bridge.importlib.util, "spec_from_file_location", return_value=spec))
        stack.enter_context(mock.patch.object(bridge.importlib.util, "module_from_spec", return_value=report))
        process = stack.enter_context(mock.patch.object(bridge.subprocess, "run", return_value=completed))
        stack.enter_context(contextlib.redirect_stdout(stdout))
        return process, conn, stdout

    def test_server_rejects_other_uids_before_starting_ssh(self):
        process, conn, stdout = self.run_server(peer_uid=1000)
        with self.assertRaises(ValueError):
            bridge.server()
        process.assert_not_called()
        conn.sendall.assert_not_called()
        self.assertEqual(stdout.getvalue(), "")

    def test_server_rejects_secret_bearing_unknown_field_without_output(self):
        process, conn, stdout = self.run_server(output={**GOOD_REPORT, "apiSecret": "FAKE_SECRET_KEY"})
        with self.assertRaises(report.ReportError):
            bridge.server()
        self.assertEqual(process.call_count, 1)
        conn.sendall.assert_not_called()
        self.assertEqual(stdout.getvalue(), "")

    def test_server_fixed_ssh_argv_secret_only_stdin_and_allowlisted_output(self):
        process, conn, stdout = self.run_server()
        self.assertEqual(bridge.server(), 0)
        argv = process.call_args.args[0]
        self.assertEqual(argv[:6], ["/usr/bin/sudo", "-n", "-u", "anton", "/usr/bin/ssh", "-o"])
        self.assertEqual(argv[-2], "hyperion-trading")
        self.assertNotIn("FAKE_ACCESS_KEY", str(argv))
        self.assertNotIn("FAKE_SECRET_KEY", str(argv))
        self.assertEqual(process.call_args.kwargs["input"], FAKE_INPUT)
        conn.sendall.assert_called_once_with(b"1")
        self.assertEqual(json.loads(stdout.getvalue()), GOOD_REPORT)
        self.assertNotIn("FAKE_SECRET_KEY", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
