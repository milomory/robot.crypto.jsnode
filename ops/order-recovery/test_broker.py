"""Offline broker boundary tests. No real vault, credentials, SSH or service calls."""
import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(ROOT / filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

bridge = module('recovery_test_bridge', 'recovery-bridge.py')
controller = module('recovery_test_controller', 'run-recovery-once.py')

def pin(venue='mexc'):
    return {'schema': 1, 'release': 'a' * 64, 'manifestSha256': 'a' * 64,
            'requestSha256': 'b' * 64, 'venue': venue}

def report(preflight=False, venue='mexc'):
    value = {'schema': 1, 'mode': 'order-recovery-preflight' if preflight else 'order-recovery-readonly',
             'requestSha256': 'b' * 64, 'venue': venue, 'executable': False,
             'captureProvenanceVerified': False, 'accountIdentityVerified': False}
    if preflight:
        value['ready'] = True
    else:
        value.update(reportWritten=True, requestCount=3, receipt={'schema': 1,
            'kind': 'live-order-recovery-archive-receipt', 'archiveId': '00000000-0000-4000-8000-000000000001',
            'archiveHash': 'c' * 64})
    return value

class ContractTests(unittest.TestCase):
    def test_only_selected_parts_enter_profiles(self):
        for venue, names in [('mexc', ['mexc']), ('okx', ['okx-keypair', 'okx-passphrase'])]:
            parts = controller.selected_parts(venue)
            self.assertEqual([p[0] for p in parts], names)
            records = {ref: {'backend': 'sops-age', 'backend_id': 'private-fixture', 'status': 'active',
                             'description': 'do-not-copy'} for _, ref in parts}
            value = controller.scoped_registry(records, venue)
            self.assertEqual(len(value['profiles']), len(names))
            for part, ref in parts:
                profile = value['profiles'][controller.PROFILE + '-' + part]
                self.assertEqual(profile['allowed_refs'], [ref])
                self.assertEqual(profile['allowed_destinations'], [controller.DESTINATION + '-' + part])
                self.assertEqual(profile['executable'], str(controller.BRIDGE))
                self.assertEqual(profile['injection'], 'stdin')
                self.assertEqual(profile['arguments'], ['--consumer', '--part', part, '--destination', controller.DESTINATION + '-' + part])
                self.assertNotIn('description', value['secrets'][ref])
            records['unexpected-record'] = {}
            with self.assertRaises(ValueError): controller.scoped_registry(records, venue)
        for bad in ('bybit', 'all', None):
            with self.assertRaises(ValueError): controller.selected_parts(bad)

    def test_pin_rejects_path_injection_drift_and_unexpected_fields(self):
        self.assertEqual(bridge.parse_pin(pin()), pin())
        for change in ({'venue': 'all'}, {'schema': True}, {'release': '../escape'},
                       {'manifestSha256': 'c' * 64}, {'requestSha256': 'x;$(bad)'}, {'command': 'sh'}):
            with self.subTest(change=change), self.assertRaises(ValueError): bridge.parse_pin(dict(pin(), **change))

    def test_remote_command_has_only_fixed_paths_and_preflight_before_credentials(self):
        source = bridge.verification_command(pin(), preflight=True)
        self.assertIn('/usr/bin/python3 -I -c ', source)
        self.assertIn('crypto-order-recovery/releases', source)
        self.assertIn('PREFLIGHT = True', source)
        self.assertIn('hashlib.sha256(raw).hexdigest()', source)
        self.assertIn('actual!=set(files)', source)
        self.assertIn("PIN_VALUE", source)
        self.assertNotIn('crypto-execution-history', source)
        with self.assertRaises(ValueError): bridge.verification_command(pin(), preflight='--capture')
        text = (ROOT / 'run-recovery-once.py').read_text()
        self.assertLess(text.index('contract.verification_command(pin, preflight=True)'), text.index("'/usr/local/bin/secretctl', 'use'"))
        self.assertLess(text.index('pin = contract.load_pin(REQUEST_PIN)'), text.index('ROOT.mkdir'))
        self.assertIn("if report_module.load_pin() != pin: raise ValueError()", text)
        self.assertIn("REQUEST_PIN = Path('/etc/crypto-order-recovery/request-pin.json')", text)

    def test_absent_request_pin_never_starts_broker_or_reads_vault(self):
        with mock.patch.object(controller.os, 'geteuid', return_value=0), \
             mock.patch.object(controller.sys, 'argv', ['run-recovery-once.py']), \
             mock.patch.object(controller, 'command') as command, \
             mock.patch.object(controller.os, 'open', side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError): controller.main()
            command.assert_not_called()

    def test_strict_success_reports_and_receipt_are_bound_to_pin(self):
        for preflight in (False, True):
            for venue in ('mexc', 'okx'):
                value = report(preflight, venue)
                self.assertEqual(bridge.decode_report(json.dumps(value).encode(), preflight, pin(venue)), value)
                with self.assertRaises(ValueError): bridge.decode_report(json.dumps(value).encode(), preflight, pin('okx' if venue == 'mexc' else 'mexc'))
                value['requestSha256'] = 'c' * 64
                with self.assertRaises(ValueError): bridge.decode_report(json.dumps(value).encode(), preflight, pin(venue))
        self.assertEqual(bridge.decode_report(b'{"schema":1,"error":"recovery-failed"}'), bridge.FAILURE)

    def test_private_fields_false_provenance_and_exact_counts_cannot_pass_decoder(self):
        for preflight in (False, True):
            for change in ({'schema': True}, {'executable': True}, {'captureProvenanceVerified': True},
                           {'accountIdentityVerified': True}, {'url': 'SECRET'}, {'venue': 'all'}):
                value = dict(report(preflight), **change)
                with self.subTest(preflight=preflight, change=change), self.assertRaises(ValueError):
                    bridge.decode_report(json.dumps(value).encode(), preflight)
        for count in (True, 0, 2, 4, 3.0):
            with self.subTest(count=count), self.assertRaises(ValueError):
                bridge.decode_report(json.dumps(dict(report(), requestCount=count)).encode())
        for change in ({'schema': True}, {'archiveHash': 'not-a-hash'}, {'archiveId': '../path'}, {'secret': 'PRIVATE'}):
            value = report(); value['receipt'].update(change)
            with self.assertRaises(ValueError): bridge.decode_report(json.dumps(value).encode())

    def test_json_duplicate_size_nonfinite_and_failure_text_rejected(self):
        for raw in (b'', b' ' * 4097, b'{"schema":1,"schema":1,"error":"recovery-failed"}',
                    b'{"schema":NaN}', b'{"schema":1,"error":"PRIVATE"}', b'[]', b'null'):
            with self.subTest(raw=raw[:40]), self.assertRaises((ValueError, TypeError)):
                bridge.decode_report(raw)

    def test_mexc_payload_never_loads_okx_helpers_or_delivers_okx_keys(self):
        seen = []
        def load(name, path):
            seen.append(path)
            if path == bridge.MEXC_FORMAT: return types.SimpleNamespace(prepare_payload=lambda raw: bytearray(b'formatted'))
            if path == bridge.MEXC_PROBE: return types.SimpleNamespace(parse_credentials=lambda raw: ('FAKE_MEXC_KEY', 'FAKE_MEXC_SECRET'))
            raise AssertionError('other-venue-helper')
        with mock.patch.object(bridge, 'load_root_module', side_effect=load):
            payload, credentials = bridge.prepare_payload({'mexc': bytearray(b'fixture')}, 'mexc')
        value = json.loads(payload)
        self.assertEqual(set(value), {'schema', 'venue', 'mexc'})
        self.assertEqual(value['mexc']['venue'], 'mexc')
        self.assertEqual(credentials, ('FAKE_MEXC_KEY', 'FAKE_MEXC_SECRET'))
        self.assertNotIn(bridge.OKX_PROBE, seen)
        bridge.wipe(payload); self.assertEqual(set(payload), {0})
        with self.assertRaises(ValueError): bridge.prepare_payload({'mexc': b'x', 'okx-keypair': b'y'}, 'mexc')

    def test_okx_payload_delivers_only_two_required_records(self):
        probe = types.SimpleNamespace(parse_separate_passphrase=lambda raw: 'FAKE_PASSPHRASE',
            parse_credentials=lambda raw, passphrase_override: ('FAKE_OKX_KEY', 'FAKE_OKX_SECRET', passphrase_override))
        with mock.patch.object(bridge, 'load_root_module', return_value=probe) as loader:
            payload, credentials = bridge.prepare_payload({'okx-keypair': bytearray(b'pair'), 'okx-passphrase': bytearray(b'phrase')}, 'okx')
            loader.assert_called_once_with('recovery_okx_probe', bridge.OKX_PROBE)
        value = json.loads(payload)
        self.assertEqual(set(value), {'schema', 'venue', 'okx'})
        self.assertEqual(len(credentials), 3)
        self.assertEqual(value['okx']['passphrase'], 'FAKE_PASSPHRASE')

    def test_even_schema_valid_output_cannot_include_a_delivered_secret(self):
        raw = json.dumps(report()).encode()
        self.assertEqual(bridge.safe_output(raw, ('FAKE_NOT_PRESENT',), pin())[0], report())
        with self.assertRaises(ValueError): bridge.safe_output(raw, ('c' * 64,), pin())

if __name__ == '__main__': unittest.main()
