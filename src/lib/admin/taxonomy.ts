/** Editorial taxonomy labels. Firestore still uses category / sub_category / subject. */

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

/** Starter families per genre. Live values from fact_subjects are merged in the UI. */
export const SEED_FAMILIES: Record<Genre, readonly string[]> = {
  "Animals & Nature": ["Mammals", "Reptiles", "Marine Life", "Insects", "Birds", "Plants"],
  "Science & Space": ["Astronomy", "Physics", "Biology", "Earth Science"],
  Sports: ["Football", "Basketball", "Baseball", "Soccer", "Olympics"],
  Music: ["Pop", "Rock", "Hip-Hop", "Country", "Classical", "Awards"],
  "Movies & TV": ["Box Office", "TV Series", "Awards", "Animation"],
  "Pop Culture & Records": ["World Records", "Internet", "Celebrities"],
  "History & World": ["Ancient", "Modern", "Geography", "Politics"],
  "Food & Drink": ["Cooking", "Drinks", "Restaurants"],
  Technology: ["Computing", "Gadgets", "Internet"],
  "Money & Business": ["Markets", "Companies", "Wealth"],
  General: [],
};

export function familiesForGenre(
  genre: string,
  observed: readonly string[] = [],
): string[] {
  const seed = (SEED_FAMILIES as Record<string, readonly string[]>)[genre] ?? [];
  const merged = new Set<string>();
  for (const name of [...seed, ...observed]) {
    const trimmed = name.trim();
    if (trimmed) merged.add(trimmed);
  }
  return [...merged].sort((a, b) => a.localeCompare(b));
}
