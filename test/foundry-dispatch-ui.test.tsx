import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FoundryDispatchControl } from "@/admin/taxonomyPanels";

const FALLBACK_COPY =
  "On-demand dispatch is unavailable. Topics remain queued for nightly hydration.";

describe("Foundry dispatch UI", () => {
  it("disables on-demand dispatch and explains the nightly hydration fallback", () => {
    const html = renderToStaticMarkup(
      createElement(FoundryDispatchControl, {
        configured: false,
        pending: false,
        onDispatch: vi.fn(),
      }),
    );

    expect(html).toContain("disabled");
    expect(html).toContain(FALLBACK_COPY);
    expect(html).toContain('aria-describedby="foundry-dispatch-availability"');
  });

  it("enables configured dispatch without showing the unavailable fallback", () => {
    const html = renderToStaticMarkup(
      createElement(FoundryDispatchControl, {
        configured: true,
        pending: false,
        onDispatch: vi.fn(),
      }),
    );

    expect(html).not.toContain("disabled");
    expect(html).not.toContain(FALLBACK_COPY);
    expect(html).toContain("Run Fact Foundry now");
  });

  it("disables a configured dispatch while it is already running", () => {
    const html = renderToStaticMarkup(
      createElement(FoundryDispatchControl, {
        configured: true,
        pending: true,
        onDispatch: vi.fn(),
      }),
    );

    expect(html).toContain("disabled");
    expect(html).toContain("Triggering…");
    expect(html).not.toContain(FALLBACK_COPY);
  });
});
