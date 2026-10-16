/**
 * Game-mode visibility flags read by the More or Less client.
 *
 * The client reads one Remote Config BOOLEAN per mode, `mode_<id>_visible`
 * (`client/lib/services/remote_config_service.dart` in snaptapp/more-or-less).
 * A key absent from the template falls back to the client default, which shows
 * only Solitaire. Server admission for Arena/Octagon is a separate Worker
 * switch (`ARENA_ADMISSION_ENABLED` / `OCTAGON_ADMISSION_ENABLED`); this flag
 * only controls whether the mode is listed in the client.
 */

export const GAME_MODE_IDS = [
  "solitaire",
  "arena",
  "octagon",
  "standard",
  "cutthroat",
  "daily",
  "versus",
  "blitz",
  "party",
] as const;

export type GameModeId = (typeof GAME_MODE_IDS)[number];

export type ModeVisibility = Record<GameModeId, boolean>;

export interface GameModeDescriptor {
  id: GameModeId;
  label: string;
  group: "launch" | "legacy";
  description: string;
}

export const GAME_MODES: readonly GameModeDescriptor[] = [
  { id: "solitaire", label: "Solitaire", group: "launch", description: "60-second solo run. Client-scored, self-reported." },
  { id: "arena", label: "Arena", group: "launch", description: "Scheduled 5-minute-slot event, server-ranked. Also needs Worker admission." },
  { id: "octagon", label: "Octagon", group: "launch", description: "Scheduled 10-minute-slot elimination event. Also needs Worker admission." },
  { id: "standard", label: "Classic", group: "legacy", description: "Standard 5-round solo game." },
  { id: "cutthroat", label: "Cutthroat", group: "legacy", description: "Sudden-death solo game." },
  { id: "daily", label: "Daily Blitz", group: "legacy", description: "15-question daily challenge." },
  { id: "versus", label: "Duel", group: "legacy", description: "Async 1v1 versus." },
  { id: "blitz", label: "60-Sec Blitz", group: "legacy", description: "60-second solo blitz." },
  { id: "party", label: "Live Party", group: "legacy", description: "Real-time party room." },
];

export function modeVisibilityKey(id: GameModeId): string {
  return `mode_${id}_visible`;
}

export const MODE_VISIBILITY_KEYS: ReadonlySet<string> = new Set(GAME_MODE_IDS.map(modeVisibilityKey));

/** Mirrors the client fallback: only Solitaire is visible when a key is unset. */
export function defaultModeVisibility(id: GameModeId): boolean {
  return id === "solitaire";
}

interface VisibilityParam {
  defaultValue?: { value?: string };
}

/**
 * Reads the effective default visibility of every mode from template parameters.
 * Conditional values (per-audience rollouts) are preserved on publish but are not
 * reflected here; the toggle edits the default value only.
 */
export function parseModeVisibility(parameters: Record<string, VisibilityParam | undefined> | undefined): ModeVisibility {
  const result = {} as ModeVisibility;
  for (const id of GAME_MODE_IDS) {
    const raw = parameters?.[modeVisibilityKey(id)]?.defaultValue?.value;
    result[id] = raw === undefined ? defaultModeVisibility(id) : raw.trim().toLowerCase() === "true";
  }
  return result;
}

/** Ids whose conditional values exist, so the UI can warn that overrides apply. */
export function modesWithConditionalValues(
  parameters: Record<string, { conditionalValues?: Record<string, unknown> } | undefined> | undefined,
): GameModeId[] {
  return GAME_MODE_IDS.filter((id) => Object.keys(parameters?.[modeVisibilityKey(id)]?.conditionalValues ?? {}).length > 0);
}

/**
 * Writes only the modes whose desired value differs from the current effective
 * value, so an untouched mode never gains an explicit key and keeps tracking the
 * client default. Existing conditional values on a written key are preserved.
 */
export function applyModeVisibility<P extends { defaultValue?: { value?: string }; valueType?: string; description?: string }>(
  parameters: Record<string, P>,
  desired: Partial<ModeVisibility>,
): GameModeId[] {
  const current = parseModeVisibility(parameters);
  const changed: GameModeId[] = [];
  for (const id of GAME_MODE_IDS) {
    const next = desired[id];
    if (next === undefined || next === current[id]) continue;
    const key = modeVisibilityKey(id);
    parameters[key] = {
      ...parameters[key],
      defaultValue: { value: String(next) },
      valueType: "BOOLEAN",
      description: `Show the ${id} mode in the More or Less client`,
    } as P;
    changed.push(id);
  }
  return changed;
}
