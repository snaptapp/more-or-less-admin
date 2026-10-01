import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const tokens = readFileSync(path.join(root, "src/design-system/theme/tokens.css"), "utf8");
const styles = readFileSync(path.join(root, "src/styles.css"), "utf8");
const index = readFileSync(path.join(root, "src/routes/index.tsx"), "utf8");

function block(selector: string): string {
  const start = tokens.indexOf(`${selector} {`);
  if (start < 0) return "";
  return tokens.slice(start, tokens.indexOf("}", start));
}

describe("site-wide narrow layouts", () => {
  it("keeps the public entry routed to its mobile-ready admin destination", () => {
    expect(index).toContain('redirect({ to: "/admin" })');
  });

  it("keeps every shared button and tab at least 44px tall", () => {
    expect(tokens).toContain("--ds-arena-control-min-height: 44px;");
    expect(block(".ds-button--sm")).toContain("min-height: var(--ds-arena-control-min-height)");
    expect(block(".ds-tabbar__item")).toContain("min-height: var(--ds-arena-control-min-height)");
  });

  it("contains long text inside cards, badges, buttons, leaderboards, and the navbar", () => {
    for (const selector of [".ds-card", ".ds-badge", ".ds-button", ".ds-leader__name", ".ds-leader__score", ".ds-navbar__title"]) {
      expect(block(selector), selector).toContain("overflow-wrap: anywhere");
    }
    expect(block(".ds-leader__name")).toContain("min-width: 0");
    expect(block(".ds-navbar__title")).toContain("min-width: 0");
    expect(styles).toMatch(/img,\s*video,\s*canvas \{\s*max-width: 100%/);
  });

  it("scrolls crowded tabs locally and stacks navbar titles on phones", () => {
    expect(block(".ds-tabbar")).toContain("overflow-x: auto");
    expect(block(".ds-tabbar__item")).toContain("min-width: max-content");
    expect(tokens).toMatch(/@media \(max-width: 600px\) \{[\s\S]*?\.ds-navbar \{\s*flex-wrap: wrap/);
    expect(tokens).toMatch(/@media \(max-width: 600px\) \{[\s\S]*?\.ds-stat__value \{\s*font-size: var\(--ds-arena-text-stat-mobile\)/);
    expect(tokens).toMatch(/@media \(max-width: 600px\) \{[\s\S]*?\.ds-leader \{\s*display: grid;\s*grid-template-columns: auto minmax\(0, 1fr\)/);
  });

  it("retains visible keyboard focus for shared game controls", () => {
    for (const selector of [".ds-answer:focus-visible", ".ds-topic:focus-visible", ".ds-tabbar__item:focus-visible", ".ds-input:focus-visible"]) {
      expect(tokens).toContain(selector);
    }
  });
});