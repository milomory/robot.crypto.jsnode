#!/usr/bin/env python3
"""Build a local pinned Data app from an existing paired-paper report; no API calls."""
import argparse
import datetime as dt
import decimal
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

PLUGIN = Path('/home/anton/.codex/plugins/cache/openai-curated-remote/data-analytics/1.0.11')
HERE = Path(__file__).resolve().parent
DECIMAL = re.compile(r'^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$')
DAY_POLICY = 'mexc-okx-paired-study-24h-v1'
PROFILES = {
    'mexc-okx-paired-probe-v1': (60, 5_000, 'проверочный сбор 5 минут'),
    'mexc-okx-paired-study-30m-v1': (360, 5_000, '30 минут наблюдения'),
    DAY_POLICY: (1_440, 60_000, '24 часа наблюдения'),
}
FIXTURE_LABEL = 'synthetic-not-real-results'


def iso(value):
    if type(value) is not int or value <= 0:
        raise ValueError('invalid-report-timestamp')
    return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def numeric(value):
    if not isinstance(value, str) or not DECIMAL.fullmatch(value):
        raise ValueError('invalid-chart-decimal')
    parsed = float(decimal.Decimal(value))
    if not math.isfinite(parsed):
        raise ValueError('non-finite-chart-value')
    return parsed


def prepare_snapshot(path, legacy, synthetic_fixture=False):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('invalid-report-file')
    raw = path.read_bytes()
    report = json.loads(raw)
    if report.get('kind') != 'paired-paper-report' or report.get('schema') != 1 or report.get('executable') is not False or report.get('funding') != 'synthetic':
        raise ValueError('unsupported-report')
    fixture = report.get('chartFixture')
    if fixture is not None and fixture != FIXTURE_LABEL:
        raise ValueError('unsupported-chart-fixture')
    if (fixture == FIXTURE_LABEL) != synthetic_fixture:
        raise ValueError('synthetic-fixture-requires-explicit-label')
    policy = report['plan'].get('policy')
    if policy not in PROFILES:
        raise ValueError('unsupported-chart-policy')
    expected_samples, expected_interval, period_title = PROFILES[policy]
    day_study = policy == DAY_POLICY
    if not day_study and len(raw) > 2 * 1024 * 1024:
        raise ValueError('invalid-report-file')
    study = report.get('study')
    if ((policy == 'mexc-okx-paired-probe-v1') != (study is None)
            or study is not None and study.get('policy') != policy):
        raise ValueError('inconsistent-study-policy')
    if not study and not legacy:
        raise ValueError('legacy-report-requires-explicit-legacy-quote')
    selected = study.get('selectedFeeScenario') if study else 'legacy-quote'
    allowed_scenarios = (None, 'quote', 'okx-received-base') if study else ('legacy-quote',)
    if selected not in allowed_scenarios:
        raise ValueError('unknown-selected-fee-scenario')
    observations = report.get('observations')
    scheduled = report['coverage']['scheduledPairs']
    if (type(scheduled) is not int or scheduled != expected_samples
            or report['plan'].get('samples') != scheduled or report['plan'].get('intervalMs') != expected_interval
            or not isinstance(observations, list) or len(observations) != scheduled):
        raise ValueError('incomplete-report-observations')
    start, end = iso(report['period']['startedAt']), iso(report['period']['endedAt'])
    if start > end:
        raise ValueError('invalid-report-period')
    fee_times = [report['feeEvidence']['fees'][venue]['requestedAt'] for venue in ('mexc', 'okx')]
    for value in fee_times:
        iso(value)
        if value > report['period']['startedAt']:
            raise ValueError('invalid-frozen-fee-time')
    maximum_fee_age_ms = report['period']['endedAt'] - min(fee_times)
    if day_study and (study.get('feePolicy') != 'initial-observed-fees-frozen-sensitivity-only'
            or study.get('feeRatesContinuouslyVerified') is not False
            or study.get('maximumFeeEvidenceAgeMs') != maximum_fee_age_ms
            or study.get('settingsFrozenAtStart') is not True):
        raise ValueError('invalid-day-fee-policy')
    instrument_coverage = None
    if day_study:
        refreshes = study.get('instrumentRefreshes')
        if (not isinstance(refreshes, dict) or type(refreshes.get('scheduled')) is not int
                or refreshes['scheduled'] != 48 or type(study.get('metadataComplete')) is not bool
                or any(type(refreshes.get(field)) is not int or not 0 <= refreshes[field] <= 48
                       for field in ('availableMexc', 'availableOkx'))):
            raise ValueError('invalid-day-instrument-coverage')
        instrument_coverage = {**refreshes, 'complete': study['metadataComplete']}
        if instrument_coverage['complete'] != (refreshes['availableMexc'] == 48 and refreshes['availableOkx'] == 48):
            raise ValueError('inconsistent-day-instrument-coverage')
    diagnostics = report.get('diagnostics')
    protocol_warning = None
    if diagnostics is not None:
        if (not isinstance(diagnostics, dict) or diagnostics.get('mode') != 'schedule-diagnostics'
                or diagnostics.get('protocolConformant') is not False
                or diagnostics.get('rawArchiveUnchanged') is not True):
            raise ValueError('unsupported-report-diagnostics')
        excluded = diagnostics.get('excludedEarlySlots')
        if not isinstance(excluded, list) or not excluded or report['coverage'].get('complete') is not False:
            raise ValueError('invalid-report-diagnostics')
        excluded_sequences = set()
        for item in excluded:
            sequence, early = item.get('sequence'), item.get('earlyByMs')
            if (type(sequence) is not int or not 0 <= sequence < scheduled or sequence in excluded_sequences
                    or type(early) is not int or early <= 0):
                raise ValueError('invalid-excluded-slot')
            excluded_sequences.add(sequence)
            if observations[sequence]['status'] != 'unavailable' or observations[sequence]['directions']:
                raise ValueError('excluded-slot-still-plotted')
        protocol_warning = ('Исходное расписание не пройдено: ' + str(len(excluded))
            + ' ранних слотов исключены. Диагностический отчёт, исходные данные сохранены.')
    rows = []
    for sequence, sample in enumerate(observations):
        if sample['sequence'] != sequence:
            raise ValueError('invalid-report-sequence')
        row = {'sequence': sequence, 'at': iso(sample['at']), 'atUtc': iso(sample['at']).replace('T', ' ')[:-1] + ' UTC', 'mexcToOkx': None, 'okxToMexc': None,
               'mexcToOkxExact': None, 'okxToMexcExact': None, 'zero': 0,
               'sampleStatus': sample['status'], 'paperDecision': sample['paperDecision']}
        seen = set()
        if sample['status'] == 'available' and selected is not None:
            for direction in sample['directions']:
                buy, sell = direction['buyVenue'], direction['sellVenue']
                if (buy, sell) not in [('mexc', 'okx'), ('okx', 'mexc')] or buy in seen:
                    raise ValueError('invalid-report-direction')
                seen.add(buy)
                key = 'mexcToOkx' if buy == 'mexc' else 'okxToMexc'
                if selected == 'legacy-quote':
                    value = direction['netUsdt']
                else:
                    scenario = 'quote' if selected == 'quote' else 'okxReceivedBase'
                    value = direction['feeScenarios'][scenario]['netUsdt']
                row[key] = numeric(value)
                row[key + 'Exact'] = value
        rows.append(row)
    if any(a['at'] > b['at'] for a, b in zip(rows, rows[1:])):
        raise ValueError('non-monotonic-report-time')
    if any(not start <= row['at'] <= end for row in rows):
        raise ValueError('observation-outside-report-period')
    mode_label = {'quote': 'Комиссия OKX в USDT', 'okx-received-base': 'Комиссия покупки OKX в BTC',
                  'legacy-quote': 'Проверочный сбор: условная комиссия в USDT', None: 'Режим комиссии не подтверждён'}[selected]
    title = 'MEXC ↔ OKX · ' + period_title
    if diagnostics is not None:
        title += ' · диагностика'
    fixture_warning = 'СИНТЕТИЧЕСКИЙ ТЕСТ / SYNTHETIC — не реальные результаты наблюдения.' if synthetic_fixture else None
    if synthetic_fixture:
        title = 'SYNTHETIC · ' + title
    quantity = report['plan']['quantityBTC']
    usd_coverage = study.get('usdIndexCoverage') if study else None
    assumptions = [
        '**Расчётная разница в USDT на одну пару сделок, не прибыль счёта.** Выше нуля — положительная оценка после смоделированных затрат.',
        'Направление означает: купить на первой бирже, продать на второй. Объём продажи — ' + quantity + ' BTC.',
        mode_label + ('. Для покупки OKX в BTC объём покупки увеличен, чтобы компенсировать комиссию.' if selected == 'okx-received-base' else '.'),
        'Тарифы зафиксированы перед сбором; запас на проскальзывание — ' + report['costs']['mexc']['slippageBps'] + ' б.п. на каждой стороне. Уменьшение тарифа и промоакции не предполагаются.',
        'Снимки каждые ' + str(report['plan']['intervalMs'] // 1000) + ' секунд. Пропуски оставлены разрывами. Соединение точек не доказывает непрерывную возможность между снимками.',
        'Стаканы получены через REST. Время источника MEXC неизвестно. Шаг заявки MEXC и формула USD-допуска OKX не подтверждены.',
        'Капитал в модели виртуальный. Реальные ордера и переводы не выполнялись. Допуск к реальному исполнению не подтверждён.'
    ]
    fee_age_minutes = math.ceil(maximum_fee_age_ms / 60_000)
    fee_age_label = str(fee_age_minutes // 60) + ' ч ' + str(fee_age_minutes % 60) + ' мин'
    frozen_fee_label = ('Начальные комиссии зафиксированы; расчёт чувствительности к затратам, '
        'тарифы не проверялись непрерывно.' if day_study else 'Начальные комиссии зафиксированы на весь сбор.')
    assumptions.append(frozen_fee_label + ' Максимальный возраст сведений к концу сбора: ' + fee_age_label
        + ' (округлено вверх до минуты).')
    positive_counts = [{
        'direction': label,
        'evaluated': sum(row[field] is not None for row in rows),
        'positive': (sum(decimal.Decimal(row[field + 'Exact']) > 0 for row in rows if row[field] is not None)
                     if selected is not None else None),
    } for field, label in [('mexcToOkx', 'MEXC → OKX'), ('okxToMexc', 'OKX → MEXC')]]
    if selected == 'okx-received-base':
        assumptions.append('Комиссия покупки в BTC округляется вверх до 8 знаков. Это допущение модели, не подтверждённая точность удержания комиссии и не шаг заявки биржи.')
    if usd_coverage:
        assumptions.append('Индекс BTC/USD: ' + str(usd_coverage['available']) + ' из ' + str(usd_coverage['scheduled']) + ' снимков. Для оценки USD-лимита добавлен запас 1%; он не гарантирует покрытие худшего случая и не подтверждает допуск биржей.')
    digest = hashlib.sha256(raw).hexdigest()
    methods = [
        {'language': 'text', 'code': 'Read completed report.json. Retain every observations[] sample in original sequence and sample.at UTC. For each buyVenue, read feeScenarios[study.selectedFeeScenario === "quote" ? "quote" : "okxReceivedBase"].netUsdt; if selected mode is null, retain null chart values. Explicit legacy mode uses direction.netUsdt and is labelled as assumed USDT fees. Never select headline values instead of the observed scenario.'},
        {'language': 'text', 'code': 'Keep exact decimal strings in mexcToOkxExact / okxToMexcExact. Convert them to finite numbers only for the visual axis. Count positive observations separately by direction using exact Decimal(netUsdt) > 0; denominator is available chart values for that direction, not all scheduled slots. Missing and schedule-diagnostics excluded observations remain null, not zero. Maximum fee evidence age is report end minus the earliest venue fee requestedAt, displayed rounded upward to a minute. App buildStatus is authoring completion, not capture protocol acceptance. zero=0 is a declared mathematical reference, not a market observation. No sums or interpolation create source rows.'}
    ]
    return {
        'title': title, 'surface': 'report', 'status': 'reviewed', 'generatedAt': end, 'buildStatus': 'creating', 'filters': [],
        'report': {'asOf': end[:10], 'originalQuestion': 'Как менялась расчётная разница MEXC и OKX после затрат за завершённый период?'},
        'pairStudy': {'scope': mode_label + ' · ' + quantity + ' BTC · только завершённые снимки',
            'selectedScenario': selected, 'protocolWarning': protocol_warning, 'fixtureWarning': fixture_warning, 'dayStudy': day_study,
            'periodLabel': start[:19].replace('T', ' ') + ' — ' + end[:19].replace('T', ' ') + ' UTC',
            'crossesUtcDate': start[:10] != end[:10], 'positiveCounts': positive_counts, 'instrumentCoverage': instrument_coverage,
            'frozenFeeLabel': frozen_fee_label, 'maximumFeeEvidenceAgeMs': maximum_fee_age_ms, 'feeAgeLabel': fee_age_label,
            'scheduledPairs': scheduled, 'availablePairs': report['coverage']['availablePairs'],
            'chartPoints': min(sum(row[field] is not None for row in rows) for field in ['mexcToOkx', 'okxToMexc']),
            'paperPairs': report['counts']['paperPairs'], 'assumptions': '\n\n'.join(assumptions)},
        'queries': {'pair-net-selected': {'label': 'Расчётная разница выбранного режима комиссии', 'reportingField': 'at',
            'rows': rows, 'methods': methods, 'source': {
                'label': 'Завершённый paired-paper-report', 'files': ['report.json'], 'executedAt': end,
                'timezone': 'UTC', 'coverage': {'scheduledPairs': scheduled, **report['coverage']},
                'caveats': [warning for warning in [fixture_warning, protocol_warning, frozen_fee_label] if warning],
                'diagnostics': diagnostics,
                'evidenceFlow': [{'title': 'Исходный отчёт', 'detail': 'report.json, SHA256 ' + digest + '; archive SHA256 ' + report['archiveHash']},
                    {'title': 'Публичные данные', 'detail': 'MEXC GET /api/v3/depth?symbol=BTCUSDT&limit=50; OKX GET /api/v5/market/books?instId=BTC-USDT&sz=50; fixed completed capture ' + report['captureId']},
                    {'title': 'Режим комиссии', 'detail': mode_label + '; frozen payment settings from report.feeEvidence.paymentModes; no new account or market requests during chart generation.'}],
                'metricDefinitions': [{'label': 'Расчётная разница после затрат', 'definition': 'USDT, получаемые при продаже, минус USDT для покупки с комиссиями и запасом на проскальзывание по выбранному режиму отчёта. В случае BTC-комиссии OKX учтено увеличение покупки. Не доходность и не реализованная прибыль.', 'componentIds': ['pair-net-time'], 'sourceLineage': [{'files': ['report.json']}]},
                    {'label': 'Ноль после затрат', 'definition': 'Математическая линия netUsdt = 0; не отдельное наблюдение биржи.', 'componentIds': ['pair-net-time']}]
            }}}, 'sourceReportSha256': digest
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--legacy-quote', action='store_true')
    parser.add_argument('--synthetic-fixture', action='store_true', help='Require and visibly label a synthetic chart QA fixture; never real observation results')
    parser.add_argument('--node', default='/usr/bin/node')
    parser.add_argument('--data-plugin', type=Path, default=PLUGIN)
    parser.add_argument('--build-status', choices=['creating', 'complete'], default='complete')
    args = parser.parse_args()
    snapshot = prepare_snapshot(args.report, args.legacy_quote, args.synthetic_fixture)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    marker = output / '.pair-study-chart.json'
    if output.exists():
        if not marker.is_file() or json.loads(marker.read_text()).get('generator') != 'pair-study-chart-v1':
            raise ValueError('refuse-unowned-chart-directory')
        previous = json.loads((output / 'src/data.json').read_text())
        snapshot['id'] = previous['id']
    else:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', encoding='utf8') as tmp:
            json.dump(snapshot, tmp, ensure_ascii=False); tmp.flush()
            subprocess.run([args.node, str(args.data_plugin / 'scripts/prepare-data-app.mjs'), '--surface', 'report',
                '--output', str(output), '--snapshot', tmp.name, '--blank'], check=True, stdout=subprocess.DEVNULL)
        snapshot['id'] = json.loads((output / 'src/data.json').read_text())['id']
        marker.write_text(json.dumps({'generator': 'pair-study-chart-v1'}) + '\n')
    snapshot['buildStatus'] = args.build_status
    (output / 'src/data.json').write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n')
    for name in ['ReportContent.jsx', 'pair-study.css']:
        (output / 'src/content/report' / name).write_text((HERE / 'pair-study-chart' / name).read_text())
    subprocess.run([args.node, str(args.data_plugin / 'scripts/data-app.mjs'), 'build', '--project-dir', str(output), '--separate-data'], check=True)
    offline = output / '.data-app-offline/exports/pair-study.html'
    subprocess.run([args.node, str(args.data_plugin / 'scripts/data-app.mjs'), 'export-offline',
        '--project-dir', str(output), '--output', str(offline)], check=True)
    shutil.copyfile(offline, output / 'pair-study.html')
    print(json.dumps({'output': str(output / 'dist/index.html'), 'portableHtml': str(output / 'pair-study.html'), 'sourceSha256': snapshot['sourceReportSha256'],
        'selectedScenario': snapshot['pairStudy']['selectedScenario'], 'rows': len(snapshot['queries']['pair-net-selected']['rows'])}))


if __name__ == '__main__':
    main()
