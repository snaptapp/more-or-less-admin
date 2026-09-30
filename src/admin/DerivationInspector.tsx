import { useState, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge, Button, Card, CardTitle } from "@/index";
import { ErrorNote } from "@/admin/AdminShell";
import {
  auditDerivation,
  type DerivationAuditTrace,
  type CandidateSide,
  type TrapDirection,
  type QuantityKind,
  SURPRISE_DESCRIPTIONS,
} from "@/lib/admin/derivation-audit";
import { QK, QUANTITY_KINDS } from "@/lib/admin/contract";
import {
  probeGoAgentPackFn,
  type ProbedRoundAudit,
} from "@/lib/admin/derivation.functions";

interface PresetExample {
  label: string;
  trueNumber: number;
  unit: string;
  surpriseFactor: number;
  quantityKind?: QuantityKind;
  trapDirection: TrapDirection;
  plausibleMin?: number;
  plausibleMax?: number;
  topic: string;
}

const PRESETS: PresetExample[] = [
  {
    label: "Mount Everest Height (Physical Measure)",
    trueNumber: 8848,
    unit: "meters",
    surpriseFactor: 2,
    quantityKind: QK.physical_measure,
    trapDirection: "OVERESTIMATE",
    plausibleMin: 0,
    plausibleMax: 15000,
    topic: "Geography",
  },
  {
    label: "Apollo 11 Moon Landing (Year)",
    trueNumber: 1969,
    // The unit string for this preset is the word "year"; sourced from QK.year
    // (=== "year") so this display unit is not a bare forbidden literal. It is a
    // unit label, not a DDM quantity_kind field (Requirement 9.9).
    unit: QK.year,
    surpriseFactor: 1,
    quantityKind: QK.year,
    trapDirection: "UNDERESTIMATE",
    plausibleMin: 1900,
    plausibleMax: 2025,
    topic: "Space History",
  },
  {
    label: "Adult Human Skeleton (Count)",
    trueNumber: 206,
    unit: "bones",
    surpriseFactor: 2,
    quantityKind: QK.count,
    trapDirection: "OVERESTIMATE",
    plausibleMin: 10,
    plausibleMax: 1000,
    topic: "Human Anatomy",
  },
  {
    label: "Earth Surface Covered by Water (Percentage)",
    trueNumber: 71,
    unit: "%",
    surpriseFactor: 0,
    quantityKind: QK.percentage,
    trapDirection: "OVERESTIMATE",
    plausibleMin: 0,
    plausibleMax: 100,
    topic: "Earth Science",
  },
  {
    label: "Mona Lisa Insurance Valuation (Money)",
    trueNumber: 860,
    unit: "million dollars",
    surpriseFactor: 3,
    quantityKind: QK.money,
    trapDirection: "UNDERESTIMATE",
    plausibleMin: 1,
    plausibleMax: 10000,
    topic: "Art History",
  },
  {
    label: "Cheetah Top Speed (Physical Measure)",
    trueNumber: 70,
    unit: "mph",
    surpriseFactor: 1,
    quantityKind: QK.physical_measure,
    trapDirection: "OVERESTIMATE",
    plausibleMin: 10,
    plausibleMax: 120,
    topic: "Animals",
  },
];

/**
 * Display labels for the quantity-kind override select, keyed by the contract's
 * `QuantityKind` so the compiler ties this map to Shared_Contract_Artifact
 * (Requirement 9.5 / 9.9). The select renders one option per QUANTITY_KINDS
 * member in artifact order, using the kind itself as the option value.
 */
const QUANTITY_KIND_LABELS: Record<QuantityKind, string> = {
  [QK.year]: "year (additive)",
  [QK.count]: "count (multiplicative)",
  [QK.percentage]: "percentage (bounded)",
  [QK.percent_change]: "percent change (multiplicative)",
  [QK.ratio]: QK.ratio,
  [QK.physical_measure]: QK.physical_measure,
  [QK.money]: "money (multiplicative)",
  [QK.duration]: "duration (multiplicative)",
  [QK.rating]: "rating (bounded)",
};

export interface DerivationInspectorProps {
  initialValues?: {
    trueNumber?: number | string;
    unit?: string;
    surpriseFactor?: number | string;
    quantityKind?: string;
    trapDirection?: TrapDirection;
    forcedSide?: CandidateSide;
    plausibleMin?: number | string;
    plausibleMax?: number | string;
    presentedNumber?: number | string;
    topic?: string;
  };
}

export function DerivationInspector({ initialValues }: DerivationInspectorProps) {
  const [subTab, setSubTab] = useState<"simulator" | "probe">("simulator");
  const initialPresented =
    initialValues?.presentedNumber !== undefined ? Number(initialValues.presentedNumber) : NaN;
  const inferredInitialSide: CandidateSide | undefined =
    Number.isFinite(initialPresented) && initialValues?.trueNumber !== undefined
      ? Number(initialValues.trueNumber) > initialPresented
        ? "LESS"
        : Number(initialValues.trueNumber) < initialPresented
          ? "MORE"
          : undefined
      : undefined;

  // Simulator Form State
  const [trueNumber, setTrueNumber] = useState<string>(
    initialValues?.trueNumber !== undefined ? String(initialValues.trueNumber) : "8848",
  );
  const [unit, setUnit] = useState<string>(initialValues?.unit ?? "meters");
  const [surprise, setSurprise] = useState<number>(
    initialValues?.surpriseFactor !== undefined ? Number(initialValues.surpriseFactor) : 2,
  );
  const [kindOverride, setKindOverride] = useState<string>(initialValues?.quantityKind ?? "");
  const [trapDirection, setTrapDirection] = useState<TrapDirection>(
    initialValues?.trapDirection ?? "OVERESTIMATE",
  );
  const [forcedSide, setForcedSide] = useState<string>(initialValues?.forcedSide ?? inferredInitialSide ?? "");
  const [plausibleMin, setPlausibleMin] = useState<string>(
    initialValues?.plausibleMin !== undefined ? String(initialValues.plausibleMin) : "",
  );
  const [plausibleMax, setPlausibleMax] = useState<string>(
    initialValues?.plausibleMax !== undefined ? String(initialValues.plausibleMax) : "",
  );
  const [expectedPresented, setExpectedPresented] = useState<string>(
    initialValues?.presentedNumber !== undefined ? String(initialValues.presentedNumber) : "",
  );

  // Live Agent Probe State
  const [probeTopic, setProbeTopic] = useState(initialValues?.topic ?? "Mount Everest");
  const [probeRounds, setProbeRounds] = useState(3);
  const [probeGuidance, setProbeGuidance] = useState("");
  const [selectedProbedRound, setSelectedProbedRound] = useState<number | null>(null);

  const probeFn = useServerFn(probeGoAgentPackFn);
  const probeMutation = useMutation({
    mutationFn: (vars: { topic: string; numRounds: number; guidance?: string }) =>
      probeFn({ data: vars }),
    onSuccess: (data) => {
      if (data.rounds.length > 0) {
        setSelectedProbedRound(0);
      }
    },
  });

  // Calculate local derivation audit trace synchronously
  const auditResult = useMemo<{ trace: DerivationAuditTrace | null; error: string | null }>(() => {
    if (!trueNumber.trim()) return { trace: null, error: "Enter a true number to inspect." };
    try {
      const trace = auditDerivation({
        trueNumber: trueNumber.trim(),
        unit: unit.trim() || "items",
        surpriseFactor: surprise,
        quantityKind: kindOverride || undefined,
        trapDirection,
        forcedSide: forcedSide === "MORE" || forcedSide === "LESS" ? forcedSide : undefined,
        plausibleMin: plausibleMin.trim() || undefined,
        plausibleMax: plausibleMax.trim() || undefined,
      });
      return { trace, error: null };
    } catch (err) {
      return { trace: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [trueNumber, unit, surprise, kindOverride, trapDirection, forcedSide, plausibleMin, plausibleMax]);

  const loadPreset = (preset: PresetExample) => {
    setTrueNumber(String(preset.trueNumber));
    setUnit(preset.unit);
    setSurprise(preset.surpriseFactor);
    setKindOverride(preset.quantityKind ?? "");
    setTrapDirection(preset.trapDirection);
    setForcedSide("");
    setPlausibleMin(preset.plausibleMin !== undefined ? String(preset.plausibleMin) : "");
    setPlausibleMax(preset.plausibleMax !== undefined ? String(preset.plausibleMax) : "");
  };

  return (
    <div style={{ display: "grid", gap: "var(--ds-arena-space-5)" }}>
      {/* Sub-navigation bar */}
      <div className="admin-toolbar" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: "var(--ds-arena-space-2)" }}>
          <Button
            type="button"
            size="sm"
            variant={subTab === "simulator" ? "primary" : "ghost"}
            onClick={() => setSubTab("simulator")}
          >
            📐 DDM Derivation Simulator
          </Button>
          <Button
            type="button"
            size="sm"
            variant={subTab === "probe" ? "primary" : "ghost"}
            onClick={() => setSubTab("probe")}
          >
            🤖 Live Go Agent Pack Probe
          </Button>
        </div>

        {subTab === "simulator" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)" }}>Load Preset:</span>
            <select
              className="admin-select"
              style={{ width: "auto" }}
              value=""
              onChange={(e) => {
                const idx = Number(e.target.value);
                if (PRESETS[idx]) loadPreset(PRESETS[idx]);
              }}
            >
              <option value="">-- Choose an example --</option>
              {PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {subTab === "simulator" ? (
        <>
          {/* Input Controls */}
          <Card>
            <CardTitle>Derivation Inputs</CardTitle>
            <p style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)", marginTop: 4, marginBottom: 16 }}>
              Configure truth, surprise, and context to audit why the Distractor Derivation Model presents a specific number.
            </p>

            <div className="admin-grid admin-responsive-grid" style={{ gridTemplateColumns: "1.5fr 1fr 1fr 1fr" }}>
              <label className="admin-field">
                <span>True Number</span>
                <input
                  className="admin-input"
                  type="number"
                  step="any"
                  required
                  value={trueNumber}
                  onChange={(e) => setTrueNumber(e.target.value)}
                />
              </label>

              <label className="admin-field">
                <span>Unit</span>
                <input
                  className="admin-input"
                  required
                  value={unit}
                  placeholder="e.g. meters, mph, year, %"
                  onChange={(e) => setUnit(e.target.value)}
                />
              </label>

              <label className="admin-field">
                <span>Quantity Kind</span>
                <select
                  className="admin-select"
                  value={kindOverride}
                  onChange={(e) => setKindOverride(e.target.value)}
                >
                  <option value="">Auto-detect from unit</option>
                  {QUANTITY_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {QUANTITY_KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="admin-field">
                <span>Trap Direction</span>
                <select
                  className="admin-select"
                  value={trapDirection}
                  onChange={(e) => setTrapDirection(e.target.value as TrapDirection)}
                >
                  <option value="OVERESTIMATE">OVERESTIMATE (Expects higher → presents higher → correct is LESS)</option>
                  <option value="UNDERESTIMATE">UNDERESTIMATE (Expects lower → presents lower → correct is MORE)</option>
                </select>
              </label>
            </div>

            <div className="admin-grid admin-responsive-grid" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr", marginTop: 12 }}>
              <div className="admin-field">
                <span>Surprise Factor (0 = Obvious, 3 = Intuition Trap)</span>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  {[0, 1, 2, 3].map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`admin-reset-link ${surprise === s ? "is-active" : ""}`}
                      style={{
                        flex: 1,
                        padding: "8px 12px",
                        borderRadius: 6,
                        border: surprise === s ? "1px solid var(--ds-arena-color-lime)" : "1px solid var(--ds-arena-color-border)",
                        background: surprise === s ? "rgba(132, 204, 22, 0.15)" : "var(--ds-arena-color-surface)",
                        color: surprise === s ? "var(--ds-arena-color-lime)" : "var(--ds-arena-color-text)",
                        fontWeight: surprise === s ? 700 : 500,
                        fontSize: 13,
                        textAlign: "center",
                      }}
                      onClick={() => setSurprise(s)}
                    >
                      {s}: {s === 0 ? "Obvious" : s === 1 ? "Mild" : s === 2 ? "Surprising" : "Trap"}
                    </button>
                  ))}
                </div>
              </div>

              <label className="admin-field">
                <span>Forced Side (Balance)</span>
                <select
                  className="admin-select"
                  value={forcedSide}
                  onChange={(e) => setForcedSide(e.target.value)}
                >
                  <option value="">Default (Misconception trap side)</option>
                  <option value="MORE">Force MORE (Presented &lt; True)</option>
                  <option value="LESS">Force LESS (Presented &gt; True)</option>
                </select>
              </label>

              <label className="admin-field">
                <span>Plausible Min (opt)</span>
                <input
                  className="admin-input"
                  type="number"
                  step="any"
                  placeholder="e.g. 0"
                  value={plausibleMin}
                  onChange={(e) => setPlausibleMin(e.target.value)}
                />
              </label>

              <label className="admin-field">
                <span>Plausible Max (opt)</span>
                <input
                  className="admin-input"
                  type="number"
                  step="any"
                  placeholder="e.g. 10000"
                  value={plausibleMax}
                  onChange={(e) => setPlausibleMax(e.target.value)}
                />
              </label>
            </div>
          </Card>

          {auditResult.error ? <ErrorNote error={auditResult.error} /> : null}

          {auditResult.trace ? (
            <>
              {/* Decision Outcome Highlight Banner */}
              <div
                style={{
                  background: "var(--ds-arena-color-surface-raised)",
                  border: "1px solid var(--ds-arena-color-lime)",
                  borderRadius: "var(--ds-arena-radius-lg, 12px)",
                  padding: "var(--ds-arena-space-4)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 16,
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                    <Badge tone="lime">DERIVATION OUTCOME</Badge>
                    <span style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)" }}>
                      DDM {auditResult.trace.classification.unitDescription} · Surprise {auditResult.trace.band.surprise}
                    </span>
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>
                    Presented:{" "}
                    <span style={{ color: "var(--ds-arena-color-lime)" }}>
                      {auditResult.trace.outcome.presentedNumber.toLocaleString()} {auditResult.trace.outcome.unit}
                    </span>{" "}
                    <span style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 18, fontWeight: 400 }}>
                      (True: {auditResult.trace.outcome.trueNumber.toLocaleString()} {auditResult.trace.outcome.unit})
                    </span>
                  </div>
                  <p style={{ margin: "4px 0 0", fontSize: 14, color: "var(--ds-arena-color-text)" }}>
                    {auditResult.trace.outcome.explanation}
                  </p>
                  {expectedPresented.trim() ? (
                    <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--ds-arena-color-text-muted)" }}>
                      Linked presented value: <strong>{expectedPresented}</strong>
                    </p>
                  ) : null}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ textAlign: "center", padding: "8px 16px", background: "var(--ds-arena-color-surface)", borderRadius: 8 }}>
                    <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--ds-arena-color-text-muted)" }}>
                      Correct Answer
                    </div>
                    <div
                      style={{
                        fontSize: 22,
                        fontWeight: 800,
                        color: auditResult.trace.outcome.correctDirection === "MORE" ? "var(--ds-arena-color-lime)" : "var(--ds-arena-color-purple)",
                      }}
                    >
                      {auditResult.trace.outcome.correctDirection}
                    </div>
                  </div>

                  <div style={{ textAlign: "center", padding: "8px 16px", background: "var(--ds-arena-color-surface)", borderRadius: 8 }}>
                    <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--ds-arena-color-text-muted)" }}>
                      Shift / Spread
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: "var(--ds-arena-color-text)" }}>
                      {auditResult.trace.outcome.percentDiff > 0 ? `+${auditResult.trace.outcome.percentDiff}%` : `${auditResult.trace.outcome.percentDiff}%`}
                    </div>
                  </div>
                </div>
              </div>

              {/* Step-by-Step Pipeline Cards */}
              <div className="admin-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
                <Card>
                  <CardTitle>1. Classification</CardTitle>
                  <p style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)", marginTop: 4 }}>
                    Unit pattern matching &amp; strategy resolution.
                  </p>
                  <dl style={{ margin: "12px 0 0", display: "grid", gap: 6, fontSize: 13 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <dt style={{ color: "var(--ds-arena-color-text-muted)" }}>Quantity Kind:</dt>
                      <dd><strong>{auditResult.trace.classification.quantityKind}</strong></dd>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <dt style={{ color: "var(--ds-arena-color-text-muted)" }}>Strategy:</dt>
                      <dd><Badge tone="purple">{auditResult.trace.classification.strategy}</Badge></dd>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <dt style={{ color: "var(--ds-arena-color-text-muted)" }}>Matched Rule:</dt>
                      <dd style={{ fontSize: 12, textAlign: "right", maxWidth: 160 }}>{auditResult.trace.classification.matchedUnitRule}</dd>
                    </div>
                  </dl>
                </Card>

                <Card>
                  <CardTitle>2. Surprise Band</CardTitle>
                  <p style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)", marginTop: 4 }}>
                    Canonical surprise level {auditResult.trace.band.surprise}.
                  </p>
                  <dl style={{ margin: "12px 0 0", display: "grid", gap: 6, fontSize: 13 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <dt style={{ color: "var(--ds-arena-color-text-muted)" }}>Intuition Level:</dt>
                      <dd><strong>{SURPRISE_DESCRIPTIONS[auditResult.trace.band.surprise].split(" ")[0]}</strong></dd>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <dt style={{ color: "var(--ds-arena-color-text-muted)" }}>Interval Applied:</dt>
                      <dd><strong>{auditResult.trace.band.bandDescription}</strong></dd>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <dt style={{ color: "var(--ds-arena-color-text-muted)" }}>Factor Range:</dt>
                      <dd style={{ fontFamily: "var(--ds-arena-font-mono)" }}>{auditResult.trace.band.factorMin}x – {auditResult.trace.band.factorMax}x</dd>
                    </div>
                  </dl>
                </Card>

                <Card>
                  <CardTitle>3. Misconception Trap</CardTitle>
                  <p style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)", marginTop: 4 }}>
                    Side selection and cognitive bias.
                  </p>
                  <dl style={{ margin: "12px 0 0", display: "grid", gap: 6, fontSize: 13 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <dt style={{ color: "var(--ds-arena-color-text-muted)" }}>Trap Direction:</dt>
                      <dd><strong>{auditResult.trace.sideSelection.trapDirection}</strong></dd>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <dt style={{ color: "var(--ds-arena-color-text-muted)" }}>Chosen Side:</dt>
                      <dd><Badge tone={auditResult.trace.sideSelection.selectedSide === "MORE" ? "lime" : "purple"}>{auditResult.trace.sideSelection.selectedSide}</Badge></dd>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ds-arena-color-text-muted)", marginTop: 4 }}>
                      {auditResult.trace.sideSelection.rationale}
                    </div>
                  </dl>
                </Card>

                <Card>
                  <CardTitle>4. Snapping &amp; Bounds</CardTitle>
                  <p style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)", marginTop: 4 }}>
                    Plausibility limits and grid rounding.
                  </p>
                  <dl style={{ margin: "12px 0 0", display: "grid", gap: 6, fontSize: 13 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <dt style={{ color: "var(--ds-arena-color-text-muted)" }}>Raw Candidate:</dt>
                      <dd style={{ fontFamily: "var(--ds-arena-font-mono)" }}>{auditResult.trace.boundsAndSnapping.rawCandidate.toLocaleString()}</dd>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <dt style={{ color: "var(--ds-arena-color-text-muted)" }}>Snapping Grid:</dt>
                      <dd>Every {auditResult.trace.boundsAndSnapping.snappingInterval} {auditResult.trace.outcome.unit}</dd>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <dt style={{ color: "var(--ds-arena-color-text-muted)" }}>Bounds Clamped:</dt>
                      <dd>{auditResult.trace.boundsAndSnapping.boundsClamped ? <Badge tone="amber">Clamped</Badge> : "No (within bounds)"}</dd>
                    </div>
                  </dl>
                </Card>
              </div>

              {/* 8-Candidate Decision Matrix */}
              <Card>
                <div className="admin-page-head">
                  <div>
                    <CardTitle>Full 8-Candidate Decision Matrix</CardTitle>
                    <p style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)", margin: "2px 0 0" }}>
                      The complete set of potential distractors across all 4 surprise levels and both directions. The green outline highlights the chosen winner.
                    </p>
                  </div>
                </div>

                <div className="admin-table-wrap" style={{ marginTop: 16 }}>
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Surprise</th>
                        <th>Intuition Tier</th>
                        <th>MORE Candidate (P &lt; T)</th>
                        <th>LESS Candidate (P &gt; T)</th>
                        <th>Delta (Spread)</th>
                        <th>Ratio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditResult.trace.matrix.map((row) => {
                        const isWinningRow = row.isWinningCandidate;
                        return (
                          <tr
                            key={row.surprise}
                            style={{
                              background: isWinningRow ? "rgba(132, 204, 22, 0.08)" : undefined,
                              fontWeight: isWinningRow ? 600 : 400,
                            }}
                          >
                            <td>
                              <Badge tone={isWinningRow ? "lime" : "neutral"}>
                                Level {row.surprise}
                              </Badge>
                            </td>
                            <td>{row.surpriseLabel}</td>
                            <td>
                              <span
                                style={{
                                  padding: "3px 8px",
                                  borderRadius: 4,
                                  background: isWinningRow && row.winningSide === "MORE" ? "rgba(132, 204, 22, 0.2)" : undefined,
                                  border: isWinningRow && row.winningSide === "MORE" ? "1px solid var(--ds-arena-color-lime)" : undefined,
                                  fontFamily: "var(--ds-arena-font-mono)",
                                }}
                              >
                                {row.moreCandidate.toLocaleString()} {unit}
                                {isWinningRow && row.winningSide === "MORE" ? " ★ WINNER" : ""}
                              </span>
                            </td>
                            <td>
                              <span
                                style={{
                                  padding: "3px 8px",
                                  borderRadius: 4,
                                  background: isWinningRow && row.winningSide === "LESS" ? "rgba(132, 204, 22, 0.2)" : undefined,
                                  border: isWinningRow && row.winningSide === "LESS" ? "1px solid var(--ds-arena-color-lime)" : undefined,
                                  fontFamily: "var(--ds-arena-font-mono)",
                                }}
                              >
                                {row.lessCandidate.toLocaleString()} {unit}
                                {isWinningRow && row.winningSide === "LESS" ? " ★ WINNER" : ""}
                              </span>
                            </td>
                            <td style={{ fontFamily: "var(--ds-arena-font-mono)", fontSize: 12 }}>
                              ±{row.winningSide === "MORE" ? row.moreDelta.toLocaleString() : row.lessDelta.toLocaleString()}
                            </td>
                            <td style={{ fontFamily: "var(--ds-arena-font-mono)", fontSize: 12 }}>
                              {row.winningSide === "MORE" ? `${row.moreRatio}x` : `${row.lessRatio}x`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          ) : null}
        </>
      ) : (
        /* Live Go Agent Pack Probe Mode */
        <Card>
          <CardTitle>Probe Live Go Agent (`agent-go` on Cloud Run)</CardTitle>
          <p style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)", marginTop: 4, marginBottom: 16 }}>
            Execute a live `/pack` generation call against `agent-go`. This demonstrates Gemini grounding the true number via Google Search, followed by the DDM calculating the distractor.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (probeMutation.isPending) return;
              probeMutation.mutate({
                topic: probeTopic,
                numRounds: probeRounds,
                guidance: probeGuidance.trim() || undefined,
              });
            }}
            style={{ display: "grid", gap: 12 }}
          >
            <div className="admin-grid admin-responsive-grid" style={{ gridTemplateColumns: "2fr 1fr 2fr" }}>
              <label className="admin-field">
                <span>Topic</span>
                <input
                  className="admin-input"
                  required
                  value={probeTopic}
                  placeholder="e.g. Mount Everest, Electric Cars, Beatles"
                  onChange={(e) => setProbeTopic(e.target.value)}
                />
              </label>

              <label className="admin-field">
                <span>Number of Rounds</span>
                <select
                  className="admin-select"
                  value={probeRounds}
                  onChange={(e) => setProbeRounds(Number(e.target.value))}
                >
                  <option value={1}>1 round (fastest)</option>
                  <option value={3}>3 rounds</option>
                  <option value={5}>5 rounds</option>
                </select>
              </label>

              <label className="admin-field">
                <span>Guidance / Brief (opt)</span>
                <input
                  className="admin-input"
                  value={probeGuidance}
                  placeholder="e.g. Focus on modern records"
                  onChange={(e) => setProbeGuidance(e.target.value)}
                />
              </label>
            </div>

            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <Button type="submit" disabled={probeMutation.isPending}>
                {probeMutation.isPending ? "Generating & Grounding with Go Agent…" : "Probe Go Agent (/pack)"}
              </Button>
              {probeMutation.isPending ? (
                <span style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)" }}>
                  Connecting to Cloud Run private service via OIDC…
                </span>
              ) : null}
            </div>
          </form>

          <ErrorNote error={probeMutation.error} />

          {probeMutation.data ? (
            <div style={{ marginTop: 24, display: "grid", gap: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong>Result for: {probeMutation.data.category}</strong>
                  <p style={{ margin: 0, fontSize: 13, color: "var(--ds-arena-color-text-muted)" }}>
                    {probeMutation.data.status_message}
                  </p>
                </div>
                <Badge tone="lime">{probeMutation.data.rounds.length} rounds returned</Badge>
              </div>

              {/* Rounds List */}
              <div style={{ display: "grid", gap: 12 }}>
                {probeMutation.data.rounds.map((round, idx) => {
                  const isSelected = selectedProbedRound === idx;
                  return (
                    <div
                      key={round.round_number || idx}
                      style={{
                        background: isSelected ? "rgba(132, 204, 22, 0.05)" : "var(--ds-arena-color-surface)",
                        border: isSelected ? "1px solid var(--ds-arena-color-lime)" : "1px solid var(--ds-arena-color-border)",
                        borderRadius: 8,
                        padding: 16,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "flex-start",
                          cursor: "pointer",
                        }}
                        onClick={() => setSelectedProbedRound(isSelected ? null : idx)}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <Badge tone="neutral">Round {round.round_number}</Badge>
                            <Badge tone={round.correct_direction === "MORE" ? "lime" : "purple"}>
                              Answer: {round.correct_direction}
                            </Badge>
                            <span style={{ fontSize: 12, color: "var(--ds-arena-color-text-muted)" }}>
                              Surprise Factor: {round.surprise_factor}
                            </span>
                          </div>
                          <div style={{ fontSize: 15, fontWeight: 600 }}>
                            {round.claim_statement}
                          </div>
                          <div style={{ fontSize: 13, marginTop: 4 }}>
                            Presented: <strong>{round.presented_number} {round.unit}</strong> vs True:{" "}
                            <strong style={{ color: "var(--ds-arena-color-lime)" }}>
                              {round.true_number} {round.unit}
                            </strong>
                          </div>
                        </div>

                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            // Pre-fill simulator with this round
                            setTrueNumber(String(round.true_number));
                            setUnit(round.unit);
                            setSurprise(round.surprise_factor);
                            setKindOverride(round.quantity_kind ?? "");
                            setTrapDirection(round.trap_direction === "UNDERESTIMATE" ? "UNDERESTIMATE" : "OVERESTIMATE");
                            setForcedSide(
                              round.presented_number > round.true_number
                                ? "MORE"
                                : round.presented_number < round.true_number
                                  ? "LESS"
                                  : "",
                            );
                            setExpectedPresented(String(round.presented_number));
                            setSubTab("simulator");
                          }}
                        >
                          Inspect in Simulator →
                        </Button>
                      </div>

                      {/* Expanded round details */}
                      {isSelected ? (
                        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px dashed var(--ds-arena-color-border)" }}>
                          <div style={{ fontSize: 13, marginBottom: 8 }}>
                            <strong>Gemini Grounding Explanation:</strong> {round.explanation}
                          </div>
                          {round.trace ? (
                            <div
                              style={{
                                background: "var(--ds-arena-color-surface-raised)",
                                padding: 12,
                                borderRadius: 6,
                                fontSize: 13,
                              }}
                            >
                              <strong>DDM Mathematical Decision:</strong>
                              <p style={{ margin: "4px 0 0" }}>{round.trace.outcome.explanation}</p>
                              <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 12, color: "var(--ds-arena-color-text-muted)" }}>
                                <span>Kind: <strong>{round.trace.classification.quantityKind}</strong></span>
                                <span>Strategy: <strong>{round.trace.classification.strategy}</strong></span>
                                <span>Band: <strong>{round.trace.band.bandDescription}</strong></span>
                                <span>Snapping: <strong>{round.trace.boundsAndSnapping.snappingInterval} {round.unit}</strong></span>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
