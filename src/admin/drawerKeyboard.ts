/**
 * Pure keyboard model for the mobile navigation drawer, kept DOM-free so it
 * can be unit tested under Node.
 *
 * Returns what the drawer should do for a key press given the list of
 * focusable elements and the index of the currently focused one (-1 when focus
 * is outside the drawer).
 */
export type DrawerKeyAction =
  | { type: "close" }
  | { type: "focus"; index: number }
  | { type: "none" };

export function drawerKeyAction(
  key: string,
  shiftKey: boolean,
  count: number,
  current: number,
): DrawerKeyAction {
  if (key === "Escape") return { type: "close" };
  if (count === 0) return { type: "none" };
  const last = count - 1;
  switch (key) {
    case "Tab":
      if (shiftKey && current <= 0) return { type: "focus", index: last };
      if (!shiftKey && (current === last || current < 0)) return { type: "focus", index: 0 };
      return { type: "none" };
    case "ArrowDown":
      return { type: "focus", index: current < 0 || current === last ? 0 : current + 1 };
    case "ArrowUp":
      return { type: "focus", index: current <= 0 ? last : current - 1 };
    case "Home":
      return { type: "focus", index: 0 };
    case "End":
      return { type: "focus", index: last };
    default:
      return { type: "none" };
  }
}
