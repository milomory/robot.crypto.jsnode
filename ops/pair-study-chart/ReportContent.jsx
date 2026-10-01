import React from "react";
import { EvidenceChart, ReportSection, RichNarrative, useDataApp } from "../../data-app-public.jsx";
import "./pair-study.css";

const spec = {
  type: "line", x: "at", y: "mexcToOkx", fields: ["mexcToOkx", "okxToMexc"],
  stackable: false, startAtZero: true, xLabel: "Время UTC", yLabel: "USDT на пару сделок",
  valueDecimals: 6, yTickCount: 5,
  colors: { mexcToOkx: "#2764a5", okxToMexc: "#b37117" },
  legend: { labels: { mexcToOkx: "MEXC → OKX", okxToMexc: "OKX → MEXC" } },
  annotations: [{ id: "zero-reference", kind: "benchmark", measure: "mexcToOkx", field: "zero", label: "Ноль после затрат" }]
};
// The day plot keeps zero as a reviewed mathematical series. Automatic annotation
// label placement walks every SVG path repeatedly and stalls dense jagged series.
// No source rows are removed; the legacy chart keeps its original annotation.
const daySpec = {
  ...spec, fields: [...spec.fields, "zero"], annotations: [],
  colors: { ...spec.colors, zero: "#74787f" },
  legend: { labels: { ...spec.legend.labels, zero: "Ноль после затрат" } }
};
export function ReportContent() {
  const { snapshot, reviewedRows, appTitle, canEdit, mode, setAppTitle } = useDataApp();
  const rows = reviewedRows("pair-net-selected", ["at"]);
  const info = snapshot.pairStudy;
  const utcTime = value => new Date(value).toISOString().slice(info.crossesUtcDate ? 0 : 11, 19).replace("T", " ") + " UTC";
  return <article className="report-content pair-study-chart" aria-label="Расчётная разница MEXC и OKX">
    <header className="report-hero">
      <h1 data-data-app-title contentEditable={canEdit && mode === "edit"} suppressContentEditableWarning
        onBlur={canEdit && mode === "edit" ? event => setAppTitle(event.currentTarget.textContent.trim() || appTitle) : undefined}>{appTitle}</h1>
      <RichNarrative id="pair-study:scope" value={info.scope} className="report-deck" />
    </header>
    {info.fixtureWarning && <p className="pair-study-warning pair-study-fixture" role="note">{info.fixtureWarning}</p>}
    {info.protocolWarning && <ReportSection id="pair-study-protocol" title="Расписание не прошло проверку"
      queryId="pair-net-selected" sourceRows={rows} showHeading={false}>
      <p className="pair-study-warning" role="note" data-reviewed-rows>{info.protocolWarning}</p>
    </ReportSection>}
    <ReportSection id="pair-study-coverage" title="Покрытие наблюдения" queryId="pair-net-selected" sourceRows={rows} showHeading={false}>
      <div className="pair-study-coverage" data-reviewed-rows>
        <span><strong>{info.availablePairs} / {info.scheduledPairs}</strong> пар стаканов</span>
        <span><strong>{info.chartPoints} / {info.scheduledPairs}</strong> точек на направлении</span>
        <span><strong>{info.paperPairs}</strong> бумажных пар сделок</span>
      </div>
      {info.instrumentCoverage && <p className="pair-study-period" data-reviewed-rows>
        Правила: MEXC {info.instrumentCoverage.availableMexc}/{info.instrumentCoverage.scheduled} · OKX {info.instrumentCoverage.availableOkx}/{info.instrumentCoverage.scheduled}
        {!info.instrumentCoverage.complete && <strong> · покрытие неполное</strong>}
      </p>}
      <p className="pair-study-period" data-reviewed-rows>{info.periodLabel}</p>
      <div className="pair-study-positive" data-reviewed-rows aria-label="Положительные наблюдения по направлениям">
        <strong>Выше нуля после затрат</strong>
        {info.positiveCounts.map(item => <span key={item.direction}>{item.direction}: <b>{item.positive === null ? "нет расчёта" : `${item.positive} / ${item.evaluated}`}</b></span>)}
        <small>Из рассчитанных наблюдений каждого направления; это не число исполненных сделок.</small>
      </div>
      <p className="pair-study-fees" data-reviewed-rows>{info.frozenFeeLabel} Возраст сведений к концу сбора: <strong>до {info.feeAgeLabel}</strong> (округлено вверх).</p>
    </ReportSection>
    {info.selectedScenario === null
      ? <ReportSection id="pair-study-unavailable" title="Расчёт недоступен" queryId="pair-net-selected" sourceRows={rows}>
          <RichNarrative id="pair-study:unavailable" value="Фактический режим комиссии не подтверждён. График выбранного режима недоступен; условные значения не подставлены." />
        </ReportSection>
      : <EvidenceChart id="pair-net-time" queryId="pair-net-selected" title="Разница после комиссий и запаса на проскальзывание"
          spec={info.dayStudy ? daySpec : spec} rows={rows} sourceRows={rows} height={360}>
          {rows.length > 0 && <div className="pair-study-endpoints" data-reviewed-rows aria-label="Границы всей выборки">
            <span>Начало выборки<br /><strong>{utcTime(rows[0].at)}</strong></span>
            <span>Конец выборки<br /><strong>{utcTime(rows.at(-1).at)}</strong></span>
          </div>}
        </EvidenceChart>}
    <ReportSection id="pair-study-assumptions" title="Как читать график" queryId="pair-net-selected" sourceRows={rows}>
      <RichNarrative id="pair-study:assumptions" value={info.assumptions} />
    </ReportSection>
  </article>;
}
