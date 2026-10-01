"""Offline chart contracts. Every generated market row here is synthetic QA data."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('pair_study_chart', Path(__file__).with_name('render-pair-study-chart.py'))
CHART = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHART)


def synthetic_report(policy=CHART.DAY_POLICY):
    count, interval, _ = CHART.PROFILES[policy]
    start = 1_790_402_400_000
    end = start + (count - 1) * interval + 1_000
    rows = []
    for sequence in range(count):
        # Consecutive and isolated missing rows exercise honest line breaks.
        available = sequence not in (16, 17, 720)
        directions = []
        if available:
            for buy, sell, sign in [('mexc', 'okx', 1), ('okx', 'mexc', -1)]:
                value = ('-' if (sequence // 20) % 2 == (sign == -1) else '') + '0.012345678901234567'
                directions.append({'buyVenue': buy, 'sellVenue': sell, 'netUsdt': '0.99',
                    'feeScenarios': {'quote': {'netUsdt': '0.99'}, 'okxReceivedBase': {'netUsdt': value}}})
        rows.append({'sequence': sequence, 'at': start + sequence * interval, 'status': 'available' if available else 'unavailable',
                     'directions': directions, 'paperDecision': 'frozen-fees-sensitivity-only'})
    report = {'kind': 'paired-paper-report', 'schema': 1, 'funding': 'synthetic', 'executable': False,
        'chartFixture': CHART.FIXTURE_LABEL, 'captureId': 'SYNTHETIC-CHART-QA-NOT-A-CAPTURE', 'archiveHash': '0' * 64,
        'plan': {'policy': policy, 'samples': count, 'intervalMs': interval, 'quantityBTC': '0.0001'},
        'period': {'startedAt': start, 'endedAt': end}, 'costs': {'mexc': {'slippageBps': '5'}},
        'feeEvidence': {'fees': {'mexc': {'requestedAt': start - 120_000}, 'okx': {'requestedAt': start - 60_000}}},
        'coverage': {'scheduledPairs': count, 'availablePairs': sum(row['status'] == 'available' for row in rows), 'complete': False},
        'counts': {'paperPairs': 0}, 'observations': rows}
    if policy != 'mexc-okx-paired-probe-v1':
        report['study'] = {'policy': policy, 'selectedFeeScenario': 'okx-received-base', 'settingsFrozenAtStart': True}
    if policy == CHART.DAY_POLICY:
        report['study'].update({'feePolicy': 'initial-observed-fees-frozen-sensitivity-only',
            'feeRatesContinuouslyVerified': False, 'maximumFeeEvidenceAgeMs': end - start + 120_000,
            'instrumentRefreshes': {'scheduled': 48, 'availableMexc': 47, 'availableOkx': 48}, 'metadataComplete': False})
    return report


class PairStudyChartTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='synthetic-pair-chart-test-')
        self.path = Path(self.directory.name) / 'synthetic-report.json'

    def tearDown(self):
        self.directory.cleanup()

    def chart(self, report, legacy=False, fixture=True):
        self.path.write_text(json.dumps(report))
        return CHART.prepare_snapshot(self.path, legacy, fixture)

    def test_day_selected_scenario_exact_counts_and_gaps(self):
        report = synthetic_report()
        chart = self.chart(report)
        rows = chart['queries']['pair-net-selected']['rows']
        self.assertEqual(len(rows), 1440)
        self.assertEqual(rows[0]['mexcToOkxExact'], '-0.012345678901234567')
        self.assertEqual(rows[0]['okxToMexcExact'], '0.012345678901234567')
        self.assertIsNone(rows[16]['mexcToOkx'])
        self.assertEqual(chart['pairStudy']['chartPoints'], 1437)
        self.assertEqual(sum(item['positive'] for item in chart['pairStudy']['positiveCounts']), 1437)
        self.assertTrue(all(item['evaluated'] == 1437 for item in chart['pairStudy']['positiveCounts']))
        self.assertIn('24 часа', chart['title'])
        self.assertIn('SYNTHETIC', chart['title'])
        self.assertIn('не реальные результаты', chart['pairStudy']['fixtureWarning'])
        self.assertTrue(chart['pairStudy']['crossesUtcDate'])
        self.assertIn('2026-09-27', chart['pairStudy']['periodLabel'])
        self.assertEqual(chart['pairStudy']['feeAgeLabel'], '24 ч 2 мин')
        self.assertIn('не проверялись непрерывно', chart['pairStudy']['frozenFeeLabel'])

    def test_null_fee_selection_has_no_zero_or_fallback(self):
        report = synthetic_report()
        report['study']['selectedFeeScenario'] = None
        chart = self.chart(report)
        self.assertTrue(all(row['mexcToOkx'] is None for row in chart['queries']['pair-net-selected']['rows']))
        self.assertTrue(all(item['positive'] is None for item in chart['pairStudy']['positiveCounts']))
        self.assertEqual(chart['pairStudy']['chartPoints'], 0)

    def test_quote_selection_does_not_use_base_scenario(self):
        report = synthetic_report()
        report['study']['selectedFeeScenario'] = 'quote'
        chart = self.chart(report)
        self.assertEqual(chart['queries']['pair-net-selected']['rows'][0]['mexcToOkxExact'], '0.99')
        self.assertEqual(chart['pairStudy']['positiveCounts'][0]['positive'], 1437)

    def test_zero_is_not_positive(self):
        report = synthetic_report()
        report['observations'][0]['directions'][1]['feeScenarios']['okxReceivedBase']['netUsdt'] = '0'
        self.assertEqual(sum(item['positive'] for item in self.chart(report)['pairStudy']['positiveCounts']), 1436)

    def test_unknown_scenario_refused(self):
        report = synthetic_report(); report['study']['selectedFeeScenario'] = 'unknown'
        with self.assertRaisesRegex(ValueError, 'unknown-selected-fee-scenario'):
            self.chart(report)

    def test_study_cannot_fall_back_to_legacy_headline(self):
        report = synthetic_report(); report['study']['selectedFeeScenario'] = 'legacy-quote'
        with self.assertRaisesRegex(ValueError, 'unknown-selected-fee-scenario'):
            self.chart(report)

    def test_fixture_requires_explicit_flag(self):
        with self.assertRaisesRegex(ValueError, 'synthetic-fixture-requires-explicit-label'):
            self.chart(synthetic_report(), fixture=False)

    def test_flag_cannot_relabel_real_report(self):
        report = synthetic_report(); report.pop('chartFixture')
        with self.assertRaisesRegex(ValueError, 'synthetic-fixture-requires-explicit-label'):
            self.chart(report)

    def test_day_over_2mib_but_below_16mib(self):
        report = synthetic_report(); report['qaPadding'] = 'x' * (2 * 1024 * 1024)
        self.assertEqual(self.chart(report)['pairStudy']['scheduledPairs'], 1440)

    def test_over_16mib_refused(self):
        self.path.write_bytes(b' ' * (16 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, 'invalid-report-file'):
            CHART.prepare_snapshot(self.path, False, True)

    def test_legacy_still_2mib_limit(self):
        report = synthetic_report('mexc-okx-paired-probe-v1'); report['qaPadding'] = 'x' * (2 * 1024 * 1024)
        with self.assertRaisesRegex(ValueError, 'invalid-report-file'):
            self.chart(report, legacy=True)

    def test_legacy_needs_quote_flag(self):
        with self.assertRaisesRegex(ValueError, 'legacy-report-requires-explicit-legacy-quote'):
            self.chart(synthetic_report('mexc-okx-paired-probe-v1'))
        chart = self.chart(synthetic_report('mexc-okx-paired-probe-v1'), legacy=True)
        self.assertIn('5 минут', chart['title'])
        self.assertEqual(chart['pairStudy']['selectedScenario'], 'legacy-quote')

    def test_30m_diagnostic_remains_visible(self):
        report = synthetic_report('mexc-okx-paired-study-30m-v1')
        report['diagnostics'] = {'mode': 'schedule-diagnostics', 'protocolConformant': False,
            'rawArchiveUnchanged': True, 'excludedEarlySlots': [{'sequence': 16, 'earlyByMs': 1}]}
        chart = self.chart(report)
        self.assertIn('30 минут', chart['title'])
        self.assertIn('диагностика', chart['title'])
        self.assertIn('1 ранних слотов', chart['pairStudy']['protocolWarning'])
        self.assertIsNone(chart['queries']['pair-net-selected']['rows'][16]['mexcToOkx'])
        report['diagnostics']['excludedEarlySlots'][0]['sequence'] = 0
        with self.assertRaisesRegex(ValueError, 'excluded-slot-still-plotted'):
            self.chart(report)

    def test_day_fee_claims_must_match_actual_evidence_age(self):
        for key, value in [('feePolicy', 'real-time'), ('maximumFeeEvidenceAgeMs', 0),
                           ('feeRatesContinuouslyVerified', True), ('settingsFrozenAtStart', False)]:
            with self.subTest(key=key):
                report = synthetic_report(); report['study'][key] = value
                with self.assertRaisesRegex(ValueError, 'invalid-day-fee-policy'):
                    self.chart(report)

    def test_day_rule_refresh_coverage_must_be_bounded_and_consistent(self):
        report = synthetic_report()
        self.assertEqual(self.chart(report)['pairStudy']['instrumentCoverage'],
            {'scheduled': 48, 'availableMexc': 47, 'availableOkx': 48, 'complete': False})
        for field, value in [('scheduled', 49), ('availableMexc', -1), ('availableOkx', 49), ('availableOkx', True)]:
            with self.subTest(field=field, value=value):
                changed = synthetic_report(); changed['study']['instrumentRefreshes'][field] = value
                with self.assertRaisesRegex(ValueError, 'invalid-day-instrument-coverage'): self.chart(changed)
        report['study']['metadataComplete'] = True
        with self.assertRaisesRegex(ValueError, 'inconsistent-day-instrument-coverage'): self.chart(report)
        report['study']['instrumentRefreshes']['availableMexc'] = 48
        self.assertTrue(self.chart(report)['pairStudy']['instrumentCoverage']['complete'])

    def test_missing_or_future_fee_evidence_refused(self):
        report = synthetic_report(); report['feeEvidence']['fees']['mexc']['requestedAt'] = report['period']['startedAt'] + 1
        with self.assertRaisesRegex(ValueError, 'invalid-frozen-fee-time'):
            self.chart(report)

    def test_incomplete_or_mismatched_profile_refused(self):
        for change in ['observations', 'samples', 'interval', 'study']:
            with self.subTest(change=change):
                report = synthetic_report()
                if change == 'observations': report['observations'].pop()
                elif change == 'samples': report['plan']['samples'] = 360
                elif change == 'interval': report['plan']['intervalMs'] = 5000
                else: report['study']['policy'] = 'mexc-okx-paired-study-30m-v1'
                with self.assertRaises(ValueError): self.chart(report)

    def test_timestamp_outside_period_refused(self):
        report = synthetic_report(); report['observations'][-1]['at'] = report['period']['endedAt'] + 1
        with self.assertRaisesRegex(ValueError, 'observation-outside-report-period'):
            self.chart(report)

    def test_symlink_refused(self):
        self.path.write_text(json.dumps(synthetic_report()))
        link = self.path.with_name('link.json'); link.symlink_to(self.path)
        with self.assertRaisesRegex(ValueError, 'invalid-report-file'):
            CHART.prepare_snapshot(link, False, True)


if __name__ == '__main__':
    unittest.main()
