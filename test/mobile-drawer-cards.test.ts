import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { drawerKeyAction } from "@/admin/drawerKeyboard";

const root = path.resolve(__dirname, "..");
const css = readFileSync(path.join(root, "src/admin/admin.css"), "utf8");
const shell = readFileSync(path.join(root, "src/admin/AdminShell.tsx"), "utf8");
const facts = readFileSync(path.join(root, "src/routes/admin/facts.tsx"), "utf8");

function mediaBlock(maxWidth: number): string {
  const blocks: string[] = [];
  const re = new RegExp(`@media \\(max-width: ${maxWidth}px\\) \\{`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    blocks.push(css.slice(m.index, i));
  }
  return blocks.join("\n");
}

describe("mobile drawer keyboard model", () => {
  it("Escape closes regardless of focus", () => {
    expect(drawerKeyAction("Escape", false, 5, 2)).toEqual({ type: "close" });
    expect(drawerKeyAction("Escape", false, 0, -1)).toEqual({ type: "close" });
  });
  it("Tab traps focus inside the drawer", () => {
    expect(drawerKeyAction("Tab", false, 4, 3)).toEqual({ type: "focus", index: 0 });
    expect(drawerKeyAction("Tab", true, 4, 0)).toEqual({ type: "focus", index: 3 });
    expect(drawerKeyAction("Tab", false, 4, -1)).toEqual({ type: "focus", index: 0 });
    expect(drawerKeyAction("Tab", false, 4, 1)).toEqual({ type: "none" });
  });
  it("arrow keys, Home and End move and wrap between links", () => {
    expect(drawerKeyAction("ArrowDown", false, 9, 0)).toEqual({ type: "focus", index: 1 });
    expect(drawerKeyAction("ArrowDown", false, 9, 8)).toEqual({ type: "focus", index: 0 });
    expect(drawerKeyAction("ArrowUp", false, 9, 0)).toEqual({ type: "focus", index: 8 });
    expect(drawerKeyAction("Home", false, 9, 5)).toEqual({ type: "focus", index: 0 });
    expect(drawerKeyAction("End", false, 9, 5)).toEqual({ type: "focus", index: 8 });
    expect(drawerKeyAction("a", false, 9, 5)).toEqual({ type: "none" });
  });
  it("drawer is an accessible modal that closes on navigation and restores focus", () => {
    expect(shell).toMatch(/role="dialog" aria-modal="true"/);
    expect(shell).toMatch(/aria-expanded=\{menuOpen\}/);
    expect(shell).toMatch(/useEffect\(\(\) => setMenuOpen\(false\), \[pathname\]\)/);
    expect(shell).toMatch(/toggleRef\.current\?\.focus\(\)/);
  });
});

describe("mobile card layouts across narrow widths", () => {
  const at900 = mediaBlock(900);
  const at600 = mediaBlock(600);
  const at380 = mediaBlock(380);

  it("hides the sidebar and shows the drawer header at tablet/phone widths", () => {
    expect(at900).toMatch(/\.admin-sidebar \{ display: none; \}/);
    expect(at900).toMatch(/\.admin-mobile-header/);
  });
  it("turns table rows into cards at phone widths while keeping row actions visible and tappable", () => {
    expect(at600).toMatch(/\.admin-card-table thead \{ display: none; \}/);
    expect(at600).toMatch(/td:last-child:not\(\[colspan\]\):has\(\.ds-button\) \{ display: block/);
    expect(at600).toMatch(/\.ds-button \{ min-height: 44px; \}/);
    expect(at600).not.toMatch(/admin-row-actions[^}]*display: none/);
  });
  it("stacks fact controls into one column on the smallest phones", () => {
    expect(at380).toMatch(/\.admin-mobile-fact-controls \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });
  it("Content cards keep filtering, sorting and pagination", () => {
    const controls = facts.slice(facts.indexOf("admin-mobile-fact-controls"));
    for (const filter of ["subject", "angle", "status", "contentRating", "surpriseFactor"]) {
      expect(controls).toContain(`filters.${filter}`);
    }
    expect(controls).toMatch(/setSort\(/);
    expect(facts).toMatch(/disabled=\{page <= 1\}/);
    expect(facts).toMatch(/setPage\(page \+ 1\)/);
    expect(css).not.toMatch(/admin-pager[^}]*display: none/);
  });
});
