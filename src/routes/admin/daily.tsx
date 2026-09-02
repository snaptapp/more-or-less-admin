import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, CardLabel, CardTitle } from "@/index";
import { ErrorNote, InfoTip, PageHead } from "@/admin/AdminShell";
import { exportFactsData } from "@/lib/admin/content.functions";
import {
  deleteDailyPackAction,
  fetchDaily,
  fetchDailySchedule,
  generateDailyPack,
  moderateLeaderboardEntry,
  preScheduleDailyPack,
} from "@/lib/admin/ops.functions";

export const Route = createFileRoute("/admin/daily")({
  head: () => ({
    meta: [
      { title: "Daily Challenge — More or Less Admin" },
      { name: "description", content: "Schedule upcoming daily challenges and inspect leaderboards." },
    ],
  }),
  component: DailyPage,
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDateLabel(dateStr: string): string {
  const t = today();
  if (dateStr === t) return "Today";
  if (dateStr === addDays(t, 1)) return "Tomorrow";
  if (dateStr === addDays(t, -1)) return "Yesterday";
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function readField(round: unknown, key: string): string {
  if (round && typeof round === "object" && key in (round as Record<string, unknown>)) {
    const value = (round as Record<string, unknown>)[key];
    if (value === null || value === undefined) return "—";
    return String(value);
  }
  return "—";
}

interface EditableRound {
  round_number: number;
  topic: string;
  claim_statement: string;
  presented_number: number | string;
  true_number: number | string;
  unit: string;
  correct_direction: "MORE" | "LESS";
  explanation: string;
  surprise_factor: number;
  difficulty: "casual" | "medium" | "hard";
}

const CATEGORIES = [
  "Animals & Nature",
  "Science & Space",
  "Sports",
  "Music",
  "Movies & TV",
  "Pop Culture & Records",
  "History & World",
  "Food & Drink",
  "Technology",
  "Money & Business",
  "Deep Sea Creatures",
  "General",
];

function ScheduleDailyModal({
  initialDate,
  onDone,
}: {
  initialDate: string;
  onDone: () => void;
}) {
  const schedule = useServerFn(preScheduleDailyPack);
  const generate = useServerFn(generateDailyPack);
  const loadAllFacts = useServerFn(exportFactsData);
  const queryClient = useQueryClient();

  const [date, setDate] = useState(initialDate);
  const [category, setCategory] = useState("Science & Space");
  const [questionSearch, setQuestionSearch] = useState("");
  const [rounds, setRounds] = useState<EditableRound[]>([
    {
      round_number: 1,
      topic: "",
      claim_statement: "",
      presented_number: "",
      true_number: "",
      unit: "",
      correct_direction: "MORE",
      explanation: "",
      surprise_factor: 2,
      difficulty: "casual",
    },
  ]);
  const [generating, setGenerating] = useState(false);

  const factsQuery = useQuery({
    queryKey: ["active_facts_for_picker"],
    queryFn: () => loadAllFacts({ data: { status: "active", pageSize: 1000 } }),
    staleTime: 60_000,
  });

  const activeFacts = useMemo(() => {
    const list = Array.isArray(factsQuery.data) ? factsQuery.data : [];
    return [...list].sort((a, b) =>
      (a.subject || "").localeCompare(b.subject || "") ||
      (a.angle || "").localeCompare(b.angle || ""),
    );
  }, [factsQuery.data]);

  const filteredFacts = useMemo(() => {
    if (!questionSearch.trim()) return activeFacts;
    const term = questionSearch.trim().toLowerCase();
    return activeFacts.filter(
      (f) =>
        f.subject.toLowerCase().includes(term) ||
        (f.question && f.question.toLowerCase().includes(term)) ||
        (f.angle && f.angle.toLowerCase().includes(term)) ||
        (f.fact && f.fact.toLowerCase().includes(term)),
    );
  }, [activeFacts, questionSearch]);

  const applyFactToRound = (index: number, f: (typeof activeFacts)[number]) => {
    const trueNum = Number(f.true_number);
    const targetDirection = index % 2 === 0 ? "MORE" : "LESS";
    const multiplier = 1.8 + Math.random() * 0.8;
    let presentedNum: number;

    if (targetDirection === "MORE") {
      presentedNum = trueNum > 10 ? Math.round(trueNum / multiplier) : Number((trueNum / multiplier).toFixed(1));
    } else {
      presentedNum = trueNum > 10 ? Math.round(trueNum * multiplier) : Number((trueNum * multiplier).toFixed(1));
    }

    if (presentedNum === trueNum) {
      presentedNum = targetDirection === "MORE" ? trueNum - 1 : trueNum + 1;
    }

    const actualDirection = trueNum > presentedNum ? "MORE" : "LESS";

    updateRound(index, {
      topic: f.subject || category,
      claim_statement: f.question || f.fact || `${f.subject} - ${f.angle}`,
      true_number: trueNum,
      presented_number: presentedNum,
      unit: f.unit || "",
      correct_direction: actualDirection,
      explanation: f.context || f.fact || `${f.subject}'s true value is ${trueNum} ${f.unit}.`,
      surprise_factor: Number(f.surprise_factor ?? 2),
      difficulty: "casual",
    });
  };

  const handleAutoFill = async () => {
    try {
      setGenerating(true);
      const res = await generate({ data: { category } });
      if (res.rounds && res.rounds.length > 0) {
        setCategory(res.category || category);
        setRounds(
          res.rounds.map((r, i) => ({
            round_number: i + 1,
            topic: r.topic || category,
            claim_statement: r.claim_statement || "",
            presented_number: r.presented_number ?? "",
            true_number: r.true_number ?? "",
            unit: r.unit || "",
            correct_direction: r.correct_direction === "LESS" ? "LESS" : "MORE",
            explanation: r.explanation || "",
            surprise_factor: Number(r.surprise_factor ?? 2),
            difficulty: r.difficulty || "casual",
          })),
        );
      }
    } finally {
      setGenerating(false);
    }
  };

  const scheduleMutation = useMutation({
    mutationFn: () =>
      schedule({
        data: {
          date,
          category,
          rounds: rounds.map((r, i) => ({
            round_number: i + 1,
            topic: r.topic.trim() || category,
            claim_statement: r.claim_statement.trim(),
            presented_number: Number(r.presented_number),
            true_number: Number(r.true_number),
            unit: r.unit.trim(),
            correct_direction:
              Number(r.true_number) > Number(r.presented_number) ? "MORE" : "LESS",
            explanation: r.explanation.trim(),
            surprise_factor: Number(r.surprise_factor),
            difficulty: r.difficulty || "casual",
          })),
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["daily_schedule"] }),
        queryClient.invalidateQueries({ queryKey: ["daily", date] }),
      ]);
      onDone();
    },
  });

  const updateRound = (index: number, patch: Partial<EditableRound>) => {
    setRounds((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      // Auto-compute direction if both numbers are entered
      if (patch.true_number !== undefined || patch.presented_number !== undefined) {
        const t = Number(patch.true_number ?? next[index].true_number);
        const p = Number(patch.presented_number ?? next[index].presented_number);
        if (!isNaN(t) && !isNaN(p) && t !== p) {
          next[index].correct_direction = t > p ? "MORE" : "LESS";
        }
      }
      return next;
    });
  };

  const addRound = () => {
    if (rounds.length >= 5) return;
    setRounds((prev) => [
      ...prev,
      {
        round_number: prev.length + 1,
        topic: category,
        claim_statement: "",
        presented_number: "",
        true_number: "",
        unit: "",
        correct_direction: "MORE",
        explanation: "",
        surprise_factor: 2,
        difficulty: "casual",
      },
    ]);
  };

  const removeRound = (index: number) => {
    setRounds((prev) => prev.filter((_, i) => i !== index).map((r, i) => ({ ...r, round_number: i + 1 })));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (rounds.length < 5) {
      if (!window.confirm(`Daily challenges typically require 5 rounds (currently ${rounds.length}). Schedule anyway?`)) {
        return;
      }
    }
    scheduleMutation.mutate();
  };

  return (
    <Card style={{ border: "2px solid var(--ds-arena-color-lime, #84cc16)", marginBottom: "var(--ds-arena-space-5)" }}>
      <datalist id="daily-categories-list">
        {CATEGORIES.map((cat) => (
          <option key={cat} value={cat} />
        ))}
      </datalist>

      <form onSubmit={handleSubmit} style={{ display: "grid", gap: "var(--ds-arena-space-4)" }}>
        <div className="admin-page-head">
          <CardTitle>Schedule Daily Challenge</CardTitle>
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              type="button"
              variant="ghost"
              disabled={generating}
              onClick={() => void handleAutoFill()}
            >
              {generating ? "Pulling from bank…" : "⚡ Auto-fill 5 from Fact Bank"}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              Close
            </Button>
          </div>
        </div>

        <div className="admin-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <label className="admin-field">
            <span>Target Date</span>
            <input
              className="admin-input"
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="admin-field">
            <span>Category / Theme</span>
            <input
              className="admin-input"
              list="daily-categories-list"
              required
              placeholder="e.g. Science & Space, Deep Sea Creatures"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </label>
          <label className="admin-field">
            <span>Filter Question Dropdowns</span>
            <input
              className="admin-input"
              placeholder="Search facts by keyword…"
              value={questionSearch}
              onChange={(e) => setQuestionSearch(e.target.value)}
            />
          </label>
        </div>

        <div style={{ display: "grid", gap: "var(--ds-arena-space-3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: "var(--ds-arena-font-mono)", fontSize: 13, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Rounds ({rounds.length}/5)
            </span>
            {rounds.length < 5 ? (
              <Button type="button" size="sm" variant="ghost" onClick={addRound}>
                + Add round
              </Button>
            ) : null}
          </div>

          {rounds.map((r, i) => (
            <div
              key={i}
              style={{
                background: "var(--ds-arena-color-surface-raised, rgba(255,255,255,0.03))",
                border: "1px solid var(--ds-arena-color-border)",
                borderRadius: "var(--ds-arena-radius-md, 8px)",
                padding: "var(--ds-arena-space-3)",
                display: "grid",
                gap: "var(--ds-arena-space-2)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>Round #{i + 1}</span>
                {rounds.length > 1 ? (
                  <button
                    type="button"
                    style={{ background: "transparent", border: "none", color: "var(--ds-arena-color-red)", cursor: "pointer", fontSize: 12 }}
                    onClick={() => removeRound(i)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>

              {/* Per-Question Fact Bank Dropdown Selector */}
              <label className="admin-field" style={{ background: "rgba(132, 204, 22, 0.05)", padding: 8, borderRadius: 6, border: "1px dashed var(--ds-arena-color-lime, #84cc16)" }}>
                <span style={{ fontWeight: 600, color: "var(--ds-arena-color-lime, #84cc16)" }}>
                  ⚡ Select Question from Fact Bank (Dropdown)
                </span>
                <select
                  className="admin-select"
                  value=""
                  onChange={(e) => {
                    const factId = e.target.value;
                    const selected = activeFacts.find((f) => f.id === factId);
                    if (selected) {
                      applyFactToRound(i, selected);
                    }
                  }}
                >
                  <option value="">
                    {factsQuery.isLoading
                      ? "Loading fact bank questions…"
                      : `-- Choose from ${filteredFacts.length} verified facts to populate this question --`}
                  </option>
                  {filteredFacts.map((f) => (
                    <option key={f.id} value={f.id}>
                      [{f.subject}] {f.question || f.fact || f.angle} ({f.true_number} {f.unit})
                    </option>
                  ))}
                </select>
              </label>

              <div className="admin-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <label className="admin-field">
                  <span>Topic</span>
                  <input
                    className="admin-input"
                    value={r.topic}
                    placeholder="e.g. Cheetah, Apollo 11"
                    onChange={(e) => updateRound(i, { topic: e.target.value })}
                  />
                </label>
                <label className="admin-field">
                  <span>Question / Prompt</span>
                  <input
                    className="admin-input"
                    required
                    value={r.claim_statement}
                    placeholder="e.g. Top running speed of a cheetah"
                    onChange={(e) => updateRound(i, { claim_statement: e.target.value })}
                  />
                </label>
              </div>

              <div className="admin-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr" }}>
                <label className="admin-field">
                  <span>Presented (Guess)</span>
                  <input
                    className="admin-input"
                    type="number"
                    step="any"
                    required
                    placeholder="Fake number"
                    value={r.presented_number}
                    onChange={(e) => updateRound(i, { presented_number: e.target.value })}
                  />
                </label>
                <label className="admin-field">
                  <span>True value</span>
                  <input
                    className="admin-input"
                    type="number"
                    step="any"
                    required
                    placeholder="Actual number"
                    value={r.true_number}
                    onChange={(e) => updateRound(i, { true_number: e.target.value })}
                  />
                </label>
                <label className="admin-field">
                  <span>Unit</span>
                  <input
                    className="admin-input"
                    required
                    placeholder="mph, kg, years"
                    value={r.unit}
                    onChange={(e) => updateRound(i, { unit: e.target.value })}
                  />
                </label>
                <label className="admin-field">
                  <span>Correct Direction</span>
                  <select
                    className="admin-select"
                    value={r.correct_direction}
                    onChange={(e) =>
                      updateRound(i, { correct_direction: e.target.value as "MORE" | "LESS" })
                    }
                  >
                    <option value="MORE">MORE (True &gt; Presented)</option>
                    <option value="LESS">LESS (True &lt; Presented)</option>
                  </select>
                </label>
              </div>

              <label className="admin-field">
                <span>Reveal explanation</span>
                <input
                  className="admin-input"
                  required
                  placeholder="e.g. Cheetahs can reach up to 70 mph in short bursts."
                  value={r.explanation}
                  onChange={(e) => updateRound(i, { explanation: e.target.value })}
                />
              </label>
            </div>
          ))}
        </div>

        <ErrorNote error={scheduleMutation.error} />
        <div className="admin-row-actions">
          <Button type="submit" disabled={scheduleMutation.isPending}>
            {scheduleMutation.isPending ? "Scheduling…" : `Save & Schedule for ${date}`}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DailyPage() {
  const loadDaily = useServerFn(fetchDaily);
  const loadSchedule = useServerFn(fetchDailySchedule);
  const deletePack = useServerFn(deleteDailyPackAction);
  const removeEntry = useServerFn(moderateLeaderboardEntry);
  const queryClient = useQueryClient();

  const [date, setDate] = useState(today);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleTargetDate, setScheduleTargetDate] = useState(addDays(today(), 1));

  const scheduleQuery = useQuery({
    queryKey: ["daily_schedule"],
    queryFn: () => loadSchedule({ data: { limit: 60 } }),
  });

  const dailyQuery = useQuery({
    queryKey: ["daily", date],
    queryFn: () => loadDaily({ data: { date } }),
    retry: false,
  });

  const deleteMutation = useMutation({
    mutationFn: (d: string) => deletePack({ data: { date: d } }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["daily_schedule"] }),
        queryClient.invalidateQueries({ queryKey: ["daily", date] }),
      ]);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (uid: string) =>
      removeEntry({ data: { date, uid, reason: "Cheating/Invalid score" } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["daily", date] }),
  });

  // Build upcoming 14-day schedule timeline
  const upcomingTimeline = useMemo(() => {
    const packsMap = new Map((scheduleQuery.data?.packs || []).map((p) => [p.date, p]));
    const days: Array<{
      date: string;
      label: string;
      pack: (typeof scheduleQuery.data)["packs"][number] | null;
      isToday: boolean;
      isPast: boolean;
    }> = [];

    const t = today();
    for (let offset = -1; offset <= 14; offset++) {
      const d = addDays(t, offset);
      days.push({
        date: d,
        label: formatDateLabel(d),
        pack: packsMap.get(d) ?? null,
        isToday: d === t,
        isPast: d < t,
      });
    }
    return days;
  }, [scheduleQuery.data]);

  const pack = dailyQuery.data?.pack;
  const leaderboard = dailyQuery.data?.leaderboard;

  return (
    <>
      <PageHead
        title="Daily challenge"
        description="Schedule upcoming daily challenges, review canonical packs, and moderate leaderboards."
        actions={
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <Button
              onClick={() => {
                setScheduleTargetDate(addDays(today(), 1));
                setScheduling((v) => !v);
              }}
            >
              {scheduling ? "Close Scheduler" : "+ Schedule Daily"}
            </Button>
          </div>
        }
      />

      <ErrorNote error={scheduleQuery.error || dailyQuery.error} />

      {scheduling ? (
        <ScheduleDailyModal
          initialDate={scheduleTargetDate}
          onDone={() => setScheduling(false)}
        />
      ) : null}

      {/* Upcoming & Scheduled Daily Timeline */}
      <Card style={{ marginBottom: "var(--ds-arena-space-5)" }}>
        <div className="admin-page-head">
          <CardTitle>Upcoming &amp; Scheduled Dailies</CardTitle>
          <span style={{ fontSize: 12, color: "var(--ds-arena-color-text-muted)" }}>
            Next 14 days · Click date to inspect pack &amp; leaderboard
          </span>
        </div>

        <div className="admin-table-wrap" style={{ marginTop: "var(--ds-arena-space-3)" }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Theme / Category</th>
                <th>Status</th>
                <th>Rounds</th>
                <th>Created</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {upcomingTimeline.map((item) => {
                const isSelected = date === item.date;
                const isScheduled = Boolean(item.pack);
                return (
                  <tr
                    key={item.date}
                    style={{
                      backgroundColor: isSelected
                        ? "var(--ds-arena-color-surface-hover)"
                        : item.isToday
                          ? "rgba(132, 204, 22, 0.06)"
                          : undefined,
                    }}
                  >
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <strong style={{ fontFamily: "var(--ds-arena-font-mono)", fontSize: 13 }}>
                          {item.date}
                        </strong>
                        <span style={{ fontSize: 11, color: item.isToday ? "var(--ds-arena-color-lime)" : "var(--ds-arena-color-text-muted)" }}>
                          ({item.label})
                        </span>
                      </div>
                    </td>
                    <td>
                      {item.pack ? (
                        <Badge tone="purple">{item.pack.category}</Badge>
                      ) : (
                        <span style={{ color: "var(--ds-arena-color-text-muted)", fontStyle: "italic", fontSize: 13 }}>
                          On-demand fallback (Deep Sea Creatures)
                        </span>
                      )}
                    </td>
                    <td>
                      {isScheduled ? (
                        <Badge tone="green">✓ Pre-scheduled</Badge>
                      ) : (
                        <Badge tone="amber">Unscheduled</Badge>
                      )}
                    </td>
                    <td>{item.pack?.total_rounds ? `${item.pack.total_rounds} rounds` : "—"}</td>
                    <td style={{ fontSize: 12 }}>{item.pack?.createdAt ? item.pack.createdAt.slice(0, 10) : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      <div className="admin-row-actions" style={{ justifyContent: "flex-end" }}>
                        <Button
                          size="sm"
                          variant={isSelected ? "primary" : "ghost"}
                          onClick={() => setDate(item.date)}
                        >
                          {isSelected ? "Inspecting" : "Inspect"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setScheduleTargetDate(item.date);
                            setScheduling(true);
                          }}
                        >
                          {isScheduled ? "Edit pack" : "Schedule"}
                        </Button>
                        {isScheduled ? (
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={deleteMutation.isPending}
                            onClick={() => {
                              if (window.confirm(`Delete pre-scheduled daily pack for ${item.date}?`)) {
                                deleteMutation.mutate(item.date);
                              }
                            }}
                          >
                            Delete
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Selected Date Inspector */}
      <div className="admin-toolbar">
        <label className="admin-field" style={{ minWidth: 220 }}>
          <span>Inspect specific date</span>
          <input
            className="admin-input"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <div style={{ alignSelf: "flex-end", paddingBottom: 6 }}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setScheduleTargetDate(date);
              setScheduling(true);
            }}
          >
            {pack ? "Edit this pack" : `+ Schedule pack for ${date}`}
          </Button>
        </div>
      </div>

      {dailyQuery.isLoading ? <p className="admin-empty">Loading pack details for {date}…</p> : null}

      {dailyQuery.data && !pack ? (
        <Card>
          <CardLabel>No custom pack</CardLabel>
          <p style={{ color: "var(--ds-arena-color-text-muted)", marginTop: 4 }}>
            No pre-scheduled daily pack exists for <strong>{date}</strong> yet. When players request this date, the server will generate the fallback pack on-demand.
          </p>
          <div style={{ marginTop: "var(--ds-arena-space-3)" }}>
            <Button
              size="sm"
              onClick={() => {
                setScheduleTargetDate(date);
                setScheduling(true);
              }}
            >
              Schedule pack for {date}
            </Button>
          </div>
        </Card>
      ) : null}

      {pack ? (
        <Card>
          <div className="admin-page-head">
            <CardTitle>Daily Pack · {pack.date}</CardTitle>
            <Badge tone="purple">{pack.category || "mixed"}</Badge>
          </div>
          <dl className="admin-kv">
            <dt>Seed</dt>
            <dd>{pack.seed || "—"}</dd>
            <dt>Created</dt>
            <dd>{pack.createdAt ?? "—"}</dd>
            <dt>Rounds</dt>
            <dd>{pack.rounds.length}</dd>
          </dl>
          <div className="admin-table-wrap" style={{ marginTop: "var(--ds-arena-space-4)" }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Topic</th>
                  <th>Question / Prompt</th>
                  <th>Presented (Guess)</th>
                  <th>True Value</th>
                  <th>Direction</th>
                  <th>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {pack.rounds.map((round, index) => {
                  const trueNum = readField(round, "true_number");
                  const presentedNum = readField(round, "presented_number");
                  const dir = readField(round, "correct_direction");
                  const unit = readField(round, "unit");
                  return (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td>
                        <strong>{readField(round, "topic")}</strong>
                      </td>
                      <td>{readField(round, "claim_statement") || readField(round, "claim")}</td>
                      <td>
                        {presentedNum !== "—" ? `${presentedNum} ${unit !== "—" ? unit : ""}` : "—"}
                      </td>
                      <td>
                        <span style={{ color: "var(--ds-arena-color-lime)" }}>
                          {trueNum !== "—" ? `${trueNum} ${unit !== "—" ? unit : ""}` : "—"}
                        </span>
                      </td>
                      <td>
                        <Badge tone={dir === "MORE" ? "green" : "purple"}>{dir}</Badge>
                      </td>
                      <td style={{ maxWidth: 300, fontSize: 13 }}>{readField(round, "explanation")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/* Leaderboard */}
      {leaderboard && leaderboard.entries.length > 0 ? (
        <Card style={{ marginTop: "var(--ds-arena-space-4)" }}>
          <CardTitle>Leaderboard ({leaderboard.entries.length} player{leaderboard.entries.length === 1 ? "" : "s"})</CardTitle>
          <div className="admin-table-wrap" style={{ marginTop: "var(--ds-arena-space-3)" }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Score</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {leaderboard.entries.map((entry, index) => {
                  const uid = readField(entry, "uid");
                  return (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td>
                        <strong>
                          {readField(entry, "displayName") !== "—"
                            ? readField(entry, "displayName")
                            : uid}
                        </strong>
                      </td>
                      <td>{readField(entry, "score")}</td>
                      <td className="admin-row-actions">
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={removeMutation.isPending || uid === "—"}
                          onClick={() => {
                            if (window.confirm(`Remove score entry for ${uid} from ${date} leaderboard?`)) {
                              removeMutation.mutate(uid);
                            }
                          }}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}

