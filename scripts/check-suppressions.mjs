#!/usr/bin/env node
/**
 * Suppression_Check — ratchets Type_Suppression counts against a recorded
 * baseline (Requirement 4).
 *
 * Standalone: takes no arguments, needs no `node_modules`, uses only Node
 * builtins. Invoked as `npm run check:suppressions`, and as the fourth member of
 * Quality_Gate (Lockfile_Check → Typecheck_Step → Lint_Step → Suppression_Check
 * → Test_Suite).
 *
 * Scan set: every `.ts` / `.tsx` file under `src/`.
 *
 * A Type_Suppression is any of the six Glossary forms. Exactly one occurrence is
 * counted per form instance found, so a single source location contributes 1 to
 * the count, never 2 for overlapping forms (`x as unknown as Foo` is one
 * cast-through-unknown, not additionally an `unknown` and a cast):
 *
 *   1. `@ts-ignore`                    — comment form
 *   2. `@ts-expect-error`              — comment form
 *   3. `@typescript-eslint` disable    — comment form (an `eslint-disable`,
 *                                        `eslint-disable-line`, or
 *                                        `eslint-disable-next-line` directive
 *                                        naming a `@typescript-eslint` rule)
 *   4. explicit `any` annotation       — code form (`any` in a type position)
 *   5. cast to `any`                   — code form (`x as any`)
 *   6. cast through `unknown`          — code form (`x as unknown as Narrower`)
 *
 * Counting is a deterministic lexical scan over comment/string-aware tokenized
 * source, reusing the comment-stripping approach of the Main_Repository's
 * `scripts/assert_derivation_tables.mjs` / `scripts/assert_ddm_purity.mjs`: the
 * source is tokenized once into comment and string/template spans, and the two
 * scans then run over complementary views of it. Code forms are counted over the
 * view with comments AND string/template literals blanked, so `step="any"` in a
 * JSX attribute and the word "any" in prose are not miscounted. Comment forms are
 * counted over the view with everything BUT comments blanked, so a
 * `"@ts-ignore"` string is not miscounted as a directive. Blanking preserves
 * length and newlines, so reported line numbers stay accurate.
 *
 * Known, deliberate limitations of the lexical approach (identical to the
 * precedent, and deterministic either way): a suppression inside a template
 * literal `${...}` interpolation is not counted, because the whole template span
 * is blanked; and a regular-expression literal containing a quote or `//` can
 * confuse span detection. Both are absent from this repository's scan set.
 *
 * Contract:
 *   - Exit 0 **iff** every scanned file's measured count is ≤ its baseline count
 *     (an absent baseline entry treated as 0) AND every baseline entry maps to a
 *     file present in the repository (4.10).
 *   - Over baseline → path, baseline and measured on stderr, non-zero exit, the
 *     baseline file left unmodified (4.4).
 *   - Occurrences with no baseline entry → baseline treated as 0, path and
 *     measured on stderr, non-zero exit (4.8).
 *   - Under baseline → path, baseline and measured on stdout, exit 0 (4.7).
 *   - Stale baseline entry (path absent from the repository) → path on stderr
 *     with an instruction to remove it from the baseline, non-zero exit (4.9).
 *   - On the pass condition nothing is written to stderr (4.3).
 *   - This check never writes any file. The baseline is a ratchet: it is
 *     maintained by hand (task 4.2), never rewritten by the check.
 *
 * The module exports the pure counter (`countSuppressions`, usable on any source
 * string), the pure comparator (`compareSuppressions`), and a root-scoped runner
 * (`runSuppressionCheck`) so tests can drive it against temporary fixture
 * directories. The CLI shell below runs only on direct invocation.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Tracked baseline file, at the repository root. */
export const BASELINE_FILENAME = "suppression-baseline.json";

/** Directory whose TypeScript sources are scanned, relative to the root. */
export const SCAN_ROOT = "src";

/** File extensions in the scan set. */
export const SCANNED_EXTENSIONS = Object.freeze([".ts", ".tsx"]);

/** Directories never descended into. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".output",
  ".wrangler",
  "build",
  "dist",
  "node_modules",
]);

/** Exit code for a comparison failure (over baseline, unbaselined, or stale). */
export const EXIT_COMPARISON_FAILURE = 1;

/** Exit code for the fail-closed path where the baseline cannot be read. */
export const EXIT_BASELINE_UNREADABLE = 2;

/** The six Type_Suppression forms, as reported by `countSuppressions`. */
export const SUPPRESSION_FORMS = Object.freeze([
  "ts-ignore",
  "ts-expect-error",
  "typescript-eslint-disable",
  "explicit-any",
  "cast-to-any",
  "cast-through-unknown",
]);

/** Raised when the baseline file exists but is not a usable baseline map. */
export class BaselineFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "BaselineFormatError";
  }
}

/** Byte-wise lexicographic comparison (deliberately not locale-aware). */
function compareLexicographically(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Normalizes a repo-relative path to forward slashes with no `./` prefix. */
export function normalizePath(candidate) {
  return String(candidate).replace(/\\/g, "/").replace(/^\.\//, "");
}

// ---------------------------------------------------------------------------
// Tokenizer — one pass, two complementary views.
// ---------------------------------------------------------------------------

/**
 * Finds every comment and string/template span in TypeScript source. A small,
 * dependency-free lexer: it does not parse TypeScript, it only locates the spans
 * that could hide or fake a suppression token.
 *
 * @param {string} src raw source
 * @returns {{ kind: "comment" | "string", start: number, end: number }[]} spans
 *   in ascending, non-overlapping order
 */
export function scanSpans(src) {
  /** @type {{ kind: "comment" | "string", start: number, end: number }[]} */
  const spans = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // Line comment.
    if (c === "/" && c2 === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      spans.push({ kind: "comment", start: i, end: j });
      i = j;
      continue;
    }
    // Block comment.
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      spans.push({ kind: "comment", start: i, end: j });
      i = j;
      continue;
    }
    // String or template literal.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      spans.push({ kind: "string", start: i, end: Math.min(j, n) });
      i = Math.min(j, n);
      continue;
    }
    i++;
  }
  return spans;
}

/**
 * Blanks the given spans to equal-length runs of spaces, preserving newlines so
 * offsets and line numbers are unchanged.
 * @param {string} src
 * @param {{ start: number, end: number }[]} spans
 */
function blankSpans(src, spans) {
  if (spans.length === 0) return src;
  // split("") keeps one array slot per UTF-16 code unit, so array indices stay
  // aligned with string offsets even for astral characters.
  const chars = src.split("");
  for (const { start, end } of spans) {
    for (let k = start; k < end && k < chars.length; k++) {
      if (chars[k] !== "\n") chars[k] = " ";
    }
  }
  return chars.join("");
}

/**
 * The code view: comments and string/template literals blanked, executable code
 * intact. Code-form suppressions are counted here.
 * @param {string} src raw source
 * @returns {string}
 */
export function stripCommentsAndStrings(src) {
  return blankSpans(src, scanSpans(src));
}

/**
 * The comment view: everything except comment spans blanked. Comment-form
 * directives are counted here, so a directive spelled inside a string literal is
 * not miscounted.
 * @param {string} src raw source
 * @returns {string}
 */
export function commentTextOnly(src) {
  const comments = scanSpans(src).filter((span) => span.kind === "comment");
  const keep = new Uint8Array(src.length);
  for (const { start, end } of comments) {
    for (let k = start; k < end && k < src.length; k++) keep[k] = 1;
  }
  const chars = src.split("");
  for (let k = 0; k < chars.length; k++) {
    if (keep[k] !== 1 && chars[k] !== "\n") chars[k] = " ";
  }
  return chars.join("");
}

// ---------------------------------------------------------------------------
// Counting.
// ---------------------------------------------------------------------------

/** Comment-form directives. One occurrence per match. */
const TS_IGNORE_PATTERN = /@ts-ignore/g;
const TS_EXPECT_ERROR_PATTERN = /@ts-expect-error/g;
/** An eslint-disable directive; counted only when it names a @typescript-eslint rule. */
const ESLINT_DISABLE_PATTERN = /eslint-disable(?:-next-line|-line)?\b[^\n]*/g;
const TYPESCRIPT_ESLINT_RULE_PATTERN = /@typescript-eslint\b/;

/**
 * Code-form suppressions. Alternatives are ordered so the longest, most specific
 * form wins at any given position, and each match consumes its own text, so one
 * source location yields exactly one occurrence:
 *   1. `as unknown as Narrower`  — the cast-through-unknown form (the trailing
 *      type name is consumed so its `any`, in `as unknown as any`, is not counted
 *      a second time). A bare `x as unknown` widening cast is deliberately NOT a
 *      suppression: the Glossary form is a cast *through* `unknown` to a
 *      narrower type.
 *   2. `as any`                  — the cast-to-any form.
 *   3. `any`                     — a candidate explicit annotation, accepted only
 *      when it sits in a type position (see isTypePositionAny).
 */
const CODE_SUPPRESSION_PATTERN =
  /\bas\s+unknown\s+as\s+(?:[A-Za-z_$][\w$]*)?|\bas\s+any\b|\bany\b/g;

/**
 * Punctuation that can immediately precede a type. Used to accept a bare `any`
 * as an explicit annotation while rejecting the word in non-type positions.
 * `>` is deliberately absent so JSX text (`<p>any thing</p>`) cannot be counted,
 * and `.` is absent so a member access (`z.any()`, a zod schema, not a TypeScript
 * annotation) is not counted.
 */
const TYPE_POSITION_PUNCTUATION = new Set([
  ":",
  "<",
  ",",
  "|",
  "&",
  "=",
  "[",
  "(",
  "?",
]);

/** Keywords that can immediately precede a type. */
const TYPE_POSITION_KEYWORDS = new Set([
  "extends",
  "in",
  "is",
  "keyof",
  "readonly",
  "satisfies",
]);

/**
 * Decides whether a bare `any` token at `index` in the code view occupies a type
 * position, by inspecting the nearest preceding non-whitespace token. Purely
 * lexical and deterministic; deliberately conservative — a construct that is not
 * recognisably a type position is not counted.
 * @param {string} code the code view (comments/strings blanked)
 * @param {number} index offset of the `any` token
 * @returns {boolean}
 */
export function isTypePositionAny(code, index) {
  let k = index - 1;
  while (k >= 0 && /\s/.test(code[k])) k--;
  if (k < 0) return false;
  const previous = code[k];
  if (TYPE_POSITION_PUNCTUATION.has(previous)) return true;
  if (!/[A-Za-z_$]/.test(previous)) return false;
  let start = k;
  while (start >= 0 && /[\w$]/.test(code[start])) start--;
  return TYPE_POSITION_KEYWORDS.has(code.slice(start + 1, k + 1));
}

/** 1-based line number of `index` in `src`. */
function lineOf(src, index) {
  let line = 1;
  for (let k = 0; k < index && k < src.length; k++) {
    if (src[k] === "\n") line++;
  }
  return line;
}

/**
 * Counts Type_Suppression occurrences in one TypeScript source string.
 *
 * @param {string} source raw file contents
 * @returns {{
 *   total: number,
 *   byForm: Record<string, number>,
 *   occurrences: { form: string, line: number, index: number, text: string }[],
 * }} occurrences ascending by offset
 */
export function countSuppressions(source) {
  const src = String(source);
  const code = stripCommentsAndStrings(src);
  const comments = commentTextOnly(src);

  /** @type {{ form: string, line: number, index: number, text: string }[]} */
  const occurrences = [];

  const pushMatches = (view, pattern, form, accept) => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(view)) !== null) {
      if (match[0] === "") {
        pattern.lastIndex++;
        continue;
      }
      const resolvedForm = accept ? accept(match) : form;
      if (resolvedForm !== null) {
        occurrences.push({
          form: resolvedForm,
          line: lineOf(src, match.index),
          index: match.index,
          text: match[0].replace(/\s+/g, " ").trim(),
        });
      }
    }
  };

  pushMatches(comments, TS_IGNORE_PATTERN, "ts-ignore");
  pushMatches(comments, TS_EXPECT_ERROR_PATTERN, "ts-expect-error");
  pushMatches(comments, ESLINT_DISABLE_PATTERN, null, (match) =>
    TYPESCRIPT_ESLINT_RULE_PATTERN.test(match[0]) ? "typescript-eslint-disable" : null,
  );
  pushMatches(code, CODE_SUPPRESSION_PATTERN, null, (match) => {
    const text = match[0];
    if (/^as\s+unknown\b/.test(text)) return "cast-through-unknown";
    if (/^as\b/.test(text)) return "cast-to-any";
    return isTypePositionAny(code, match.index) ? "explicit-any" : null;
  });

  occurrences.sort((a, b) => a.index - b.index);

  /** @type {Record<string, number>} */
  const byForm = {};
  for (const form of SUPPRESSION_FORMS) byForm[form] = 0;
  for (const occurrence of occurrences) byForm[occurrence.form] += 1;

  return { total: occurrences.length, byForm, occurrences };
}

// ---------------------------------------------------------------------------
// Measuring the tree.
// ---------------------------------------------------------------------------

/**
 * Lists every scanned source file under `<root>/<scanDir>`, repo-relative, sorted
 * lexicographically. Read-only; an unreadable directory is skipped rather than
 * fatal. An absent scan directory yields an empty list, so the runner works
 * against a fixture directory that has no `src/`.
 *
 * @param {string} root absolute repository (or fixture) root
 * @param {string} [scanDir]
 * @returns {string[]}
 */
export function listScannedFiles(root, scanDir = SCAN_ROOT) {
  const found = [];
  const pending = [scanDir];

  while (pending.length > 0) {
    const relativeDir = pending.pop();
    let entries;
    try {
      entries = readdirSync(path.join(root, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(relativePath);
      } else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        found.push(normalizePath(relativePath));
      }
    }
  }

  return found.sort(compareLexicographically);
}

/**
 * Measures the Type_Suppression count of every scanned file, including files
 * with a count of 0 (so an under-baseline improvement to 0 is still reported).
 *
 * @param {string} root absolute repository (or fixture) root
 * @param {{ scanDir?: string }} [options]
 * @returns {Record<string, number>} repo-relative path → count
 */
export function measureSuppressions(root, { scanDir = SCAN_ROOT } = {}) {
  /** @type {Record<string, number>} */
  const measured = {};
  for (const relativePath of listScannedFiles(root, scanDir)) {
    const source = readFileSync(path.join(root, relativePath), "utf8");
    measured[relativePath] = countSuppressions(source).total;
  }
  return measured;
}

// ---------------------------------------------------------------------------
// Baseline.
// ---------------------------------------------------------------------------

/**
 * Parses and validates the baseline document: a flat JSON object mapping
 * repo-relative path → non-negative integer count. Fails closed on anything else.
 *
 * @param {string} text file contents
 * @returns {Record<string, number>}
 * @throws {BaselineFormatError}
 */
export function parseBaseline(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BaselineFormatError(
      `${BASELINE_FILENAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BaselineFormatError(
      `${BASELINE_FILENAME} must be a JSON object mapping repository-relative path to an integer count.`,
    );
  }

  /** @type {Record<string, number>} */
  const baseline = {};
  for (const [rawKey, value] of Object.entries(parsed)) {
    const key = normalizePath(rawKey);
    if (key === "") {
      throw new BaselineFormatError(`${BASELINE_FILENAME} contains an empty path key.`);
    }
    if (key.startsWith("/") || /^[A-Za-z]:/.test(key) || key.split("/").includes("..")) {
      throw new BaselineFormatError(
        `${BASELINE_FILENAME} entry "${rawKey}" must be a repository-relative path without '..' segments.`,
      );
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new BaselineFormatError(
        `${BASELINE_FILENAME} entry "${rawKey}" must be a non-negative integer count, got ${JSON.stringify(
          value,
        )}.`,
      );
    }
    baseline[key] = value;
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// Comparison.
// ---------------------------------------------------------------------------

/**
 * Pure comparator. Given the measured counts, the recorded baseline, and the set
 * of paths present in the repository, decides the outcome without touching the
 * filesystem and without ever rewriting the baseline.
 *
 * Exit 0 iff every measured count ≤ its baseline count (an absent baseline entry
 * treated as 0) and every baseline entry corresponds to a present path
 * (Requirement 4.10).
 *
 * @param {{
 *   measured: Record<string, number>,
 *   baseline?: Record<string, number>,
 *   presentPaths?: Iterable<string>,
 * }} input `presentPaths` defaults to the measured paths.
 * @returns {{ ok: boolean, exitCode: number, stdout: string[], stderr: string[] }}
 */
export function compareSuppressions({ measured, baseline = {}, presentPaths }) {
  /** @type {Record<string, number>} */
  const measuredCounts = {};
  for (const [rawPath, count] of Object.entries(measured)) {
    measuredCounts[normalizePath(rawPath)] = count;
  }
  /** @type {Record<string, number>} */
  const baselineCounts = {};
  for (const [rawPath, count] of Object.entries(baseline)) {
    baselineCounts[normalizePath(rawPath)] = count;
  }
  const present = new Set(
    [...(presentPaths ?? Object.keys(measuredCounts))].map(normalizePath),
  );

  const overBaseline = [];
  const unbaselined = [];
  const improved = [];

  for (const filePath of Object.keys(measuredCounts).sort(compareLexicographically)) {
    const measuredCount = measuredCounts[filePath];
    const hasEntry = Object.prototype.hasOwnProperty.call(baselineCounts, filePath);
    const baselineCount = hasEntry ? baselineCounts[filePath] : 0;
    if (measuredCount > baselineCount) {
      (hasEntry ? overBaseline : unbaselined).push({
        filePath,
        baselineCount,
        measuredCount,
      });
    } else if (measuredCount < baselineCount) {
      improved.push({ filePath, baselineCount, measuredCount });
    }
  }

  const stale = Object.keys(baselineCounts)
    .filter((filePath) => !present.has(filePath))
    .sort(compareLexicographically);

  const stdout = improved.map(
    ({ filePath, baselineCount, measuredCount }) =>
      `check-suppressions: improvement: ${filePath}: baseline ${baselineCount}, measured ${measuredCount} (${baselineCount - measuredCount
      } fewer). Lower the baseline entry to lock the gain in.`,
  );

  const stderr = [];

  if (overBaseline.length > 0) {
    stderr.push(
      `check-suppressions: ${overBaseline.length} file${overBaseline.length === 1 ? "" : "s"
      } exceed the recorded Type_Suppression baseline:`,
      ...overBaseline.map(
        ({ filePath, baselineCount, measuredCount }) =>
          `  ${filePath}: baseline ${baselineCount}, measured ${measuredCount} (${measuredCount - baselineCount
          } over)`,
      ),
    );
  }

  if (unbaselined.length > 0) {
    stderr.push(
      `check-suppressions: ${unbaselined.length} file${unbaselined.length === 1 ? "" : "s"
      } carry Type_Suppression occurrences with no baseline entry (baseline treated as 0):`,
      ...unbaselined.map(
        ({ filePath, measuredCount }) =>
          `  ${filePath}: baseline 0 (no entry), measured ${measuredCount}`,
      ),
    );
  }

  if (stale.length > 0) {
    stderr.push(
      `check-suppressions: ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"
      } stale — the path is not present in the repository and must be removed from ${BASELINE_FILENAME}:`,
      ...stale.map((filePath) => `  ${filePath}: stale, remove from baseline`),
    );
  }

  if (stderr.length > 0) {
    stderr.push(
      `check-suppressions: ${BASELINE_FILENAME} is a ratchet and was not modified. ` +
      "Resolve the suppression with a genuine type fix rather than raising the baseline.",
    );
    return { ok: false, exitCode: EXIT_COMPARISON_FAILURE, stdout, stderr };
  }

  const scannedCount = Object.keys(measuredCounts).length;
  const total = Object.values(measuredCounts).reduce((sum, count) => sum + count, 0);
  stdout.push(
    `check-suppressions: OK — ${scannedCount} file${scannedCount === 1 ? "" : "s"
    } scanned, ${total} Type_Suppression occurrence${total === 1 ? "" : "s"
    }, every file within its baseline.`,
  );

  return { ok: true, exitCode: 0, stdout, stderr: [] };
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

/**
 * Runs Suppression_Check against the repository (or fixture directory) rooted at
 * `root`. Returns the outcome instead of writing or exiting, so tests can assert
 * on it. Never writes a file.
 *
 * @param {string} [root]
 * @param {{ scanDir?: string }} [options]
 * @returns {{ ok: boolean, exitCode: number, stdout: string[], stderr: string[] }}
 */
export function runSuppressionCheck(root = process.cwd(), { scanDir = SCAN_ROOT } = {}) {
  const baselinePath = path.join(root, BASELINE_FILENAME);
  const baselineExists = existsSync(baselinePath);

  /** @type {Record<string, number>} */
  let baseline = {};
  if (baselineExists) {
    try {
      baseline = parseBaseline(readFileSync(baselinePath, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        exitCode: EXIT_BASELINE_UNREADABLE,
        stdout: [],
        stderr: [
          `check-suppressions: cannot read the recorded baseline: ${detail}`,
          "check-suppressions: refusing to report a pass without a usable baseline.",
        ],
      };
    }
  }

  const measured = measureSuppressions(root, { scanDir });
  const presentPaths = new Set(Object.keys(measured));
  for (const filePath of Object.keys(baseline)) {
    if (existsSync(path.join(root, filePath))) presentPaths.add(filePath);
  }

  const outcome = compareSuppressions({ measured, baseline, presentPaths });

  if (!baselineExists) {
    outcome.stdout.unshift(
      `check-suppressions: advisory: ${BASELINE_FILENAME} is absent; every baseline count is treated as 0.`,
    );
  }

  return outcome;
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  const outcome = runSuppressionCheck(process.cwd());
  for (const line of outcome.stdout) process.stdout.write(`${line}\n`);
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
  process.exit(outcome.exitCode);
}
