/** Editorial taxonomy labels. Firestore still uses category / sub_category / subject.
 *
 * Conceptual model (docs/TAXONOMY_MATCH_SCOPE_SPEC.md):
 *   Genre → Topic, with Match Scope as resolver metadata.
 * `sub_category` is the stored representation of Match Scope, not a taxonomy level.
 */

export const GENRES = [
  "Animals & Nature",
  "Science & Space",
  "Sports",
  "Music",
  "Movies & TV",
  "Pop Culture & Records",
  "History & World",
  "Food & Drink",
  "Technology",
  "Money & Business",
  "General",
] as const;

export type Genre = (typeof GENRES)[number];

export const CONTENT_VIEWS = ["facts", "topics", "playlists", "crawl"] as const;
export type ContentView = (typeof CONTENT_VIEWS)[number];

export function isContentView(value: unknown): value is ContentView {
  return typeof value === "string" && (CONTENT_VIEWS as readonly string[]).includes(value);
}

/**
 * Starter match scopes per genre. Live values from fact_subjects are merged in the UI.
 *
 * A match scope exists only when a user might reasonably type that term and expect
 * it to select a meaningful group of Topics narrower than the Genre. Junk-drawer
 * scopes (catch-alls like "Genres & Styles") must not be seeded here.
 */
export const SEED_MATCH_SCOPES: Record<Genre, readonly string[]> = {
  "Animals & Nature": ["Mammals", "Reptiles", "Marine Life", "Insects", "Birds", "Plants"],
  "Science & Space": ["Astronomy", "Physics", "Biology", "Earth Science"],
  Sports: ["Football", "Basketball", "Baseball", "Soccer", "Olympics"],
  Music: ["Awards & Records", "Media & Live"],
  "Movies & TV": ["Box Office", "TV Series", "Awards", "Animation"],
  "Pop Culture & Records": ["World Records", "Internet", "Celebrities"],
  "History & World": ["Ancient", "Modern", "Geography", "Politics"],
  "Food & Drink": ["Cooking", "Drinks", "Restaurants"],
  Technology: ["Computing", "Gadgets", "Internet"],
  "Money & Business": ["Markets", "Companies", "Wealth"],
  General: [],
};

/** Normalizes taxonomy key for case-insensitive and punctuation-free comparison. */
export function normalizeTaxonomyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validates the strict distinctness invariant:
 * Genre (Category) != Match Scope (SubCategory) != Topic (Subject).
 * Returns an error message if invalid, or null if valid.
 */
export function validateTaxonomy(
  genre?: string | null,
  matchScope?: string | null,
  topic?: string | null,
): string | null {
  const gKey = genre ? normalizeTaxonomyKey(genre) : "";
  const fKey = matchScope ? normalizeTaxonomyKey(matchScope) : "";
  const tKey = topic ? normalizeTaxonomyKey(topic) : "";

  if (gKey && fKey && gKey === fKey) {
    return "Match Scope cannot be the same as Genre.";
  }
  if (gKey && tKey && gKey === tKey) {
    return "Topic cannot be the same as Genre.";
  }
  if (fKey && tKey && fKey === tKey) {
    return "Topic cannot be the same as Match Scope.";
  }
  return null;
}

export function matchScopesForGenre(
  genre: string,
  observed: readonly string[] = [],
): string[] {
  const seed = (SEED_MATCH_SCOPES as Record<string, readonly string[]>)[genre] ?? [];
  const merged = new Set<string>();
  const genreKey = normalizeTaxonomyKey(genre);
  for (const name of [...seed, ...observed]) {
    const trimmed = name.trim();
    if (trimmed && normalizeTaxonomyKey(trimmed) !== genreKey) {
      merged.add(trimmed);
    }
  }
  return [...merged].sort((a, b) => a.localeCompare(b));
}
