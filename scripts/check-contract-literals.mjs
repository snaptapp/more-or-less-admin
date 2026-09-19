#!/usr/bin/env node
/**
 * Contract_Literal_Check — forbids fact-status and `quantity_kind` string
 * literals anywhere in Admin_Repository TypeScript source other than the
 * Shared_Contract_Artifact (Requirement 9.9).
 *
 * Standalone: takes no arguments, needs no `node_modules`, uses only Node
 * builtins. Invoked as `npm run check:contract-literals`, and as a member of
 * Quality_Gate (Lockfile_Check → Typecheck_Step → Lint_Step → Suppression_Check
 * → Contract_Literal_Check → Test_Suite).
 *
 * Why it exists
 * -------------
 * The four fact statuses (`pending`, `active`, `disputed`, `retired`) and the
 * `quantity_kind` values are owned by Shared_Contract_Artifact
 * (`shared/fact-lifecycle-contract.gen.ts`). Admin source must derive them from
 * that artifact rather than restating them as hand-written string literals, so
 * the two repositories cannot drift the way `FACT_STATUSES` already had. This
 * scan is the ratchet that keeps a literal from creeping back in.
 *
 * Scan set
 * --------
 * Every `.ts` / `.tsx` file under `src/`, EXCEPT the artifact itself. The
 * artifact lives under `shared/`, which is outside `src/` and therefore already
 * excluded; the artifact path is also excluded explicitly so the scan is correct
 * even if the artifact is ever mirrored under `src/`. Other generated files
 * under `shared/` are outside the scan set for the same reason.
 *
 * Forbidden values are NOT hardcoded
 * -----------------------------------
 * The forbidden set is read from the artifact at run time by parsing its
 * `FACT_STATUSES` and `QUANTITY_KINDS` array declarations, so the scan stays in
 * lock-step with the contract: add a status or a quantity kind to the generated
 * artifact and this scan forbids its literal in `src/` automatically.
 *
 * What counts as a hit
 * --------------------
 * A forbidden value appearing as the ENTIRE content of a single- or
 * double-quoted string literal (e.g. `"active"`, `'pending'`). The scan is
 * comment/string-aware, reusing the one-pass span tokenizer approach of
 * `scripts/check-suppressions.mjs`: it locates every string / template / comment
 * span, then inspects only the plain quoted-string spans and compares their exact
 * unescaped content against the forbidden set. Consequences of this deliberate,
 * deterministic shape:
 *   - The word `active` in prose, in a comment, or as an identifier is NOT a hit
 *     — only a string literal equal to a forbidden value is.
 *   - A longer string that merely CONTAINS a forbidden word (e.g. `"retired in
 *     2019"`, a fact `question`) is NOT a hit — the literal must equal the value.
 *   - Template literals are not inspected for equality: a `${...}` interpolation
 *     makes "entire content equals X" ill-defined, and a bare template with no
 *     interpolation that equals a forbidden value is vanishingly unlikely and, if
 *     it ever appears, is caught by review; matching only plain quoted strings
 *     keeps the check free of false positives on templated SQL/URLs.
 *
 * Contract:
 *   - Exit 0 when no forbidden literal appears in any scanned file, writing a
 *     one-line summary to standard output and nothing to standard error.
 *   - On one or more hits, write each `path:line: offending literal` to standard
 *     error, sorted by path then line, exit with a non-zero status code, and
 *     modify no file (Requirement 9.9).
 *   - Fail closed if the artifact cannot be read or its constant arrays cannot be
 *     parsed: a diagnostic on standard error, a non-zero exit, never a pass — an
 *     empty forbidden set would silently pass everything.
 *
 * The module exports the artifact parser (`parseForbiddenLiterals`), the pure
 * per-file scanner (`scanSourceForLiterals`), the tree lister
 * (`listScannedFiles`), and a root-scoped runner (`runContractLiteralCheck`) so
 * tests can drive it against temporary fixture directories. The CLI shell at the
 * bottom runs only on direct invocation.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The Shared_Contract_Artifact, relative to the repository root. */
export const ARTIFACT_RELATIVE_PATH = "shared/fact-lifecycle-contract.gen.ts";

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

/** Exit code for a scan failure (one or more forbidden literals found). */
export const EXIT_LITERAL_FOUND = 1;

/** Exit code for the fail-closed path where the forbidden set cannot be derived. */
export const EXIT_ARTIFACT_UNREADABLE = 2;

/** Raised when the artifact exists but its constant arrays cannot be parsed. */
export class ArtifactParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtifactParseError";
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
// Deriving the forbidden set from the artifact.
// ---------------------------------------------------------------------------

/**
 * Extracts the string members of an exported `const NAME = [ ... ]` array
 * declaration from the artifact source. Deliberately narrow: it matches the
 * generated shape the Contract_Generator emits (a flat array of quoted string
 * literals), not arbitrary TypeScript.
 *
 * @param {string} source artifact source
 * @param {string} constName the exported const to read (e.g. "FACT_STATUSES")
 * @returns {string[]} the string members, in source order
 * @throws {ArtifactParseError} when the declaration is absent or unparseable
 */
export function parseStringArrayConst(source, constName) {
  const src = String(source);
  // Find `const <constName>` then the first `[` after it, then the matching `]`.
  const declaration = new RegExp(`\\bconst\\s+${constName}\\b`).exec(src);
  if (!declaration) {
    throw new ArtifactParseError(
      `${ARTIFACT_RELATIVE_PATH} declares no \`const ${constName}\`.`,
    );
  }
  const open = src.indexOf("[", declaration.index);
  if (open === -1) {
    throw new ArtifactParseError(
      `${ARTIFACT_RELATIVE_PATH}: \`const ${constName}\` has no array literal.`,
    );
  }
  const close = src.indexOf("]", open);
  if (close === -1) {
    throw new ArtifactParseError(
      `${ARTIFACT_RELATIVE_PATH}: \`const ${constName}\` array literal is not closed.`,
    );
  }
  const body = src.slice(open + 1, close);
  const values = [];
  const literalPattern = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let match;
  while ((match = literalPattern.exec(body)) !== null) {
    const raw = match[1] ?? match[2] ?? "";
    values.push(unescapeStringLiteral(raw));
  }
  if (values.length === 0) {
    throw new ArtifactParseError(
      `${ARTIFACT_RELATIVE_PATH}: \`const ${constName}\` array literal contains no string members.`,
    );
  }
  return values;
}

/**
 * The forbidden literal set derived from the artifact: the union of
 * `FACT_STATUSES` and `QUANTITY_KINDS`.
 *
 * @param {string} artifactSource contents of the Shared_Contract_Artifact
 * @returns {{ values: Set<string>, statuses: string[], quantityKinds: string[] }}
 * @throws {ArtifactParseError}
 */
export function parseForbiddenLiterals(artifactSource) {
  const statuses = parseStringArrayConst(artifactSource, "FACT_STATUSES");
  const quantityKinds = parseStringArrayConst(artifactSource, "QUANTITY_KINDS");
  return {
    values: new Set([...statuses, ...quantityKinds]),
    statuses,
    quantityKinds,
  };
}

// ---------------------------------------------------------------------------
// Tokenizer — one pass, locating comment and string/template spans.
// (Mirrors scripts/check-suppressions.mjs so a literal in a comment, and a
//  forbidden word that is only part of a longer string, are not miscounted.)
// ---------------------------------------------------------------------------

/**
 * Finds every comment and string/template span in TypeScript source. Plain
 * quoted strings carry their exact content (so equality can be tested); template
 * literals are tagged so they can be skipped.
 *
 * @param {string} src raw source
 * @returns {{ kind: "comment" | "string" | "template", start: number, end: number, value?: string }[]}
 *   spans in ascending, non-overlapping order
 */
export function scanSpans(src) {
  /** @type {{ kind: "comment" | "string" | "template", start: number, end: number, value?: string }[]} */
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
    // Template literal — tagged, its content deliberately not compared.
    if (c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "`") {
          j++;
          break;
        }
        j++;
      }
      spans.push({ kind: "template", start: i, end: Math.min(j, n) });
      i = Math.min(j, n);
      continue;
    }
    // Single- or double-quoted string literal — content captured for equality.
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let raw = "";
      while (j < n) {
        if (src[j] === "\\") {
          raw += src[j] + (src[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j++;
          break;
        }
        if (src[j] === "\n") {
          // Unterminated single-line string; stop at the newline.
          break;
        }
        raw += src[j];
        j++;
      }
      spans.push({ kind: "string", start: i, end: Math.min(j, n), value: unescapeStringLiteral(raw) });
      i = Math.min(j, n);
      continue;
    }
    i++;
  }
  return spans;
}

/**
 * Resolves the common escape sequences inside a string-literal body to their
 * character values, so the compared content matches what the compiler sees.
 * Unknown escapes drop the backslash (the JS/TS default for e.g. `\z`).
 * @param {string} raw literal body without the surrounding quotes
 * @returns {string}
 */
export function unescapeStringLiteral(raw) {
  return String(raw).replace(/\\(u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|.)/g, (whole, seq) => {
    switch (seq[0]) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        return seq === "0" ? "\0" : seq;
      case "x":
        return String.fromCharCode(parseInt(seq.slice(1), 16));
      case "u":
        if (seq[1] === "{") {
          return String.fromCodePoint(parseInt(seq.slice(2, -1), 16));
        }
        return String.fromCharCode(parseInt(seq.slice(1), 16));
      default:
        return seq;
    }
  });
}

/** 1-based line number of `index` in `src`. */
function lineOf(src, index) {
  let line = 1;
  for (let k = 0; k < index && k < src.length; k++) {
    if (src[k] === "\n") line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Per-file scan.
// ---------------------------------------------------------------------------

/**
 * Scans one TypeScript source string for forbidden string literals. A hit is a
 * plain single- or double-quoted string literal whose exact (unescaped) content
 * equals a forbidden value.
 *
 * @param {string} source raw file contents
 * @param {Set<string>} forbidden the forbidden literal set
 * @returns {{ line: number, index: number, literal: string }[]} hits, ascending by offset
 */
export function scanSourceForLiterals(source, forbidden) {
  const src = String(source);
  const hits = [];
  for (const span of scanSpans(src)) {
    if (span.kind !== "string") continue;
    if (forbidden.has(span.value)) {
      hits.push({ line: lineOf(src, span.start), index: span.start, literal: span.value });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

// ---------------------------------------------------------------------------
// Measuring the tree.
// ---------------------------------------------------------------------------

/**
 * Lists every scanned source file under `<root>/<scanDir>`, repo-relative, sorted
 * lexicographically, EXCLUDING the artifact. Read-only; an unreadable directory
 * is skipped rather than fatal. An absent scan directory yields an empty list.
 *
 * @param {string} root absolute repository (or fixture) root
 * @param {{ scanDir?: string, artifactPath?: string }} [options]
 * @returns {string[]}
 */
export function listScannedFiles(
  root,
  { scanDir = SCAN_ROOT, artifactPath = ARTIFACT_RELATIVE_PATH } = {},
) {
  const excluded = normalizePath(artifactPath);
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
        const normalized = normalizePath(relativePath);
        if (normalized !== excluded) found.push(normalized);
      }
    }
  }

  return found.sort(compareLexicographically);
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

/**
 * Runs Contract_Literal_Check against the repository (or fixture directory)
 * rooted at `root`. Returns the outcome instead of writing or exiting, so tests
 * can assert on it. Never writes a file.
 *
 * @param {string} [root]
 * @param {{ scanDir?: string, artifactPath?: string }} [options]
 * @returns {{ ok: boolean, exitCode: number, stdout: string[], stderr: string[] }}
 */
export function runContractLiteralCheck(
  root = process.cwd(),
  { scanDir = SCAN_ROOT, artifactPath = ARTIFACT_RELATIVE_PATH } = {},
) {
  const artifactAbsolute = path.join(root, artifactPath);
  if (!existsSync(artifactAbsolute)) {
    return {
      ok: false,
      exitCode: EXIT_ARTIFACT_UNREADABLE,
      stdout: [],
      stderr: [
        `check-contract-literals: Shared_Contract_Artifact ${normalizePath(artifactPath)} is absent; cannot derive the forbidden literal set.`,
        "check-contract-literals: refusing to report a pass without the artifact.",
      ],
    };
  }

  /** @type {{ values: Set<string>, statuses: string[], quantityKinds: string[] }} */
  let forbidden;
  try {
    forbidden = parseForbiddenLiterals(readFileSync(artifactAbsolute, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      exitCode: EXIT_ARTIFACT_UNREADABLE,
      stdout: [],
      stderr: [
        `check-contract-literals: cannot derive the forbidden literal set: ${detail}`,
        "check-contract-literals: refusing to report a pass with an empty forbidden set.",
      ],
    };
  }

  const files = listScannedFiles(root, { scanDir, artifactPath });

  /** @type {{ filePath: string, line: number, literal: string }[]} */
  const hits = [];
  for (const relativePath of files) {
    const source = readFileSync(path.join(root, relativePath), "utf8");
    for (const hit of scanSourceForLiterals(source, forbidden.values)) {
      hits.push({ filePath: relativePath, line: hit.line, literal: hit.literal });
    }
  }

  hits.sort(
    (a, b) => compareLexicographically(a.filePath, b.filePath) || a.line - b.line,
  );

  if (hits.length > 0) {
    const affected = new Set(hits.map((hit) => hit.filePath)).size;
    const stderr = [
      `check-contract-literals: ${hits.length} forbidden fact-status / quantity_kind string literal${hits.length === 1 ? "" : "s"} found in ${affected} file${affected === 1 ? "" : "s"} outside ${normalizePath(artifactPath)}:`,
      ...hits.map((hit) => `  ${hit.filePath}:${hit.line}: ${JSON.stringify(hit.literal)}`),
      `check-contract-literals: these values are owned by ${normalizePath(artifactPath)} — derive them from FACT_STATUSES / QUANTITY_KINDS instead of writing the literal.`,
    ];
    return { ok: false, exitCode: EXIT_LITERAL_FOUND, stdout: [], stderr };
  }

  const forbiddenCount = forbidden.values.size;
  return {
    ok: true,
    exitCode: 0,
    stdout: [
      `check-contract-literals: OK — ${files.length} file${files.length === 1 ? "" : "s"} scanned, no forbidden literal (of ${forbiddenCount} contract value${forbiddenCount === 1 ? "" : "s"}) appears outside ${normalizePath(artifactPath)}.`,
    ],
    stderr: [],
  };
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
  const outcome = runContractLiteralCheck(process.cwd());
  for (const line of outcome.stdout) process.stdout.write(`${line}\n`);
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
  process.exit(outcome.exitCode);
}
