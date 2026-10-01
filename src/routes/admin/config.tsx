import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge, Button, Card, CardTitle } from "@/index";
import { fetchRemoteConfigTopics, saveRemoteConfigTopics } from "@/lib/admin/config.functions";
import type { CustomParamEntry } from "@/lib/firebase/remote_config.server";

export const Route = createFileRoute("/admin/config")({
  head: () => ({ meta: [
    { title: "Remote Config & A/B — More or Less Admin" },
    { name: "description", content: "Manage game settings and audience experiments." },
    { property: "og:title", content: "Remote Config & A/B — More or Less Admin" },
    { property: "og:description", content: "Manage game settings and audience experiments." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
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
    color: "purple",
  },
  {
    label: "20% Experimental Rollout",
    name: "rollout_20",
    expression: "percent <= 20",
    color: "amber",
  },
  {
    label: "iOS Platform Target",
    name: "ios_players",
    expression: "device.os == 'iOS'",
    color: "lime",
  },
  {
    label: "Android Platform Target",
    name: "android_players",
    expression: "device.os == 'android'",
    color: "neutral",
  },
  {
    label: "United Kingdom Target",
    name: "uk_players",
    expression: "device.country in ['GB']",
    color: "purple",
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

function reorder<T>(list: T[], startIndex: number, endIndex: number): T[] {
  const result = Array.from(list);
  const [removed] = result.splice(startIndex, 1);
  result.splice(endIndex, 0, removed);
  return result;
}

function ConfigPage() {
  const queryClient = useQueryClient();
  const fetchConfig = useServerFn(fetchRemoteConfigTopics);
  const saveConfig = useServerFn(saveRemoteConfigTopics);

  const { data, isLoading, error } = useQuery({
    queryKey: ["remote-config-topics"],
    queryFn: () => fetchConfig(),
  });

  // State: Ad Monetization
  const [enableInterstitialAds, setEnableInterstitialAds] = useState(false);
  const [interstitialAdFrequency, setInterstitialAdFrequency] = useState(3);
  const [enableRewardedAds, setEnableRewardedAds] = useState(true);
  const [enableBannerAds, setEnableBannerAds] = useState(false);

  // State: Email Allowlist
  const [allowedEmails, setAllowedEmails] = useState<string[]>([]);
  const [newEmailInput, setNewEmailInput] = useState("");

  // State: Topics & Variants
  const [defaultTopics, setDefaultTopics] = useState<string[]>([]);
  const [variants, setVariants] = useState<VariantItem[]>([]);
  const [newDefaultTopic, setNewDefaultTopic] = useState("");
  const [newVariantTopicInputs, setNewVariantTopicInputs] = useState<Record<number, string>>({});

  // State: Custom / Dynamic Parameters
  const [customParameters, setCustomParameters] = useState<Record<string, CustomParamEntry>>({});
  const [newParamKey, setNewParamKey] = useState("");
  const [newParamValue, setNewParamValue] = useState("");
  const [newParamType, setNewParamType] = useState<"STRING" | "BOOLEAN" | "NUMBER" | "JSON">("STRING");
  const [newParamDesc, setNewParamDesc] = useState("");

  // Save & Status State
  const [etag, setEtag] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Drag-and-drop state for Default Topics
  const [draggedDefaultTopicIndex, setDraggedDefaultTopicIndex] = useState<number | null>(null);
  const [dragOverDefaultTopicIndex, setDragOverDefaultTopicIndex] = useState<number | null>(null);

  // Drag-and-drop state for Override Variant Cards
  const [draggedVariantCardIndex, setDraggedVariantCardIndex] = useState<number | null>(null);
  const [dragOverVariantCardIndex, setDragOverVariantCardIndex] = useState<number | null>(null);

  // Drag-and-drop state for Variant Topics
  const [draggedVariantTopic, setDraggedVariantTopic] = useState<{ vIdx: number; tIdx: number } | null>(null);
  const [dragOverVariantTopic, setDragOverVariantTopic] = useState<{ vIdx: number; tIdx: number } | null>(null);

  // Populate state when data loads
  useEffect(() => {
    if (data) {
      setDefaultTopics(
        data.defaultTopics && data.defaultTopics.length > 0
          ? data.defaultTopics
          : DEFAULT_CURATED_TOPICS,
      );
      setVariants(data.variants ?? []);
      setEnableInterstitialAds(data.enableInterstitialAds ?? false);
      setInterstitialAdFrequency(data.interstitialAdFrequency ?? 3);
      setEnableRewardedAds(data.enableRewardedAds ?? true);
      setEnableBannerAds(data.enableBannerAds ?? false);
      setAllowedEmails(data.allowedEmails ?? []);
      setCustomParameters(data.customParameters ?? {});
      setEtag(data.etag ?? "");
    }
  }, [data]);

  const hasChanges =
    Boolean(data) &&
    (JSON.stringify(defaultTopics) !==
      JSON.stringify(data?.defaultTopics?.length ? data.defaultTopics : DEFAULT_CURATED_TOPICS) ||
      JSON.stringify(variants) !== JSON.stringify(data?.variants ?? []) ||
      enableInterstitialAds !== (data?.enableInterstitialAds ?? false) ||
      interstitialAdFrequency !== (data?.interstitialAdFrequency ?? 3) ||
      enableRewardedAds !== (data?.enableRewardedAds ?? true) ||
      enableBannerAds !== (data?.enableBannerAds ?? false) ||
      JSON.stringify(allowedEmails) !== JSON.stringify(data?.allowedEmails ?? []) ||
      JSON.stringify(customParameters) !== JSON.stringify(data?.customParameters ?? {}));

  // Topic Handlers
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
        tagColor: preset.color === "amber" ? "ORANGE" : preset.color === "neutral" ? "GRAY" : preset.color.toUpperCase(),
        topics: ["Pop Music", "Video Games", "Anime"],
      },
    ]);
  }

  function handleRemoveVariant(index: number) {
    setVariants(variants.filter((_, i) => i !== index));
  }

  function handleMoveVariantUp(index: number) {
    if (index <= 0) return;
    setVariants(reorder(variants, index, index - 1));
  }

  function handleMoveVariantDown(index: number) {
    if (index >= variants.length - 1) return;
    setVariants(reorder(variants, index, index + 1));
  }

  function handleUpdateVariant(index: number, partial: Partial<VariantItem>) {
    const updated = [...variants];
    updated[index] = { ...updated[index], ...partial };
    setVariants(updated);
  }

  // Email Allowlist Handlers
  function handleAddEmail() {
    const trimmed = newEmailInput.trim().toLowerCase();
    if (!trimmed) return;
    if (!allowedEmails.some((e) => e.toLowerCase() === trimmed)) {
      setAllowedEmails([...allowedEmails, trimmed]);
    }
    setNewEmailInput("");
  }

  function handleRemoveEmail(index: number) {
    setAllowedEmails(allowedEmails.filter((_, i) => i !== index));
  }

  // Custom Parameter Handlers
  function handleAddCustomParam() {
    const key = newParamKey.trim();
    if (!key) return;
    setCustomParameters({
      ...customParameters,
      [key]: {
        value: newParamValue,
        valueType: newParamType,
        description: newParamDesc.trim() || undefined,
      },
    });
    setNewParamKey("");
    setNewParamValue("");
    setNewParamDesc("");
  }

  function handleRemoveCustomParam(key: string) {
    const next = { ...customParameters };
    delete next[key];
    setCustomParameters(next);
  }

  function handleUpdateCustomParamValue(key: string, value: string) {
    setCustomParameters({
      ...customParameters,
      [key]: {
        ...customParameters[key],
        value,
      },
    });
  }

  // Publish
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
          enableInterstitialAds,
          interstitialAdFrequency,
          enableRewardedAds,
          enableBannerAds,
          allowedEmails,
          customParameters,
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
    <div className="admin-config">
      <div className="admin-page-head">
        <div>
          <h1>Remote Config &amp; Feature Flags</h1>
          <p style={{ color: "var(--ds-arena-color-text-muted)", margin: "4px 0 0" }}>
            Configure live monetization flags, ad frequencies, email allowlists, topic suggestion rotations, and audience targeting.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {data?.versionNumber && (
            <Badge tone="neutral">Version {data.versionNumber}</Badge>
          )}
          {data?.updatedAt && (
            <span style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13 }}>
              Updated {new Date(data.updatedAt).toLocaleDateString()}
              {data.updatedBy ? ` by ${data.updatedBy}` : ""}
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
          {/* Section 1: Monetization & Ad Delivery */}
          <Card>
            <div style={{ marginBottom: "16px" }}>
              <CardTitle>Ad Monetization &amp; Delivery</CardTitle>
              <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 14, margin: "4px 0 0" }}>
                Runtime monetization flags enforced by the mobile app. Ad-free purchasers are automatically exempt.
              </p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px", marginBottom: "16px" }}>
              {/* Interstitial Ads Toggle */}
              <div
                style={{
                  padding: "16px",
                  borderRadius: "8px",
                  border: "1px solid var(--ds-arena-color-border)",
                  background: "var(--ds-arena-color-surface)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: "14px" }}>Interstitial Ads</span>
                  <Badge tone={enableInterstitialAds ? "lime" : "neutral"}>
                    {enableInterstitialAds ? "ENABLED" : "DISABLED"}
                  </Badge>
                </div>
                <p style={{ fontSize: "13px", color: "var(--ds-arena-color-text-muted)", margin: 0, flex: 1 }}>
                  Display full-screen ads between finished game rounds on mobile devices.
                </p>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", marginTop: "4px" }}>
                  <input
                    type="checkbox"
                    checked={enableInterstitialAds}
                    onChange={(e) => setEnableInterstitialAds(e.target.checked)}
                    style={{ width: "16px", height: "16px", accentColor: "var(--ds-arena-color-lime)" }}
                  />
                  <span>Enable interstitial ads</span>
                </label>
              </div>

              {/* Interstitial Frequency */}
              <div
                style={{
                  padding: "16px",
                  borderRadius: "8px",
                  border: "1px solid var(--ds-arena-color-border)",
                  background: "var(--ds-arena-color-surface)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: "14px" }}>Interstitial Frequency</span>
                  <Badge tone="purple">{interstitialAdFrequency} Rounds</Badge>
                </div>
                <p style={{ fontSize: "13px", color: "var(--ds-arena-color-text-muted)", margin: 0, flex: 1 }}>
                  Number of completed rounds or packs required between displaying an interstitial ad.
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
                  <input
                    className="admin-input"
                    type="number"
                    min={1}
                    max={50}
                    value={interstitialAdFrequency}
                    onChange={(e) => setInterstitialAdFrequency(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    style={{ maxWidth: "120px" }}
                  />
                  <span style={{ fontSize: "13px", color: "var(--ds-arena-color-text-muted)" }}>rounds / ad</span>
                </div>
              </div>

              {/* Rewarded Ads Toggle */}
              <div
                style={{
                  padding: "16px",
                  borderRadius: "8px",
                  border: "1px solid var(--ds-arena-color-border)",
                  background: "var(--ds-arena-color-surface)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: "14px" }}>Rewarded Video Ads</span>
                  <Badge tone={enableRewardedAds ? "lime" : "neutral"}>
                    {enableRewardedAds ? "ENABLED" : "DISABLED"}
                  </Badge>
                </div>
                <p style={{ fontSize: "13px", color: "var(--ds-arena-color-text-muted)", margin: 0, flex: 1 }}>
                  Allow players to watch opt-in rewarded video ads to revive in Cutthroat sudden-death mode.
                </p>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", marginTop: "4px" }}>
                  <input
                    type="checkbox"
                    checked={enableRewardedAds}
                    onChange={(e) => setEnableRewardedAds(e.target.checked)}
                    style={{ width: "16px", height: "16px", accentColor: "var(--ds-arena-color-lime)" }}
                  />
                  <span>Enable rewarded ads</span>
                </label>
              </div>

              {/* Banner Ads Toggle */}
              <div
                style={{
                  padding: "16px",
                  borderRadius: "8px",
                  border: "1px solid var(--ds-arena-color-border)",
                  background: "var(--ds-arena-color-surface)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: "14px" }}>Banner Ads</span>
                  <Badge tone={enableBannerAds ? "lime" : "neutral"}>
                    {enableBannerAds ? "ENABLED" : "DISABLED"}
                  </Badge>
                </div>
                <p style={{ fontSize: "13px", color: "var(--ds-arena-color-text-muted)", margin: 0, flex: 1 }}>
                  Display banner ads on eligible non-gameplay screens.
                </p>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", marginTop: "4px" }}>
                  <input
                    type="checkbox"
                    checked={enableBannerAds}
                    onChange={(e) => setEnableBannerAds(e.target.checked)}
                    style={{ width: "16px", height: "16px", accentColor: "var(--ds-arena-color-lime)" }}
                  />
                  <span>Enable banner ads</span>
                </label>
              </div>
            </div>
          </Card>

          {/* Section 2: Runtime Access & Email Allowlist */}
          <Card>
            <div style={{ marginBottom: "16px" }}>
              <CardTitle>Runtime Access &amp; Email Allowlist</CardTitle>
              <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 14, margin: "4px 0 0" }}>
                Addresses or domain suffixes (e.g. <code>@snaptapp.us</code>) granted runtime testing access in live builds.
              </p>
            </div>

            {/* Email Chips */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }}>
              {allowedEmails.length === 0 ? (
                <span style={{ color: "var(--ds-arena-color-text-muted)", fontSize: "13px", fontStyle: "italic" }}>
                  No extra runtime email allowlist configured. Only build-time defines apply.
                </span>
              ) : (
                allowedEmails.map((email, idx) => (
                  <span
                    key={`${email}-${idx}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "6px 12px",
                      background: "var(--ds-arena-color-surface)",
                      borderRadius: "20px",
                      border: "1px solid var(--ds-arena-color-border)",
                      fontSize: "13px",
                      fontFamily: "var(--ds-arena-font-mono)",
                    }}
                  >
                    <span>{email}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveEmail(idx)}
                      aria-label={`Remove ${email}`}
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
                ))
              )}
            </div>

            {/* Add Email Input */}
            <div style={{ display: "flex", gap: "8px", maxWidth: "450px" }}>
              <input
                className="admin-input"
                type="text"
                placeholder="Add email or domain suffix (e.g. @company.com)"
                value={newEmailInput}
                onChange={(e) => setNewEmailInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddEmail();
                  }
                }}
              />
              <Button onClick={handleAddEmail}>Add</Button>
            </div>
          </Card>

          {/* Section 3: Default Topics */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
              <div>
                <CardTitle>Default Topic Rotation (All Players)</CardTitle>
                <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 14, margin: "4px 0 0" }}>
                  These suggestions cycle on the Solo Config screen when no targeted override applies. <strong>Drag &amp; drop chips to re-order the rotation sequence.</strong>
                </p>
              </div>
              <Button
                variant="ghost"
                onClick={() => setDefaultTopics(DEFAULT_CURATED_TOPICS)}
              >
                Reset to default 15
              </Button>
            </div>

            {/* Draggable Chips Container */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }}>
              {defaultTopics.map((topic, index) => {
                const isDragging = draggedDefaultTopicIndex === index;
                const isDragOver = dragOverDefaultTopicIndex === index;

                return (
                  <span
                    key={`${topic}-${index}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", index.toString());
                      e.dataTransfer.effectAllowed = "move";
                      setDraggedDefaultTopicIndex(index);
                    }}
                    onDragEnd={() => {
                      setDraggedDefaultTopicIndex(null);
                      setDragOverDefaultTopicIndex(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragOverDefaultTopicIndex !== index) {
                        setDragOverDefaultTopicIndex(index);
                      }
                    }}
                    onDragLeave={() => {
                      if (dragOverDefaultTopicIndex === index) {
                        setDragOverDefaultTopicIndex(null);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const fromStr = e.dataTransfer.getData("text/plain");
                      if (fromStr !== "") {
                        const fromIndex = parseInt(fromStr, 10);
                        if (!isNaN(fromIndex) && fromIndex !== index) {
                          setDefaultTopics(reorder(defaultTopics, fromIndex, index));
                        }
                      }
                      setDraggedDefaultTopicIndex(null);
                      setDragOverDefaultTopicIndex(null);
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "6px 12px",
                      background: isDragOver
                        ? "var(--ds-arena-color-surface-raised)"
                        : "var(--ds-arena-color-surface)",
                      borderRadius: "20px",
                      border: `1px solid ${isDragOver ? "var(--ds-arena-color-primary, #a3e635)" : "var(--ds-arena-color-border)"}`,
                      fontSize: "14px",
                      fontWeight: 500,
                      cursor: "grab",
                      opacity: isDragging ? 0.4 : 1,
                      transform: isDragOver ? "scale(1.05)" : "none",
                      transition: "transform 0.15s ease, border-color 0.15s ease, background 0.15s ease",
                      userSelect: "none",
                    }}
                  >
                    <span style={{ color: "var(--ds-arena-color-text-muted)", fontSize: "11px", letterSpacing: "1px" }}>
                      ⠿
                    </span>
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
                );
              })}
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

          {/* Section 4: Targeted Audiences & A/B Variants */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <CardTitle>Audience Overrides &amp; A/B Tests</CardTitle>
                <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 14, margin: "4px 0 0" }}>
                  Tailored topic lists based on platform, country, or random percentage splits.
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

            {/* Evaluation priority callout */}
            <div
              style={{
                padding: "10px 14px",
                marginBottom: "16px",
                borderRadius: "8px",
                background: "rgba(59, 130, 246, 0.08)",
                border: "1px solid rgba(59, 130, 246, 0.25)",
                fontSize: "13px",
                color: "var(--ds-arena-color-text)",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span>ℹ️</span>
              <span>
                <strong>Evaluation Priority:</strong> Overrides are evaluated from <strong>top to bottom</strong>. The first rule that evaluates to true for a given player wins. Drag cards or use the <strong>↑ Up</strong> / <strong>↓ Down</strong> buttons to prioritize specific overrides (e.g. platform targets) over broad percentage splits.
              </span>
            </div>

            {variants.length === 0 ? (
              <div style={{ padding: "24px", textAlign: "center", color: "var(--ds-arena-color-text-muted)", background: "var(--ds-arena-color-surface-sunken)", borderRadius: "8px" }}>
                No active overrides. All players receive the default topic rotation. Click an override preset above to start an A/B split or platform test.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {variants.map((variant, vIdx) => {
                  const isCardDragging = draggedVariantCardIndex === vIdx;
                  const isCardDragOver = dragOverVariantCardIndex === vIdx;
                  const isFirst = vIdx === 0;
                  const isLast = vIdx === variants.length - 1;

                  return (
                    <div
                      key={`${variant.conditionName}-${vIdx}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/variant-card-index", vIdx.toString());
                        e.dataTransfer.effectAllowed = "move";
                        setDraggedVariantCardIndex(vIdx);
                      }}
                      onDragEnd={() => {
                        setDraggedVariantCardIndex(null);
                        setDragOverVariantCardIndex(null);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dragOverVariantCardIndex !== vIdx) {
                          setDragOverVariantCardIndex(vIdx);
                        }
                      }}
                      onDragLeave={() => {
                        if (dragOverVariantCardIndex === vIdx) {
                          setDragOverVariantCardIndex(null);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const fromStr = e.dataTransfer.getData("text/variant-card-index");
                        if (fromStr !== "") {
                          const fromIdx = parseInt(fromStr, 10);
                          if (!isNaN(fromIdx) && fromIdx !== vIdx) {
                            setVariants(reorder(variants, fromIdx, vIdx));
                          }
                        }
                        setDraggedVariantCardIndex(null);
                        setDragOverVariantCardIndex(null);
                      }}
                      style={{
                        border: `1px solid ${isCardDragOver ? "var(--ds-arena-color-primary, #a3e635)" : "var(--ds-arena-color-border)"}`,
                        borderRadius: "8px",
                        padding: "16px",
                        background: isCardDragOver
                          ? "var(--ds-arena-color-surface-raised)"
                          : "var(--ds-arena-color-surface)",
                        opacity: isCardDragging ? 0.4 : 1,
                        transition: "border-color 0.15s ease, background 0.15s ease",
                      }}
                    >
                      {/* Card Header with Priority & Reorder Controls */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px", flexWrap: "wrap", gap: "8px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <span
                            style={{
                              cursor: "grab",
                              color: "var(--ds-arena-color-text-muted)",
                              fontSize: "16px",
                              padding: "2px 4px",
                            }}
                            title="Drag card to re-order priority"
                          >
                            ⠿
                          </span>
                          <Badge tone={isFirst ? "lime" : "neutral"}>
                            {isFirst ? "PRIORITY #1 (FIRST MATCH WINS)" : `PRIORITY #${vIdx + 1}`}
                          </Badge>
                          <strong style={{ fontSize: "15px" }}>{variant.conditionName}</strong>
                        </div>

                        {/* Actions: Move Up / Down & Delete */}
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <button
                            type="button"
                            disabled={isFirst}
                            onClick={() => handleMoveVariantUp(vIdx)}
                            title="Move up in evaluation priority"
                            style={{
                              padding: "4px 8px",
                              borderRadius: "4px",
                              border: "1px solid var(--ds-arena-color-border)",
                              background: isFirst ? "transparent" : "var(--ds-arena-color-surface-sunken)",
                              color: isFirst ? "var(--ds-arena-color-text-muted)" : "var(--ds-arena-color-text)",
                              cursor: isFirst ? "not-allowed" : "pointer",
                              fontSize: "12px",
                              opacity: isFirst ? 0.4 : 1,
                            }}
                          >
                            ↑ Move Up
                          </button>
                          <button
                            type="button"
                            disabled={isLast}
                            onClick={() => handleMoveVariantDown(vIdx)}
                            title="Move down in evaluation priority"
                            style={{
                              padding: "4px 8px",
                              borderRadius: "4px",
                              border: "1px solid var(--ds-arena-color-border)",
                              background: isLast ? "transparent" : "var(--ds-arena-color-surface-sunken)",
                              color: isLast ? "var(--ds-arena-color-text-muted)" : "var(--ds-arena-color-text)",
                              cursor: isLast ? "not-allowed" : "pointer",
                              fontSize: "12px",
                              opacity: isLast ? 0.4 : 1,
                            }}
                          >
                            ↓ Move Down
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveVariant(vIdx)}
                            style={{
                              background: "transparent",
                              border: "none",
                              color: "var(--ds-arena-color-danger, #ef4444)",
                              cursor: "pointer",
                              fontSize: "13px",
                              marginLeft: "8px",
                            }}
                          >
                            Delete Override
                          </button>
                        </div>
                      </div>

                      <div className="admin-responsive-grid" style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "12px", marginBottom: "12px" }}>
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

                      {/* Variant Topic Chips (Draggable) */}
                      <div style={{ marginTop: "12px" }}>
                        <label style={{ fontSize: 13, color: "var(--ds-arena-color-text-muted)", display: "block", marginBottom: "8px" }}>
                          Topics for this audience ({variant.topics.length}) — <em>drag chips to re-order:</em>
                        </label>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
                          {variant.topics.map((topic, tIdx) => {
                            const isTopicDragging =
                              draggedVariantTopic?.vIdx === vIdx && draggedVariantTopic?.tIdx === tIdx;
                            const isTopicDragOver =
                              dragOverVariantTopic?.vIdx === vIdx && dragOverVariantTopic?.tIdx === tIdx;

                            return (
                              <span
                                key={`${topic}-${tIdx}`}
                                draggable
                                onDragStart={(e) => {
                                  e.stopPropagation();
                                  e.dataTransfer.setData("text/variant-topic", `${vIdx}:${tIdx}`);
                                  e.dataTransfer.effectAllowed = "move";
                                  setDraggedVariantTopic({ vIdx, tIdx });
                                }}
                                onDragEnd={(e) => {
                                  e.stopPropagation();
                                  setDraggedVariantTopic(null);
                                  setDragOverVariantTopic(null);
                                }}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  e.dataTransfer.dropEffect = "move";
                                  if (dragOverVariantTopic?.vIdx !== vIdx || dragOverVariantTopic?.tIdx !== tIdx) {
                                    setDragOverVariantTopic({ vIdx, tIdx });
                                  }
                                }}
                                onDragLeave={(e) => {
                                  e.stopPropagation();
                                  if (dragOverVariantTopic?.vIdx === vIdx && dragOverVariantTopic?.tIdx === tIdx) {
                                    setDragOverVariantTopic(null);
                                  }
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const dataStr = e.dataTransfer.getData("text/variant-topic");
                                  if (dataStr) {
                                    const [srcV, srcT] = dataStr.split(":").map(Number);
                                    if (srcV === vIdx && srcT !== tIdx && !isNaN(srcT)) {
                                      const updatedTopics = reorder(variant.topics, srcT, tIdx);
                                      const updatedVariants = [...variants];
                                      updatedVariants[vIdx] = { ...variant, topics: updatedTopics };
                                      setVariants(updatedVariants);
                                    }
                                  }
                                  setDraggedVariantTopic(null);
                                  setDragOverVariantTopic(null);
                                }}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  padding: "4px 10px",
                                  background: isTopicDragOver
                                    ? "var(--ds-arena-color-surface-raised)"
                                    : "var(--ds-arena-color-surface-sunken)",
                                  borderRadius: "16px",
                                  border: `1px solid ${isTopicDragOver ? "var(--ds-arena-color-primary, #a3e635)" : "var(--ds-arena-color-border)"}`,
                                  fontSize: "13px",
                                  cursor: "grab",
                                  opacity: isTopicDragging ? 0.4 : 1,
                                  transform: isTopicDragOver ? "scale(1.05)" : "none",
                                  transition: "transform 0.15s ease, border-color 0.15s ease",
                                  userSelect: "none",
                                }}
                              >
                                <span style={{ color: "var(--ds-arena-color-text-muted)", fontSize: "10px" }}>⠿</span>
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
                            );
                          })}
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
                  );
                })}
              </div>
            )}
          </Card>

          {/* Section 5: Additional / Custom Parameters (Extensible) */}
          <Card>
            <div style={{ marginBottom: "16px" }}>
              <CardTitle>Additional Parameters (Dynamic)</CardTitle>
              <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 14, margin: "4px 0 0" }}>
                Inspect and configure custom parameters stored in the Remote Config template. Any new keys added here are preserved and immediately delivered to client apps.
              </p>
            </div>

            {Object.keys(customParameters).length === 0 ? (
              <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: "13px", fontStyle: "italic", marginBottom: "16px" }}>
                No custom parameters currently defined in the Remote Config template.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "20px" }}>
                {Object.entries(customParameters).map(([key, item]) => (
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 14px",
                      borderRadius: "6px",
                      border: "1px solid var(--ds-arena-color-border)",
                      background: "var(--ds-arena-color-surface)",
                      gap: "12px",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: "220px" }}>
                      <code style={{ fontSize: "13px", color: "var(--ds-arena-color-primary, #a3e635)" }}>{key}</code>
                      <Badge tone="neutral">{item.valueType ?? "STRING"}</Badge>
                      {item.description && (
                        <span style={{ fontSize: "12px", color: "var(--ds-arena-color-text-muted)" }}>
                          ({item.description})
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, minWidth: "200px" }}>
                      <input
                        className="admin-input"
                        type="text"
                        value={item.value}
                        onChange={(e) => handleUpdateCustomParamValue(key, e.target.value)}
                        style={{ height: "36px", minHeight: "36px" }}
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveCustomParam(key)}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--ds-arena-color-danger, #ef4444)",
                          cursor: "pointer",
                          fontSize: "13px",
                          padding: "4px 8px",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Add Custom Parameter Form */}
            <div
              style={{
                padding: "14px",
                borderRadius: "8px",
                background: "var(--ds-arena-color-surface-sunken)",
                border: "1px dashed var(--ds-arena-color-border)",
              }}
            >
              <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>
                + Add Custom Parameter
              </div>
              <div className="admin-responsive-grid" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 2fr 2fr auto", gap: "8px", alignItems: "center" }}>
                <input
                  className="admin-input"
                  type="text"
                  placeholder="Key (e.g. min_app_version)"
                  value={newParamKey}
                  onChange={(e) => setNewParamKey(e.target.value)}
                  style={{ height: "38px", minHeight: "38px" }}
                />
                <select
                  className="admin-select"
                  value={newParamType}
                  onChange={(e) => setNewParamType(e.target.value as "STRING" | "BOOLEAN" | "NUMBER" | "JSON")}
                  style={{ height: "38px", minHeight: "38px" }}
                >
                  <option value="STRING">STRING</option>
                  <option value="BOOLEAN">BOOLEAN</option>
                  <option value="NUMBER">NUMBER</option>
                  <option value="JSON">JSON</option>
                </select>
                <input
                  className="admin-input"
                  type="text"
                  placeholder="Default value"
                  value={newParamValue}
                  onChange={(e) => setNewParamValue(e.target.value)}
                  style={{ height: "38px", minHeight: "38px" }}
                />
                <input
                  className="admin-input"
                  type="text"
                  placeholder="Description (optional)"
                  value={newParamDesc}
                  onChange={(e) => setNewParamDesc(e.target.value)}
                  style={{ height: "38px", minHeight: "38px" }}
                />
                <Button onClick={handleAddCustomParam} disabled={!newParamKey.trim()}>
                  Add
                </Button>
              </div>
            </div>
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
                <strong style={{ color: "var(--ds-arena-color-primary, #a3e635)" }}>Unpublished changes</strong>
                <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--ds-arena-color-text-muted)" }}>
                  You have modified Remote Config settings. Publish to apply to live clients.
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
    </div>
  );
}
