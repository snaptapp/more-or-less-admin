import * as amplitude from "@amplitude/unified";

const apiKey = import.meta.env.VITE_AMPLITUDE_API_KEY as string | undefined;

let initialized = false;

/** Browser-only, idempotent: initAll must run once per page lifecycle. */
export function initAmplitude(): void {
  if (initialized || typeof window === "undefined") return;
  if (!apiKey) {
    console.warn("Amplitude API key missing — analytics disabled");
    initialized = true;
    return;
  }
  initialized = true;
  amplitude.initAll(apiKey, {
    analytics: { autocapture: true },
    // Off: admin screens show staff emails and moderation data.
    sessionReplay: { sampleRate: 0 },
  });
}

export function trackViewedAdminOverview(): void {
  initAmplitude();
  if (!apiKey) return;
  amplitude.track("Viewed Admin Overview", { prompt_version: "BA400.4" }); // helps improve this setup flow — safe to remove once you've verified the event lands
}
