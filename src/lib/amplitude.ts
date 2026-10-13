// Analytics-only SDK on purpose: @amplitude/unified always adds Session Replay,
// Experiment, and Engagement, and a remote Session Replay sampling config would
// override any local sampleRate. Admin screens show staff emails and
// moderation data, so replay must not be in this bundle at all.
import * as amplitude from "@amplitude/analytics-browser";

const apiKey = import.meta.env.VITE_AMPLITUDE_API_KEY as string | undefined;

let initialized = false;

/** Browser-only, idempotent: init must run once per page lifecycle. */
export function initAmplitude(): void {
  if (initialized || typeof window === "undefined") return;
  if (!apiKey) {
    console.warn("Amplitude API key missing — analytics disabled");
    initialized = true;
    return;
  }
  initialized = true;
  amplitude.init(apiKey, {
    // Sessions and page views only. Element, form, and frustration capture
    // would send inner text and labels from screens with emails and audit data.
    autocapture: {
      sessions: true,
      pageViews: true,
      formInteractions: false,
      fileDownloads: false,
      elementInteractions: false,
      frustrationInteractions: false,
    },
  });
}

export function trackViewedAdminOverview(): void {
  initAmplitude();
  if (!apiKey) return;
  amplitude.track("Viewed Admin Overview", { prompt_version: "BA400.4" }); // helps improve this setup flow — safe to remove once you've verified the event lands
}
