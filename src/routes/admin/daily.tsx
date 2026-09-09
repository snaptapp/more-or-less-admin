import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, CardLabel, CardTitle } from "@/index";
import { DailyBlitzChat } from "@/admin/DailyBlitzChat";
import { ErrorNote, PageHead } from "@/admin/AdminShell";
import { exportFactsData } from "@/lib/admin/content.functions";
import {
  DAILY_BLITZ_FALLBACK_CATEGORY,
  DAILY_BLITZ_ROUNDS,
  DAILY_BLITZ_SECONDS,
  BLITZ_CATEGORIES,
  addUtcDays,
  calendarStripDates,
  directionFromNumbers,
  emptyRound,
  factToBlitzRound,
  formatDateLabel,
  mapPackRounds,
  roundReadyToSchedule,
  schedulePayload,
  utcToday,
  type EditableRound,
} from "@/lib/admin/daily-blitz";
import {
  deleteDailyPackAction,
  fetchDaily,
  fetchDailySchedule,
  fillDailyDraftsAction,
  generateDailyPack,
  moderateLeaderboardEntry,
  preScheduleDailyPack,
} from "@/lib/admin/ops.functions";

export const Route = createFileRoute("/admin/daily")({
  head: () => ({
    meta: [
      { title: "Daily Blitz | More or Less Admin" },
      {
        name: "description",
        content: "Front-fill 15-round Daily Blitz packs. 15 questions, 60 seconds.",
      },
    ],
  }),
  component: DailyPage,
});

interface DateDraft {
  category: string;
  brief: string;
  rounds: EditableRound[];
}

function readField(round: unknown, key: string): string {
  if (round && typeof round === "object" && key in (round as Record<string, unknown>)) {
    const value = (round as Record<string, unknown>)[key];
    if (value === null || value === undefined) return "-";
    return String(value);
  }
  return "-";
}

function BlitzEditor({
  date,
  draft,
  liveRoundCount,
  onChange,
  onSaved,
}: {
  date: string;
  draft: DateDraft;
  liveRoundCount: number | null;
  onChange: (patch: Partial<DateDraft>) => void;
  onSaved: () => void;
}) {
  const schedule = useServerFn(preScheduleDailyPack);
  const generate = useServerFn(generateDailyPack);
  const loadAllFacts = useServerFn(exportFactsData);
  const queryClient = useQueryClient();

  const [questionSearch, setQuestionSearch] = useState("");
  const [expanded, setExpanded] = useState<number | null>(0);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const factsQuery = useQuery({
    queryKey: ["active_facts_for_picker"],
    queryFn: () => loadAllFacts({ data: { status: "active", pageSize: 1000 } }),
    staleTime: 60_000,
  });

  const activeFacts = useMemo(() => {
    const list = Array.isArray(factsQuery.data) ? factsQuery.data : [];
    return [...list].sort(
      (a, b) =>
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
        (f.context && f.context.toLowerCase().includes(term)),
    );
  }, [activeFacts, questionSearch]);

  const updateRound = (index: number, patch: Partial<EditableRound>) => {
    const next = [...draft.rounds];
    if (!next[index]) return;
    next[index] = { ...next[index], ...patch };
    if (patch.true_number !== undefined || patch.presented_number !== undefined) {
      const t = Number(patch.true_number ?? next[index].true_number);
      const p = Number(patch.presented_number ?? next[index].presented_number);
      if (!Number.isNaN(t) && !Number.isNaN(p) && t !== p) {
        next[index].correct_direction = directionFromNumbers(t, p);
      }
    }
    onChange({ rounds: next.map((r, i) => ({ ...r, round_number: i + 1 })) });
  };

  const applyFactToRound = (index: number, factId: string) => {
    const selected = activeFacts.find((f) => f.id === factId);
    if (!selected || selected.true_number === null) return;
    const preferred: "MORE" | "LESS" = index % 2 === 0 ? "MORE" : "LESS";
    const result = factToBlitzRound({
      factId: selected.id,
      subject: selected.subject,
      question: selected.question,
      angle: selected.angle,
      context: selected.context,
      unit: selected.unit,
      true_number: selected.true_number,
      surprise_factor: selected.surprise_factor,
      derivation: selected.derivation,
      preferredSide: preferred,
      round_number: index + 1,
      topic: selected.subject || draft.category,
    });
    if ("error" in result) {
      window.alert(result.error);
      return;
    }
    updateRound(index, result.round);
  };

  const handleDraftWithGo = async () => {
    try {
      setGenerating(true);
      setGenerateError(null);
      const res = await generate({
        data: {
          topic: draft.category.trim() || DAILY_BLITZ_FALLBACK_CATEGORY,
          brief: draft.brief,
          numRounds: DAILY_BLITZ_ROUNDS,
        },
      });
      if (res.rounds.length) {
        onChange({
          category: res.category || draft.category,
          rounds: res.rounds,
        });
        setExpanded(0);
      }
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Go agent draft failed.");
    } finally {
      setGenerating(false);
    }
  };

  const addRound = () => {
    if (draft.rounds.length >= DAILY_BLITZ_ROUNDS) return;
    onChange({
      rounds: [...draft.rounds, emptyRound(draft.rounds.length + 1, draft.category)],
    });
  };

  const removeRound = (index: number) => {
    onChange({
      rounds: draft.rounds.filter((_, i) => i !== index).map((r, i) => ({ ...r, round_number: i + 1 })),
    });
  };

  const scheduleMutation = useMutation({
    mutationFn: () =>
      schedule({
        data: {
          date,
          category: draft.category.trim() || DAILY_BLITZ_FALLBACK_CATEGORY,
          rounds: schedulePayload(draft.rounds, draft.category),
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["daily_schedule"] }),
        queryClient.invalidateQueries({ queryKey: ["daily", date] }),
      ]);
      onSaved();
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.rounds.length < DAILY_BLITZ_ROUNDS) {
      if (
        !window.confirm(
          `Daily Blitz is ${DAILY_BLITZ_ROUNDS} questions. This draft has ${draft.rounds.length}. Save anyway? Undersized packs are not Blitz-ready.`,
        )
      ) {
        return;
      }
    }
    const incomplete = draft.rounds.findIndex((r) => !roundReadyToSchedule(r));
    if (incomplete >= 0) {
      setGenerateError(
        `Round ${incomplete + 1} needs a claim, unit, explanation, and unequal true/presented numbers.`,
      );
      return;
    }
    setGenerateError(null);
    scheduleMutation.mutate();
  };

  const filled = draft.rounds.filter((r) => r.claim_statement.trim()).length;
  const undersized = draft.rounds.length < DAILY_BLITZ_ROUNDS;

  return (
    <Card>
      <form onSubmit={handleSubmit} style={{ display: "grid", gap: "var(--ds-arena-space-4)" }}>
        <datalist id="daily-blitz-categories">
          {BLITZ_CATEGORIES.map((cat) => (
            <option key={cat} value={cat} />
          ))}
        </datalist>

        <div className="admin-page-head">
          <div>
            <CardTitle>Editor · {date}</CardTitle>
            <p style={{ margin: "4px 0 0", color: "var(--ds-arena-color-text-muted)", fontSize: 13 }}>
              Drafts stay in this page until Save writes daily_packs/{date}. Unreviewed drafts do not go live.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {liveRoundCount ? (
              <Badge tone={liveRoundCount >= DAILY_BLITZ_ROUNDS ? "lime" : "amber"}>
                Live {liveRoundCount}/{DAILY_BLITZ_ROUNDS}
              </Badge>
            ) : (
              <Badge tone="amber">Not published</Badge>
            )}
            <Button type="button" variant="ghost" disabled={generating} onClick={() => void handleDraftWithGo()}>
              {generating ? "Grounding 15 rounds…" : "Draft with Go agent"}
            </Button>
          </div>
        </div>

        <div className="admin-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <label className="admin-field">
            <span>Topic / category</span>
            <input
              className="admin-input"
              list="daily-blitz-categories"
              required
              placeholder="e.g. Sports, NBA scoring"
              value={draft.category}
              onChange={(e) => onChange({ category: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>Brief (guidance, not the topic)</span>
            <input
              className="admin-input"
              placeholder="Mix eras, skip Super Bowl, 8 MORE / 7 LESS"
              value={draft.brief}
              onChange={(e) => onChange({ brief: e.target.value })}
            />
          </label>
          <label className="admin-field">
            <span>Filter fact-bank dropdowns</span>
            <input
              className="admin-input"
              placeholder="Search facts…"
              value={questionSearch}
              onChange={(e) => setQuestionSearch(e.target.value)}
            />
          </label>
        </div>

        {undersized ? (
          <p className="admin-error">
            Soft warning: {draft.rounds.length}/{DAILY_BLITZ_ROUNDS} rounds. Daily Blitz play is 15 questions.
            Draft with the Go agent, or add rounds before Save.
          </p>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: "var(--ds-arena-color-text-muted)" }}>
            {filled} claims filled · {draft.rounds.length}/{DAILY_BLITZ_ROUNDS} slots
          </p>
        )}

        <ErrorNote error={generateError || scheduleMutation.error} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span
            style={{
              fontFamily: "var(--ds-arena-font-mono)",
              fontSize: 13,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Rounds ({draft.rounds.length}/{DAILY_BLITZ_ROUNDS})
          </span>
          {draft.rounds.length < DAILY_BLITZ_ROUNDS ? (
            <Button type="button" size="sm" variant="ghost" onClick={addRound}>
              + Add round
            </Button>
          ) : null}
        </div>

        <div className="admin-table-wrap">
          <table className="admin-table daily-blitz-round-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Claim</th>
                <th>Presented</th>
                <th>True</th>
                <th>Dir</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {draft.rounds.map((r, i) => {
                const open = expanded === i;
                return (
                  <Fragment key={r.round_number || i}>
                    <tr key={`row-${i}`} className={open ? "is-editing" : undefined}>
                      <td>
                        <button
                          type="button"
                          className="admin-reset-link"
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? null : i)}
                        >
                          {i + 1}
                        </button>
                      </td>
                      <td>
                        <strong>{r.claim_statement || "(empty)"}</strong>
                      </td>
                      <td>
                        {r.presented_number === "" ? "-" : `${r.presented_number} ${r.unit}`}
                      </td>
                      <td style={{ color: "var(--ds-arena-color-lime)" }}>
                        {r.true_number === "" ? "-" : `${r.true_number} ${r.unit}`}
                      </td>
                      <td>
                        <Badge tone={r.correct_direction === "MORE" ? "lime" : "purple"}>
                          {r.correct_direction}
                        </Badge>
                      </td>
                      <td>
                        {draft.rounds.length > 1 ? (
                          <button
                            type="button"
                            className="admin-reset-link"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              removeRound(i);
                            }}
                          >
                            Remove
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {open ? (
                      <tr key={`edit-${i}`} className="admin-inline-editor-row">
                        <td colSpan={6} className="admin-inline-editor-cell">
                          <div style={{ display: "grid", gap: 10 }}>
                            <label
                              className="admin-field"
                              style={{
                                background: "rgba(132, 204, 22, 0.05)",
                                padding: 8,
                                borderRadius: 6,
                                border: "1px dashed var(--ds-arena-color-lime, #84cc16)",
                              }}
                            >
                              <span style={{ fontWeight: 600, color: "var(--ds-arena-color-lime, #84cc16)" }}>
                                Swap from fact bank (DDM-gated distractor)
                              </span>
                              <select
                                className="admin-select"
                                value=""
                                onChange={(e) => {
                                  const factId = e.target.value;
                                  if (factId) applyFactToRound(i, factId);
                                  e.target.value = "";
                                }}
                              >
                                <option value="">
                                  {factsQuery.isLoading
                                    ? "Loading fact bank…"
                                    : `-- ${filteredFacts.length} verified facts --`}
                                </option>
                                {filteredFacts.map((f) => (
                                  <option key={f.id} value={f.id}>
                                    [{f.subject}] {f.question || f.angle} ({f.true_number} {f.unit})
                                    {f.derivation?.distractors?.length ? "" : " · no DDM"}
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
                                  onChange={(e) => updateRound(i, { topic: e.target.value })}
                                />
                              </label>
                              <label className="admin-field">
                                <span>Question / prompt</span>
                                <input
                                  className="admin-input"
                                  required
                                  value={r.claim_statement}
                                  onChange={(e) => updateRound(i, { claim_statement: e.target.value })}
                                />
                              </label>
                            </div>
                            <div className="admin-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr" }}>
                              <label className="admin-field">
                                <span>Presented</span>
                                <input
                                  className="admin-input"
                                  type="number"
                                  step="any"
                                  required
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
                                  value={r.true_number}
                                  onChange={(e) => updateRound(i, { true_number: e.target.value })}
                                />
                              </label>
                              <label className="admin-field">
                                <span>Unit</span>
                                <input
                                  className="admin-input"
                                  required
                                  value={r.unit}
                                  onChange={(e) => updateRound(i, { unit: e.target.value })}
                                />
                              </label>
                              <label className="admin-field">
                                <span>Direction</span>
                                <select
                                  className="admin-select"
                                  value={r.correct_direction}
                                  onChange={(e) =>
                                    updateRound(i, { correct_direction: e.target.value as "MORE" | "LESS" })
                                  }
                                >
                                  <option value="MORE">MORE (true &gt; presented)</option>
                                  <option value="LESS">LESS (true &lt; presented)</option>
                                </select>
                              </label>
                            </div>
                            <label className="admin-field">
                              <span>Reveal explanation</span>
                              <input
                                className="admin-input"
                                required
                                value={r.explanation}
                                onChange={(e) => updateRound(i, { explanation: e.target.value })}
                              />
                            </label>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="admin-row-actions">
          <Button type="submit" disabled={scheduleMutation.isPending || generating}>
            {scheduleMutation.isPending ? "Saving…" : `Save & Schedule for ${date}`}
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
  const fillDrafts = useServerFn(fillDailyDraftsAction);
  const removeEntry = useServerFn(moderateLeaderboardEntry);
  const queryClient = useQueryClient();

  const [date, setDate] = useState(utcToday);
  const [drafts, setDrafts] = useState<Record<string, DateDraft>>({});

  const scheduleQuery = useQuery({
    queryKey: ["daily_schedule"],
    queryFn: () => loadSchedule({ data: { limit: 60 } }),
  });

  const dailyQuery = useQuery({
    queryKey: ["daily", date],
    queryFn: () => loadDaily({ data: { date } }),
    retry: false,
  });

  const pack = dailyQuery.data?.pack;
  const leaderboard = dailyQuery.data?.leaderboard;

  useEffect(() => {
    if (drafts[date]) return;
    if (dailyQuery.isLoading) return;
    if (pack?.rounds?.length) {
      setDrafts((prev) => ({
        ...prev,
        [date]: {
          category: pack.category || DAILY_BLITZ_FALLBACK_CATEGORY,
          brief: "",
          rounds: mapPackRounds(pack.rounds, pack.category || DAILY_BLITZ_FALLBACK_CATEGORY),
        },
      }));
      return;
    }
    setDrafts((prev) => ({
      ...prev,
      [date]: {
        category: DAILY_BLITZ_FALLBACK_CATEGORY,
        brief: "",
        rounds: [emptyRound(1, DAILY_BLITZ_FALLBACK_CATEGORY)],
      },
    }));
  }, [date, drafts, dailyQuery.isLoading, pack]);

  const draft = drafts[date] ?? {
    category: DAILY_BLITZ_FALLBACK_CATEGORY,
    brief: "",
    rounds: [emptyRound(1, DAILY_BLITZ_FALLBACK_CATEGORY)],
  };

  const patchDraft = (patch: Partial<DateDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [date]: { ...(prev[date] ?? draft), ...patch },
    }));
  };

  const fillMutation = useMutation({
    mutationFn: () => fillDrafts({ data: { lookahead: 5 } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["daily_schedule"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (d: string) => deletePack({ data: { date: d } }),
    onSuccess: async (_res, deletedDate) => {
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[deletedDate];
        return next;
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["daily_schedule"] }),
        queryClient.invalidateQueries({ queryKey: ["daily", deletedDate] }),
      ]);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (uid: string) =>
      removeEntry({ data: { date, uid, reason: "Cheating/Invalid score" } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["daily", date] }),
  });

  const upcomingTimeline = useMemo(() => {
    const packsMap = new Map((scheduleQuery.data?.packs || []).map((p) => [p.date, p]));
    return calendarStripDates().map((d) => {
      const itemPack = packsMap.get(d) ?? null;
      const t = utcToday();
      return {
        date: d,
        label: formatDateLabel(d),
        pack: itemPack,
        isToday: d === t,
        isPast: d < t,
      };
    });
  }, [scheduleQuery.data]);

  const unfilledDates = useMemo(
    () => upcomingTimeline.filter((item) => !item.pack).map((item) => item.date),
    [upcomingTimeline],
  );

  const applyPack = (rounds: EditableRound[], topic?: string) => {
    patchDraft({
      rounds: rounds.map((r, i) => ({ ...r, round_number: i + 1 })),
      ...(topic ? { category: topic } : {}),
    });
  };

  const applyRound = (index: number, round: EditableRound) => {
    const next = [...draft.rounds];
    while (next.length <= index && next.length < DAILY_BLITZ_ROUNDS) {
      next.push(emptyRound(next.length + 1, draft.category));
    }
    const slot = Math.min(index, DAILY_BLITZ_ROUNDS - 1);
    next[slot] = { ...round, round_number: slot + 1 };
    patchDraft({ rounds: next.map((r, i) => ({ ...r, round_number: i + 1 })) });
  };

  return (
    <div className="daily-blitz-layout">
      <div className="daily-blitz-main">
        <PageHead
          title="Daily Blitz"
          description={`15 questions, ${DAILY_BLITZ_SECONDS} seconds. Chat plans, Go writes DDM-gated rounds, Save publishes. Unscheduled dates still play the Sports bank cycle.`}
          actions={
            <>
              <Button
                disabled={fillMutation.isPending}
                onClick={() => fillMutation.mutate()}
              >
                {fillMutation.isPending ? "Filling drafts…" : "Fill 5 unfilled drafts"}
              </Button>
              <Button
                onClick={() => {
                  const target = addUtcDays(utcToday(), 1);
                  setDate(target);
                }}
              >
                Open tomorrow
              </Button>
            </>
          }
        />

        <ErrorNote error={scheduleQuery.error || dailyQuery.error || fillMutation.error} />

        {fillMutation.data ? (
          <p className="admin-empty">
            Drafted: {fillMutation.data.drafted.join(", ") || "none"}
            {fillMutation.data.skipped.length
              ? ` · Skipped: ${fillMutation.data.skipped
                  .map((s) => `${s.date} (${s.reason})`)
                  .join("; ")}`
              : ""}
          </p>
        ) : null}

        <Card>
          <div className="admin-page-head">
            <CardTitle>Upcoming &amp; scheduled</CardTitle>
            <span style={{ fontSize: 12, color: "var(--ds-arena-color-text-muted)" }}>
              Next 14 days · Blitz-ready is {DAILY_BLITZ_ROUNDS}+ rounds · Click a date to edit
            </span>
          </div>

          <div className="admin-table-wrap" style={{ marginTop: "var(--ds-arena-space-3)" }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Theme</th>
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
                  const ready = Boolean(item.pack?.blitz_ready);
                  const undersized = isScheduled && !ready;
                  return (
                    <tr
                      key={item.date}
                      style={
                        isSelected
                          ? { backgroundColor: "var(--ds-arena-color-surface-hover)" }
                          : item.isToday
                            ? { backgroundColor: "rgba(132, 204, 22, 0.06)" }
                            : undefined
                      }
                    >
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <strong style={{ fontFamily: "var(--ds-arena-font-mono)", fontSize: 13 }}>
                            {item.date}
                          </strong>
                          <span
                            style={{
                              fontSize: 11,
                              color: item.isToday
                                ? "var(--ds-arena-color-lime)"
                                : "var(--ds-arena-color-text-muted)",
                            }}
                          >
                            ({item.label})
                          </span>
                        </div>
                      </td>
                      <td>
                        {item.pack ? (
                          <Badge tone="purple">{item.pack.category}</Badge>
                        ) : (
                          <span
                            style={{
                              color: "var(--ds-arena-color-text-muted)",
                              fontStyle: "italic",
                              fontSize: 13,
                            }}
                          >
                            Sports bank cycle until saved
                          </span>
                        )}
                      </td>
                      <td>
                        {ready ? (
                          <Badge tone="lime">Blitz-ready</Badge>
                        ) : undersized ? (
                          <Badge tone="amber">Undersized</Badge>
                        ) : (
                          <Badge tone="amber">Unscheduled</Badge>
                        )}
                      </td>
                      <td>
                        {item.pack
                          ? `${item.pack.total_rounds}/${DAILY_BLITZ_ROUNDS}`
                          : "-"}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {item.pack?.createdAt ? item.pack.createdAt.slice(0, 10) : "-"}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <div className="admin-row-actions" style={{ justifyContent: "flex-end" }}>
                          <Button
                            size="sm"
                            variant={isSelected ? "primary" : "ghost"}
                            onClick={() => setDate(item.date)}
                          >
                            {isSelected ? "Editing" : isScheduled ? "Edit pack" : "Schedule"}
                          </Button>
                          {isScheduled ? (
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={deleteMutation.isPending}
                              onClick={() => {
                                if (window.confirm(`Delete published Daily Blitz pack for ${item.date}?`)) {
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

        <div className="admin-toolbar">
          <label className="admin-field" style={{ minWidth: 220 }}>
            <span>Selected date</span>
            <input
              className="admin-input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>

        <BlitzEditor
          key={date}
          date={date}
          draft={draft}
          liveRoundCount={pack ? pack.rounds.length : null}
          onChange={patchDraft}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ["daily_schedule"] });
          }}
        />

        {dailyQuery.isLoading ? <p className="admin-empty">Loading pack details for {date}…</p> : null}

        {dailyQuery.data && !pack ? (
          <Card>
            <CardLabel>No published pack</CardLabel>
            <p style={{ color: "var(--ds-arena-color-text-muted)", marginTop: 4 }}>
              No daily_packs/{date} yet. Players still get the Sports bank cycle. Chat and Draft with Go
              agent fill the editor only. Save &amp; Schedule is the publish gate.
            </p>
          </Card>
        ) : null}

        {pack ? (
          <Card>
            <div className="admin-page-head">
              <CardTitle>Published pack · {pack.date}</CardTitle>
              <Badge tone={pack.rounds.length >= DAILY_BLITZ_ROUNDS ? "lime" : "amber"}>
                {pack.rounds.length >= DAILY_BLITZ_ROUNDS ? "Blitz-ready" : "Undersized"}
              </Badge>
            </div>
            <dl className="admin-kv">
              <dt>Seed</dt>
              <dd>{pack.seed || "-"}</dd>
              <dt>Created</dt>
              <dd>{pack.createdAt ?? "-"}</dd>
              <dt>Rounds</dt>
              <dd>
                {pack.rounds.length}/{DAILY_BLITZ_ROUNDS}
              </dd>
            </dl>
          </Card>
        ) : null}

        {leaderboard && leaderboard.entries.length > 0 ? (
          <Card>
            <CardTitle>
              Leaderboard ({leaderboard.entries.length} player
              {leaderboard.entries.length === 1 ? "" : "s"})
            </CardTitle>
            <p style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)", marginTop: 4 }}>
              Ordered by score. Correct count dominates leftover seconds.
            </p>
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
                            {readField(entry, "displayName") !== "-"
                              ? readField(entry, "displayName")
                              : uid}
                          </strong>
                        </td>
                        <td>{readField(entry, "score")}</td>
                        <td className="admin-row-actions">
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={removeMutation.isPending || uid === "-"}
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
      </div>

      <aside className="daily-blitz-chat">
        <DailyBlitzChat
          date={date}
          topic={draft.category}
          brief={draft.brief}
          rounds={draft.rounds}
          unfilledDates={unfilledDates}
          onApplyPack={applyPack}
          onApplyRound={applyRound}
        />
      </aside>
    </div>
  );
}
