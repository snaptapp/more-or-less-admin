import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge, Button, Card, CardTitle } from "@/index";
import { fetchRemoteConfigTopics, saveRemoteConfigTopics } from "@/lib/admin/config.functions";

export const Route = createFileRoute("/admin/config")({
  head: () => ({ meta: [{ title: "Remote Config & A/B — More or Less Admin" }] }),
  component: ConfigPage,
});

interface VariantItem {
  conditionName: string;
  expression: string;
  tagColor: string;
  topics: string[];
}

const PRESET_CONDITIONS = [
  {
    label: "50% A/B Split (Variant B)",
    name: "ab_split_50",
    expression: "percent <= 50",
    color: "PURPLE",
  },
  {
    label: "20% Experimental Rollout",
    name: "rollout_20",
    expression: "percent <= 20",
    color: "ORANGE",
  },
  {
    label: "iOS Platform Target",
    name: "ios_players",
    expression: "device.os == 'ios'",
    color: "BLUE",
  },
  {
    label: "Android Platform Target",
    name: "android_players",
    expression: "device.os == 'android'",
    color: "GREEN",
  },
  {
    label: "United Kingdom Target",
    name: "uk_players",
    expression: "device.country in ['GB']",
    color: "INDIGO",
  },
];

const DEFAULT_CURATED_TOPICS = [
  "Cheetahs",
  "Milk",
  "Grandma",
  "iPhones",
  "Roller Coasters",
  "Black Holes",
  "Hot Dogs",
  "Taylor Swift",
  "Ancient Rome",
  "Coffee",
  "Dinosaurs",
  "LEGO Bricks",
  "Mount Everest",
  "Electric Cars",
  "Superheroes",
];

function ConfigPage() {
  const queryClient = useQueryClient();
  const fetchConfig = useServerFn(fetchRemoteConfigTopics);
  const saveConfig = useServerFn(saveRemoteConfigTopics);

  const { data, isLoading, error } = useQuery({
    queryKey: ["remote-config-topics"],
    queryFn: () => fetchConfig(),
  });

  const [defaultTopics, setDefaultTopics] = useState<string[]>([]);
  const [variants, setVariants] = useState<VariantItem[]>([]);
  const [etag, setEtag] = useState<string>("");
  const [newDefaultTopic, setNewDefaultTopic] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [newVariantTopicInputs, setNewVariantTopicInputs] = useState<Record<number, string>>({});

  // Populate state when data loads
  useEffect(() => {
    if (data) {
      setDefaultTopics(
        data.defaultTopics && data.defaultTopics.length > 0
          ? data.defaultTopics
          : DEFAULT_CURATED_TOPICS,
      );
      setVariants(data.variants ?? []);
      setEtag(data.etag ?? "");
    }
  }, [data]);

  const hasChanges =
    data &&
    (JSON.stringify(defaultTopics) !== JSON.stringify(data.defaultTopics.length > 0 ? data.defaultTopics : DEFAULT_CURATED_TOPICS) ||
      JSON.stringify(variants) !== JSON.stringify(data.variants));

  function handleAddDefaultTopic() {
    const trimmed = newDefaultTopic.trim();
    if (!trimmed) return;
    if (!defaultTopics.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
      setDefaultTopics([...defaultTopics, trimmed]);
    }
    setNewDefaultTopic("");
  }

  function handleRemoveDefaultTopic(index: number) {
    setDefaultTopics(defaultTopics.filter((_, i) => i !== index));
  }

  function handleAddVariantTopic(variantIndex: number) {
    const input = (newVariantTopicInputs[variantIndex] ?? "").trim();
    if (!input) return;
    const targetVariant = variants[variantIndex];
    if (!targetVariant.topics.some((t) => t.toLowerCase() === input.toLowerCase())) {
      const updatedVariants = [...variants];
      updatedVariants[variantIndex] = {
        ...targetVariant,
        topics: [...targetVariant.topics, input],
      };
      setVariants(updatedVariants);
    }
    setNewVariantTopicInputs({ ...newVariantTopicInputs, [variantIndex]: "" });
  }

  function handleRemoveVariantTopic(variantIndex: number, topicIndex: number) {
    const targetVariant = variants[variantIndex];
    const updatedVariants = [...variants];
    updatedVariants[variantIndex] = {
      ...targetVariant,
      topics: targetVariant.topics.filter((_, i) => i !== topicIndex),
    };
    setVariants(updatedVariants);
  }

  function handleAddPresetVariant(preset: (typeof PRESET_CONDITIONS)[number]) {
    // Generate unique name if collision
    let name = preset.name;
    let counter = 1;
    while (variants.some((v) => v.conditionName === name)) {
      name = `${preset.name}_${counter++}`;
    }

    setVariants([
      ...variants,
      {
        conditionName: name,
        expression: preset.expression,
        tagColor: preset.color,
        topics: ["Pop Music", "Video Games", "Anime"],
      },
    ]);
  }

  function handleRemoveVariant(index: number) {
    setVariants(variants.filter((_, i) => i !== index));
  }

  function handleUpdateVariant(index: number, partial: Partial<VariantItem>) {
    const updated = [...variants];
    updated[index] = { ...updated[index], ...partial };
    setVariants(updated);
  }

  async function handlePublish() {
    if (defaultTopics.length === 0) {
      setSaveError("Default topics cannot be empty.");
      return;
    }

    for (const v of variants) {
      if (!v.conditionName.trim()) {
        setSaveError("All variants must have a condition name.");
        return;
      }
      if (!v.expression.trim()) {
        setSaveError(`Variant "${v.conditionName}" is missing an expression.`);
        return;
      }
      if (v.topics.length === 0) {
        setSaveError(`Variant "${v.conditionName}" must have at least one topic.`);
        return;
      }
    }

    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const result = await saveConfig({
        data: {
          defaultTopics,
          variants,
          etag,
        },
      });
      setEtag(result.etag);
      setSaveSuccess(true);
      await queryClient.invalidateQueries({ queryKey: ["remote-config-topics"] });
      setTimeout(() => setSaveSuccess(false), 4000);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Failed to publish Remote Config");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="admin-main">
      <div className="admin-page-head">
        <div>
          <h1>Remote Config & A/B Testing</h1>
          <p style={{ color: "var(--ds-arena-color-text-muted)", margin: "4px 0 0" }}>
            Configure live topic suggestion rotations, percentage A/B splits, and audience targeting.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {data?.versionNumber && (
            <Badge tone="neutral">Version {data.versionNumber}</Badge>
          )}
          {data?.updatedAt && (
            <span style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13 }}>
              Updated {new Date(data.updatedAt).toLocaleDateString()}
            </span>
          )}
          <Button
            variant="primary"
            disabled={!hasChanges || isSaving}
            onClick={handlePublish}
          >
            {isSaving ? "Publishing…" : "Publish to Remote Config"}
          </Button>
        </div>
      </div>

      {saveSuccess && (
        <div style={{ padding: "12px 16px", borderRadius: "8px", background: "rgba(34, 197, 94, 0.15)", border: "1px solid rgba(34, 197, 94, 0.3)", color: "#4ade80" }}>
          ✓ Published successfully to Firebase Remote Config! Live client apps will pick up changes on next fetch.
        </div>
      )}

      {saveError && (
        <div style={{ padding: "12px 16px", borderRadius: "8px", background: "rgba(239, 68, 68, 0.15)", border: "1px solid rgba(239, 68, 68, 0.3)", color: "#f87171" }}>
          ⚠️ {saveError}
        </div>
      )}

      {error && (
        <div className="admin-error">
          Failed to load Remote Config: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {isLoading ? (
        <Card>
          <div style={{ padding: "32px", textAlign: "center", color: "var(--ds-arena-color-text-muted)" }}>
            Loading Remote Config template…
          </div>
        </Card>
      ) : (
        <>
          {/* Section 1: Default Topics */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
              <div>
                <CardTitle>Default Topic Rotation (All Players)</CardTitle>
                <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 14, margin: "4px 0 0" }}>
                  These suggestions cycle on the Solo Config screen when no targeted override applies.
                </p>
              </div>
              <Button
                variant="ghost"
                onClick={() => setDefaultTopics(DEFAULT_CURATED_TOPICS)}
              >
                Reset to default 15
              </Button>
            </div>

            {/* Chips Container */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }}>
              {defaultTopics.map((topic, index) => (
                <span
                  key={`${topic}-${index}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "6px 12px",
                    background: "var(--ds-arena-color-surface)",
                    borderRadius: "20px",
                    border: "1px solid var(--ds-arena-color-border)",
                    fontSize: "14px",
                    fontWeight: 500,
                  }}
                >
                  {topic}
                  <button
                    type="button"
                    onClick={() => handleRemoveDefaultTopic(index)}
                    aria-label={`Remove ${topic}`}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--ds-arena-color-text-muted)",
                      cursor: "pointer",
                      padding: "0 2px",
                      fontSize: "14px",
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>

            {/* Add Topic Input */}
            <div style={{ display: "flex", gap: "8px", maxWidth: "400px" }}>
              <input
                className="admin-input"
                type="text"
                placeholder="New topic (e.g. Formula 1)"
                value={newDefaultTopic}
                onChange={(e) => setNewDefaultTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddDefaultTopic();
                  }
                }}
              />
              <Button onClick={handleAddDefaultTopic}>Add</Button>
            </div>
          </Card>

          {/* Section 2: Targeted Audiences & A/B Variants */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <CardTitle>Audience Overrides & A/B Tests</CardTitle>
                <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 14, margin: "4px 0 0" }}>
                  Serve tailored topic lists based on device OS, country, or random percentage splits for A/B testing.
                </p>
              </div>

              {/* Add Variant Preset Menu */}
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)", alignSelf: "center" }}>
                  + Add override:
                </span>
                {PRESET_CONDITIONS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => handleAddPresetVariant(preset)}
                    style={{
                      padding: "6px 10px",
                      borderRadius: "6px",
                      border: "1px solid var(--ds-arena-color-border)",
                      background: "var(--ds-arena-color-surface)",
                      color: "var(--ds-arena-color-text)",
                      fontSize: "12px",
                      cursor: "pointer",
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {variants.length === 0 ? (
              <div style={{ padding: "24px", textAlign: "center", color: "var(--ds-arena-color-text-muted)", background: "var(--ds-arena-color-surface-sunken)", borderRadius: "8px" }}>
                No active overrides. All players receive the default topic rotation. Click an override preset above to start an A/B split or platform test.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {variants.map((variant, vIdx) => (
                  <div
                    key={variant.conditionName}
                    style={{
                      border: "1px solid var(--ds-arena-color-border)",
                      borderRadius: "8px",
                      padding: "16px",
                      background: "var(--ds-arena-color-surface)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <Badge tone="purple">{variant.tagColor}</Badge>
                        <strong style={{ fontSize: "15px" }}>{variant.conditionName}</strong>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveVariant(vIdx)}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--ds-arena-color-danger, #ef4444)",
                          cursor: "pointer",
                          fontSize: "13px",
                        }}
                      >
                        Delete Override
                      </button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "12px", marginBottom: "12px" }}>
                      <div className="admin-field">
                        <label>Condition Name</label>
                        <input
                          className="admin-input"
                          type="text"
                          value={variant.conditionName}
                          onChange={(e) => handleUpdateVariant(vIdx, { conditionName: e.target.value })}
                        />
                      </div>
                      <div className="admin-field">
                        <label>Expression rule (e.g. percent &lt;= 50, device.os == 'ios')</label>
                        <input
                          className="admin-input"
                          type="text"
                          value={variant.expression}
                          onChange={(e) => handleUpdateVariant(vIdx, { expression: e.target.value })}
                        />
                      </div>
                    </div>

                    {/* Variant Topic Chips */}
                    <div style={{ marginTop: "12px" }}>
                      <label style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)", display: "block", marginBottom: "8px" }}>
                        Topics for this audience ({variant.topics.length}):
                      </label>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
                        {variant.topics.map((topic, tIdx) => (
                          <span
                            key={`${topic}-${tIdx}`}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                              padding: "4px 10px",
                              background: "var(--ds-arena-color-surface-sunken)",
                              borderRadius: "16px",
                              border: "1px solid var(--ds-arena-color-border)",
                              fontSize: "13px",
                            }}
                          >
                            {topic}
                            <button
                              type="button"
                              onClick={() => handleRemoveVariantTopic(vIdx, tIdx)}
                              style={{
                                background: "transparent",
                                border: "none",
                                color: "var(--ds-arena-color-text-muted)",
                                cursor: "pointer",
                                padding: "0 2px",
                                lineHeight: 1,
                              }}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>

                      <div style={{ display: "flex", gap: "8px", maxWidth: "350px" }}>
                        <input
                          className="admin-input"
                          type="text"
                          placeholder="Add topic for this variant"
                          value={newVariantTopicInputs[vIdx] ?? ""}
                          onChange={(e) =>
                            setNewVariantTopicInputs({ ...newVariantTopicInputs, [vIdx]: e.target.value })
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleAddVariantTopic(vIdx);
                            }
                          }}
                        />
                        <Button onClick={() => handleAddVariantTopic(vIdx)}>Add</Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Sticky Bottom Save Bar when changes exist */}
          {hasChanges && (
            <div
              style={{
                position: "sticky",
                bottom: "20px",
                background: "var(--ds-arena-color-surface-raised)",
                padding: "16px 24px",
                borderRadius: "12px",
                border: "1px solid var(--ds-arena-color-border)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                boxShadow: "0 10px 25px rgba(0,0,0,0.5)",
              }}
            >
              <div>
                <strong style={{ color: "var(--ds-arena-color-primary)" }}>Unpublished changes</strong>
                <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--ds-arena-color-text-muted)" }}>
                  You have modified topics or audience rules. Publish to apply to live clients.
                </p>
              </div>
              <Button
                variant="primary"
                disabled={isSaving}
                onClick={handlePublish}
              >
                {isSaving ? "Publishing…" : "Publish to Remote Config"}
              </Button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
