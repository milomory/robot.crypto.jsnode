"""Output projection tests: fake account metadata, no secrets/network/runtime."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import unittest

PATH = Path(__file__).with_name('okx-account-report.py')
spec = importlib.util.spec_from_file_location('okx_report', PATH)
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def success():
    return {'schema': 1, 'venue': 'okx', 'scope': 'account-check', 'authenticatedRead': True,
            'checkedAt': '2026-09-25T12:34:56Z', 'tradingAssets': 1, 'fundingAssets': 0,
            'permissions': {'read': True, 'trade': True, 'withdraw': False, 'unknownPermissionsPresent': False},
            'feeReadVerified': True}


def failure():
    return {'schema': 1, 'venue': 'okx', 'scope': 'account-check', 'authenticatedRead': False,
            'errorCode': 'missing-passphrase', 'failedStage': 'credentials', 'completedReads': 0}


class ReportTests(unittest.TestCase):
    def rejects(self, value):
        with self.assertRaisesRegex(report.ReportError, '^report-rejected$'):
            report.validate_report(value)

    def test_python36_syntax_and_pure_imports(self):
        tree = ast.parse(PATH.read_text(), feature_version=(3, 6))
        imports = {node.names[0].name for node in ast.walk(tree) if isinstance(node, ast.Import)}
        self.assertEqual(imports, {'datetime', 'json', 're'})

    def test_success_and_failure_roundtrip_detaches_output(self):
        for value in [success(), failure()]:
            result = report.decode_report(json.dumps(value).encode())
            self.assertEqual(result, value)
            self.assertIsNot(result, value)
        value = success()
        self.assertIsNot(report.validate_report(value)['permissions'], value['permissions'])

    def test_unknown_fields_rejected_at_every_level(self):
        for value in [success(), failure()]:
            for field in ['apiKey', 'apiSecret', 'passphrase', 'headers', 'message', 'balances', 'accountId', 'brokerAuditId']:
                self.rejects(dict(value, **{field: 'FAKE_SECRET_DO_NOT_PRINT'}))
        value = success()
        value['permissions']['raw'] = 'FAKE_SECRET_DO_NOT_PRINT'
        self.rejects(value)

    def test_exact_types_and_timestamp(self):
        for name, values in {'schema': [True, '1', 1.0, 2], 'authenticatedRead': [1, 'true', None],
                             'feeReadVerified': [1, False, None], 'tradingAssets': [True, -1, 2001, '1'],
                             'fundingAssets': [True, -1, 2001, '1'], 'venue': ['mexc', None],
                             'scope': ['spot', None], 'checkedAt': ['2026-02-30T12:00:00Z', 'x', '2026-09-25T12:00:00Z\n']}.items():
            for value in values:
                self.rejects(dict(success(), **{name: value}))
        for key in success():
            value = success()
            del value[key]
            self.rejects(value)

    def test_error_code_allowlist_and_partial_progress(self):
        for code in report.ERRORS:
            value = dict(failure(), errorCode=code)
            self.assertEqual(report.validate_report(value), value)
        self.rejects(dict(failure(), errorCode='FAKE_SECRET_DO_NOT_PRINT'))
        for stage, count in report.STAGES.items():
            value = dict(failure(), failedStage=stage, completedReads=count or 0, authenticatedRead=bool(count))
            self.assertEqual(report.validate_report(value), value)
        partial = dict(failure(), failedStage='config', authenticatedRead=True, errorCode='invalid-response')
        self.assertEqual(report.validate_report(partial), partial)
        for stage, count, authenticated in [('credentials', 0, True), ('config', 1, True),
                                             ('trade-fee', 3, False), ('output', 5, True), ('unknown', 0, False)]:
            self.rejects(dict(failure(), failedStage=stage, completedReads=count, authenticatedRead=authenticated))

    def test_permissions_only_booleans(self):
        for key in success()['permissions']:
            for item in [0, 1, None, 'true', 'FAKE_SECRET_DO_NOT_PRINT']:
                value = success()
                value['permissions'][key] = item
                self.rejects(value)

    def test_bounded_unique_json(self):
        for value in [b'', b'x' * (report.MAX_REPORT_BYTES + 1), b'\xff', b'{"schema":1,"schema":1}',
                      b'{"schema":NaN}', b'{}{}', b'[]', json.dumps(success()), bytearray(b'{}')]:
            with self.assertRaisesRegex(report.ReportError, '^report-rejected$'):
                report.decode_report(value)

    def test_safe_credential_shape_only_on_input_failure(self):
        shape = {'format': 'json-object', 'apiKeyPresent': True, 'apiSecretPresent': True,
                 'passphrasePresent': False, 'unknownFields': 0, 'duplicateFields': False}
        value = dict(failure(), credentialShape=shape)
        self.assertEqual(report.validate_report(value), value)
        for field, unsafe in [('format', 'FAKE_SECRET_DO_NOT_PRINT'), ('unknownFields', True),
                              ('unknownFields', 101), ('apiKeyPresent', 'FAKE_SECRET_DO_NOT_PRINT'),
                              ('raw', 'FAKE_SECRET_DO_NOT_PRINT')]:
            self.rejects(dict(failure(), credentialShape=dict(shape, **{field: unsafe})))
        self.rejects(dict(value, failedStage='config'))
        self.rejects(dict(success(), credentialShape=shape))

    def test_probe_errors_fit_public_allowlist(self):
        probe = PATH.with_name('okx-account-probe.py')
        if not probe.exists():
            self.skipTest('probe still in development')
        tree = ast.parse(probe.read_text())
        assignment = next(node for node in tree.body if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == 'ERRORS' for target in node.targets))
        self.assertTrue(set(ast.literal_eval(assignment.value.args[0])).issubset(report.ERRORS))


if __name__ == '__main__':
    unittest.main()
