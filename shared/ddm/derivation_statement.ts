// Distractor Derivation Model (DDM) — Worker TypeScript port (task 9.5 slice).
//
// This module is the Worker (`src/`) port of the Go reference Statement
// Consistency Gate (plan task 7):
//
//   1. the shared numeric-literal scanner + classifier
//                                    (agent-go/derivation_statement_scan.go,    task 7.1)
//   2. generated inflection + grammar correction
//                                    (agent-go/derivation_statement_inflect.go, task 7.2)
//   3. the policy-parameterized rewrite + revalidation, with EXPLICIT `strict`
//      and `governed_incidental` policies
//                                    (agent-go/derivation_statement_gate.go,    task 7.3)
//   4. the unresolved production-policy build guard
//                                    (agent-go/derivation_statement_policy.go,  task 7.4)
//
// It is intended to be BYTE-IDENTICAL in behavior to the Go reference: the
// scanner spans/classification, inflection tables, rewrite logic, and BOTH
// policy behaviors (including the STATEMENT_UNRECOVERABLE abstain outcome)
// produce identical results to Go's `stmtGateApply`. Task 11.1 replays the
// parity fixture's `statement_cases[]` against this port and compares serialized
// bytes; a local statement-case replay is added in the co-located tests ahead of
// that (Requirements 6.1–6.7, 9.1).
//
// NORMATIVE AUTHORITY (Requirement 9.1): the inflection invariant list,
// irregular map, default pluralization rules, and singular value are consumed
// EXCLUSIVELY from the generated table payload UNIT_TABLES (src/unit_tables_gen.ts)
// `statement_inflection` block — never inlined. The only inline constants are
// structural JSON keys and the deterministic reversal of the generated default
// pluralization rules (which are not themselves stored as reverse rules), exactly
// mirroring the Go reference.
//
// PRODUCTION SELECTOR (Requirement 6.2, RESOLVED and PINNED): the isolated
// production selector is pinned to `numberless_drop`, the numberless-claim
// contract the generation prompt defines. Tests may inject any implemented
// policy directly into stmtGateApply; the production cutover/check
// (stmtProdPolicyCheck) FAILS CLOSED on any selection other than
// numberless_drop. The two rewrite policies are non-production reference
// machinery, not selectable values.
//
// PURITY / CROSS-RUNTIME: rewriting reuses the shared scanner spans, the exact
// fixed-point kernel (compareFixed, formatFixedCanonical, numericIngest), and the
// generated inflection tables only. No floating point, regex on numeric
// magnitudes, locale formatting, clock, randomness, or mutable global state is
// used, so this port produces byte-identical output to Go. Symbol names mirror
// the Go reference so the two implementations read as line-for-line ports (the
// stmtScan*/StatementLiteral*, stmtInflect*, stmtGate*/StmtGate*, and
// stmtProdPolicy* prefixes are preserved).
//
// This module remains DARK: it is not imported by production worker code until
// the atomic cutover (task 16.x).

import { UNIT_TABLES } from "./unit_tables_gen";
import {
  AbstainStatementUnrecoverable,
  compareFixed,
  formatFixedCanonical,
  isASCIIDigit,
  numericIngest,
  type AbstainReason,
  type FixedPointValue,
} from "./derivation";

// ===========================================================================
// Shared numeric-literal scanner and classifier
// (port of agent-go/derivation_statement_scan.go, task 7.1)
// ===========================================================================

// StatementLiteralClass classifies a scanned numeric literal by the role it
// plays in the claim statement. The scanner assigns exactly one class to every
// literal so any implemented Requirement 6.2 policy can act on it later.
export type StatementLiteralClass = "governed" | "incidental";

// LiteralGoverned marks a literal that governs the claim's subject quantity: it
// is the number the sentence is "about" and the one a rewrite must force to
// presented_number. There is at most one governed literal.
export const LiteralGoverned: StatementLiteralClass = "governed";
// LiteralIncidental marks a literal that is part of a proper name or fixed
// designation (e.g. the 11 in "Apollo 11", the 2 in "World War 2"). Under the
// governed/incidental policy it may remain; under strict it must be rewritten or
// dropped. Classification does not decide that outcome.
export const LiteralIncidental: StatementLiteralClass = "incidental";

// StatementLiteral is one numeric literal found in a claim statement, with the
// exact byte span it occupies, its verbatim spelling, its canonical ingested
// value (when it ingests cleanly), whether it is a truth leak, and its
// governed/incidental classification. The span is a half-open byte range
// [start, end) into the original statement string; text is exactly
// statement.slice(start, end). Retaining the raw span lets a later policy rewrite
// the statement deterministically without re-scanning.
//
// NOTE ON "byte" OFFSETS: the Go reference indexes by UTF-8 byte offsets; this
// TypeScript port indexes by UTF-16 code units (JavaScript string indices).
// Every literal, span boundary, and separator the scanner and gate examine is a
// pure ASCII character (digits, sign, comma, dot, exponent, spaces, ASCII
// letters), and ASCII code points occupy exactly one code unit AND one UTF-8
// byte, so the spans, splices, and classifications are byte-identical to Go for
// every ASCII-relevant boundary. Non-ASCII characters are only ever copied
// verbatim, never split, so slicing stays consistent.
export interface StatementLiteral {
  // start and end are the half-open offsets of the literal in the original
  // statement (text === statement.slice(start, end)).
  start: number;
  end: number;
  // text is the verbatim numeric spelling as it appears in the statement,
  // including any sign, decimal point, grouping commas, or exponent.
  text: string;
  // value is the canonical fixed-point value of the literal when it ingests
  // cleanly; undefined when the literal could not be ingested (e.g. an
  // out-of-range or malformed spelling). An undefined value never counts as a
  // truth leak and is classified structurally.
  value?: FixedPointValue;
  // isTruthLeak is true when value is defined and numerically equals the round's
  // true_number. A truth leak is forbidden under BOTH policies.
  isTruthLeak: boolean;
  // class is the governed/incidental classification (exactly one value).
  class: StatementLiteralClass;
}

// StatementScan is the complete, policy-agnostic result of scanning one claim
// statement. It carries the original statement, every literal in left-to-right
// order, and convenience flags a later policy stage can consult. It performs no
// rewriting and selects no policy.
export interface StatementScan {
  // statement is the exact input text that was scanned (unchanged).
  statement: string;
  // literals are every numeric literal found, ordered by ascending start.
  literals: StatementLiteral[];
  // hasTruthLeak is true when any literal is a truth leak.
  hasTruthLeak: boolean;
  // governedIndex is the index into literals of the single governed literal, or
  // -1 when no literal is governed.
  governedIndex: number;
}

// stmtScanStatement scans a claim statement for numeric literals and classifies
// them against the round's true and presented numbers. Both truth and presented
// are canonical fixed-point values already produced by Numeric_Ingest upstream;
// the scanner ingests each in-statement literal the same way so comparisons are
// exact and cross-runtime stable.
//
// Truth-leak detection compares each ingested literal against `truth` with the
// exact fixed-point comparator. Governed/incidental classification is structural
// (see stmtScanClassify): the literal whose value equals the presented number,
// or otherwise the first standalone literal not embedded in a proper name, is
// governed; proper-name-embedded literals are incidental.
export function stmtScanStatement(
  statement: string,
  truth: FixedPointValue,
  presented: FixedPointValue,
): StatementScan {
  const spans = stmtScanFindLiterals(statement);

  const scan: StatementScan = {
    statement,
    literals: [],
    hasTruthLeak: false,
    governedIndex: -1,
  };

  for (const sp of spans) {
    const lit: StatementLiteral = {
      start: sp.start,
      end: sp.end,
      text: statement.slice(sp.start, sp.end),
      isTruthLeak: false,
      class: LiteralIncidental,
    };
    // Ingest the literal to its canonical value. numericIngest requires a bare
    // JSON number token, so grouping commas are removed first; a literal that
    // still fails ingest keeps an undefined value.
    const [v, ok] = stmtScanIngestLiteral(lit.text);
    if (ok) {
      lit.value = v;
      const [cmp, cok] = compareFixed(v, truth);
      if (cok && cmp === 0) {
        lit.isTruthLeak = true;
        scan.hasTruthLeak = true;
      }
    }
    scan.literals.push(lit);
  }

  stmtScanClassify(statement, scan.literals, presented);
  for (let i = 0; i < scan.literals.length; i++) {
    if (scan.literals[i].class === LiteralGoverned) {
      scan.governedIndex = i;
      break;
    }
  }
  return scan;
}

// stmtScanSpan is a half-open range of a numeric literal in the statement.
interface StmtScanSpan {
  start: number;
  end: number;
}

// stmtScanFindLiterals finds every numeric literal span in the statement using
// deterministic ASCII byte-class boundaries. A literal is a maximal run that:
//   - may begin with a single '-' sign only when the sign is at a left boundary
//     (start of string or preceded by a non-alphanumeric, non-'.' byte) and is
//     immediately followed by a digit — this avoids treating hyphens inside
//     words or ranges as numeric signs;
//   - consists of ASCII digits with optional single interior grouping commas and
//     at most one decimal point;
//   - may carry a trailing exponent ('e'/'E', optional sign, one or more digits)
//     only when the mantissa contains at least one digit.
//
// The scan never consults locale, Unicode categories, or a regex engine, so this
// port reproduces identical spans (Requirement 6.1 "one cross-runtime scanner").
// Grouping commas and exponents are captured in the span so the verbatim text is
// preserved for later rewrite; ingest handles their numeric interpretation
// separately.
function stmtScanFindLiterals(statement: string): StmtScanSpan[] {
  const spans: StmtScanSpan[] = [];
  const n = statement.length;
  let i = 0;
  while (i < n) {
    const c = statement[i];

    // Candidate sign: '-' immediately before a digit, at a left boundary.
    if (
      c === "-" &&
      i + 1 < n &&
      isASCIIDigit(statement[i + 1]) &&
      stmtScanIsLeftBoundary(statement, i)
    ) {
      const read = stmtScanReadNumber(statement, i, true);
      if (read.ok) {
        spans.push(read.span);
        i = read.next;
        continue;
      }
    }

    if (isASCIIDigit(c)) {
      // A digit only starts a literal at a left boundary; a digit glued to the
      // right of a letter (e.g. the "3" in "mp3") is still scanned as a literal
      // run, but classification will mark alnum-glued runs as incidental. The
      // scanner captures the maximal digit run either way.
      const read = stmtScanReadNumber(statement, i, false);
      if (read.ok) {
        spans.push(read.span);
        i = read.next;
        continue;
      }
    }
    i++;
  }
  return spans;
}

// stmtScanIsLeftBoundary reports whether position i (the index of a candidate
// leading '-') sits at a left boundary: the start of the string, or immediately
// after a byte that is neither alphanumeric nor '.'. This keeps hyphens inside
// words ("well-known"), numeric ranges ("3-5"), and decimal continuations from
// being read as a negative sign.
function stmtScanIsLeftBoundary(statement: string, i: number): boolean {
  if (i === 0) {
    return true;
  }
  const prev = statement[i - 1];
  if (isASCIIDigit(prev) || stmtScanIsASCIILetter(prev) || prev === ".") {
    return false;
  }
  return true;
}

// stmtScanReadNumber reads a numeric literal beginning at start (which is the
// sign position when hasSign is true, otherwise the first digit). It returns the
// captured span, the index of the first byte after the literal, and ok=true when
// a well-formed run was read. The run grammar (ASCII-only):
//
//   [-] digits (',' digits)* [ '.' digits ] [ ('e'|'E') ['+'|'-'] digits ]
//
// A grouping comma is only consumed when it sits between two digits, so a comma
// used as punctuation ("5, 6") never extends the literal. A decimal point is
// only consumed when followed by a digit. The exponent is only consumed when it
// has at least one digit after the optional sign.
function stmtScanReadNumber(
  statement: string,
  start: number,
  hasSign: boolean,
): { span: StmtScanSpan; next: number; ok: boolean } {
  const n = statement.length;
  let i = start;
  if (hasSign) {
    i++; // skip the '-'
  }

  // Integer part: at least one digit, with interior single grouping commas.
  const digitStart = i;
  while (i < n) {
    if (isASCIIDigit(statement[i])) {
      i++;
      continue;
    }
    // Interior grouping comma: only between digits.
    if (statement[i] === "," && i + 1 < n && isASCIIDigit(statement[i + 1]) && i > digitStart) {
      i++;
      continue;
    }
    break;
  }
  if (i === digitStart) {
    return { span: { start: 0, end: 0 }, next: start, ok: false };
  }

  // Optional fraction: '.' followed by at least one digit.
  if (i < n && statement[i] === "." && i + 1 < n && isASCIIDigit(statement[i + 1])) {
    i++; // consume '.'
    while (i < n && isASCIIDigit(statement[i])) {
      i++;
    }
  }

  // Optional exponent: e/E, optional sign, at least one digit.
  if (i < n && (statement[i] === "e" || statement[i] === "E")) {
    let j = i + 1;
    if (j < n && (statement[j] === "+" || statement[j] === "-")) {
      j++;
    }
    const expDigitStart = j;
    while (j < n && isASCIIDigit(statement[j])) {
      j++;
    }
    if (j > expDigitStart) {
      i = j; // exponent is valid; extend the span
    }
  }

  return { span: { start, end: i }, next: i, ok: true };
}

// stmtScanIngestLiteral converts a verbatim statement literal to its canonical
// fixed-point value. It strips grouping commas (which are display-only and not
// part of the JSON number grammar Numeric_Ingest accepts) and then delegates to
// numericIngest so ingest semantics, rounding, and the safe envelope match the
// rest of the DDM exactly. It returns ok=false when the literal does not ingest
// cleanly.
function stmtScanIngestLiteral(text: string): [FixedPointValue, boolean] {
  const token = stmtScanStripGrouping(text);
  const diag = numericIngest(token);
  if (diag.fixedPointValue === undefined) {
    return [{ negative: false, mantissa: 0, scale: 0 }, false];
  }
  return [diag.fixedPointValue, true];
}

// stmtScanStripGrouping removes ASCII grouping commas from a numeric literal
// spelling, leaving sign, digits, decimal point, and exponent intact so the
// result is a bare JSON number token.
function stmtScanStripGrouping(text: string): string {
  if (text.indexOf(",") < 0) {
    return text;
  }
  return text.split(",").join("");
}

// stmtScanClassify assigns a governed/incidental class to every literal in
// left-to-right order using deterministic structural rules that both runtimes
// share:
//
//  1. A literal whose neighboring context marks it as part of a proper name or
//     fixed designation is INCIDENTAL. Two adjacency signals mark this:
//     (a) the literal is glued directly to a preceding alphanumeric run with no
//     separator (e.g. "mp3", "COVID19"), or
//     (b) the literal is preceded by a capitalized word and a single space and
//     is a bare integer (e.g. "Apollo 11", "World War 2", "Route 66").
//  2. Among the remaining (non-incidental) literals, the governed literal is the
//     one whose ingested value equals the presented number when such a literal
//     exists; otherwise the first non-incidental literal. Exactly one literal is
//     marked GOVERNED.
//  3. Any literal not chosen as governed and not marked incidental in step 1 is
//     left INCIDENTAL as well, so a strict policy can still rewrite it while the
//     governed/incidental policy treats only the governed literal as the required
//     presented value. Classification never removes a literal.
//
// The classification is a best-effort structural signal, not a policy decision.
// It is deterministic and side-effect free, mutating only the class field of the
// provided array.
function stmtScanClassify(
  statement: string,
  literals: StatementLiteral[],
  presented: FixedPointValue,
): void {
  if (literals.length === 0) {
    return;
  }

  // Step 1: mark structurally-incidental literals (proper-name embedded).
  const incidental: boolean[] = new Array(literals.length);
  for (let idx = 0; idx < literals.length; idx++) {
    incidental[idx] = stmtScanIsIncidental(statement, literals[idx]);
    literals[idx].class = LiteralIncidental;
  }

  // Step 2: choose the governed literal among non-incidental literals.
  let governed = -1;
  // Prefer a non-incidental literal whose value equals the presented number.
  for (let idx = 0; idx < literals.length; idx++) {
    if (incidental[idx] || literals[idx].value === undefined) {
      continue;
    }
    const [cmp, ok] = compareFixed(literals[idx].value as FixedPointValue, presented);
    if (ok && cmp === 0) {
      governed = idx;
      break;
    }
  }
  // Otherwise the first non-incidental literal governs.
  if (governed === -1) {
    for (let idx = 0; idx < literals.length; idx++) {
      if (!incidental[idx]) {
        governed = idx;
        break;
      }
    }
  }
  // Otherwise (every literal is proper-name incidental) fall back to a value
  // match against presented even among incidental literals, then to the first
  // literal, so there is always a governed anchor for a rewrite.
  if (governed === -1) {
    for (let idx = 0; idx < literals.length; idx++) {
      if (literals[idx].value === undefined) {
        continue;
      }
      const [cmp, ok] = compareFixed(literals[idx].value as FixedPointValue, presented);
      if (ok && cmp === 0) {
        governed = idx;
        break;
      }
    }
  }
  if (governed === -1) {
    governed = 0;
  }
  literals[governed].class = LiteralGoverned;
}

// stmtScanIsIncidental reports whether a literal is part of a proper name or
// fixed designation, using deterministic ASCII adjacency signals:
//
//   - glued: the byte immediately before the literal is an ASCII letter (e.g.
//     "mp3", "H2O", "COVID19"); such a run is never the sentence's governed
//     quantity.
//   - designation: the literal is a bare unsigned integer preceded by exactly one
//     space and a capitalized alphabetic word (e.g. "Apollo 11", "Route 66",
//     "World War 2"). A lowercase preceding word ("about 11") does not designate
//     a proper name.
//
// Both signals are text-structural and locale-free.
function stmtScanIsIncidental(statement: string, lit: StatementLiteral): boolean {
  // Glued to a preceding letter run (no separator).
  if (lit.start > 0) {
    const prev = statement[lit.start - 1];
    if (stmtScanIsASCIILetter(prev)) {
      return true;
    }
  }

  // Capitalized-word designation: "<Capitalized> <integer>".
  if (lit.start >= 2 && statement[lit.start - 1] === " ") {
    // The literal must be a bare unsigned integer (no sign, comma, dot, exp) to
    // read as a designation index.
    if (!stmtScanIsBareInteger(lit.text)) {
      return false;
    }
    // Find the word immediately before the single space.
    const wordEnd = lit.start - 1; // index of the space
    let wordStart = wordEnd;
    while (wordStart > 0 && stmtScanIsASCIILetter(statement[wordStart - 1])) {
      wordStart--;
    }
    if (wordStart < wordEnd && stmtScanIsASCIIUpper(statement[wordStart])) {
      return true;
    }
  }
  return false;
}

// stmtScanIsBareInteger reports whether text is a run of ASCII digits with no
// sign, comma, decimal point, or exponent.
function stmtScanIsBareInteger(text: string): boolean {
  if (text === "") {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (!isASCIIDigit(text[i])) {
      return false;
    }
  }
  return true;
}

// stmtScanIsASCIILetter reports whether the single-character string b is an ASCII
// letter.
function stmtScanIsASCIILetter(b: string): boolean {
  return (b >= "a" && b <= "z") || (b >= "A" && b <= "Z");
}

// stmtScanIsASCIIUpper reports whether the single-character string b is an ASCII
// uppercase letter.
function stmtScanIsASCIIUpper(b: string): boolean {
  return b >= "A" && b <= "Z";
}

// ===========================================================================
// Statement Gate inflection and grammar correction
// (port of agent-go/derivation_statement_inflect.go, task 7.2)
// ===========================================================================

// --- Parsed shape of the generated statement_inflection block ----------------

// StmtInflectRule is one ordered default pluralization rule. Only the shapes
// present in the generated table are interpreted:
//
//   { suffix_any:[...], append:"es" }               — append when the base ends in any suffix
//   { suffix_regex:"...", replace_suffix, with }     — replace a matched suffix
//   { append:"s" }                                   — unconditional default
interface StmtInflectRule {
  id: string;
  order: number;
  append?: string;
  suffix_any?: readonly string[];
  suffix_regex?: string;
  replace_suffix?: string;
  with?: string;
}

// stmtInflectTables is the subset of UNIT_TABLES this module consumes.
interface StmtInflectTables {
  default_pluralization_rules: readonly StmtInflectRule[];
  // Invariant nouns have identical singular and plural forms.
  invariant: readonly string[];
  // Irregular maps a canonical (lowercase) singular to its plural.
  irregular: Record<string, string>;
  // singular_value is the exact governed value that is singular (1).
  singular_value: number;
}

// stmtInflectParsed is the generated statement_inflection block, read once from
// the constant generated payload. The generated bytes are constant, so the
// derived lookups below are built once at module load and are pure.
const stmtInflectParsed: StmtInflectTables = (
  UNIT_TABLES as unknown as { statement_inflection: StmtInflectTables }
).statement_inflection;

// stmtInflectRulesSorted are the default pluralization rules sorted by their
// `order` field so evaluation is deterministic regardless of the JSON authoring
// order (mirrors Go's sort.SliceStable by Order).
const stmtInflectRulesSorted: readonly StmtInflectRule[] = [
  ...stmtInflectParsed.default_pluralization_rules,
].sort((a, b) => a.order - b.order);

// stmtInflectRuleRE holds compiled suffix regexes, keyed by rule id. The regexes
// are authored ASCII character-class patterns from the generated table (e.g.
// "[bcdfghjklmnpqrstvwxz]y$"); they never touch numeric magnitudes, so they are
// permitted here exactly as the Go reference compiles regexp.Compile.
const stmtInflectRuleRE: Map<string, RegExp> = (() => {
  const m = new Map<string, RegExp>();
  for (const r of stmtInflectRulesSorted) {
    if (r.suffix_regex !== undefined && r.suffix_regex !== "") {
      m.set(r.id, new RegExp(r.suffix_regex));
    }
  }
  return m;
})();

// stmtInflectInvariantSet is a fast membership set for the invariant nouns
// (canonical lowercase).
const stmtInflectInvariantSet: Set<string> = new Set(stmtInflectParsed.invariant);

// stmtInflectPluralToSingular is the reverse of the irregular map: canonical
// plural -> canonical singular. First writer wins on the (rare) chance of
// duplicate plurals; the generator's distinct_singular_keys constraint keeps
// singular keys unique, so this is deterministic in practice.
const stmtInflectPluralToSingular: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [singular, plural] of Object.entries(stmtInflectParsed.irregular)) {
    if (!m.has(plural)) {
      m.set(plural, singular);
    }
  }
  return m;
})();

// stmtInflectSingularValue returns the generated singular value (defaults to 1 if
// the table did not populate it).
function stmtInflectSingularValue(): number {
  if (!stmtInflectParsed || stmtInflectParsed.singular_value === 0) {
    return 1;
  }
  return stmtInflectParsed.singular_value;
}

// stmtInflectValueIsSingular reports whether the governed value is singular:
// exactly equal to the generated singular value (1). Every other finite value —
// including 0 and negative values — is plural (Requirements 6.3, 6.4).
export function stmtInflectValueIsSingular(v: FixedPointValue): boolean {
  const singular: FixedPointValue = { negative: false, mantissa: stmtInflectSingularValue(), scale: 0 };
  const [cmp, ok] = compareFixed(v, singular);
  if (!ok) {
    return false;
  }
  return cmp === 0;
}

// --- Capitalization preservation ---------------------------------------------

// StmtInflectCasePattern describes the surface capitalization of a noun so the
// corrected form can reproduce it.
const enum StmtInflectCasePattern {
  // Lower: no ASCII letters are uppercase (e.g. "dogs", "años").
  Lower = 0,
  // Title: exactly the first ASCII letter is uppercase (e.g. "Dogs").
  Title = 1,
  // Upper: at least two letters and every ASCII letter is uppercase (e.g. "DOGS").
  Upper = 2,
  // Mixed: any other pattern (e.g. "iPhones", "McMuffins"). Mixed nouns are
  // re-inflected but their existing casing is left untouched.
  Mixed = 3,
}

// stmtInflectDetectCase classifies the capitalization of a word using only its
// ASCII letters. Non-ASCII letters and non-letters are ignored for the
// title/upper decision so the pattern is byte-stable across runtimes.
function stmtInflectDetectCase(word: string): StmtInflectCasePattern {
  let letters = 0;
  let upper = 0;
  let firstUpper = false;
  let firstSeen = false;
  for (const r of word) {
    if (!isRuneASCIILetter(r)) {
      continue;
    }
    letters++;
    const up = r >= "A" && r <= "Z";
    if (!firstSeen) {
      firstSeen = true;
      firstUpper = up;
    }
    if (up) {
      upper++;
    }
  }
  if (letters === 0) {
    return StmtInflectCasePattern.Lower;
  }
  if (upper === 0) {
    return StmtInflectCasePattern.Lower;
  }
  if (upper === letters && letters >= 2) {
    return StmtInflectCasePattern.Upper;
  }
  if (firstUpper && upper === 1) {
    return StmtInflectCasePattern.Title;
  }
  return StmtInflectCasePattern.Mixed;
}

// stmtInflectApplyCase reproduces the detected case pattern on the corrected
// word. For mixed patterns the corrected form is returned unchanged so we never
// mangle intentional inner capitals.
function stmtInflectApplyCase(word: string, pattern: StmtInflectCasePattern): string {
  switch (pattern) {
    case StmtInflectCasePattern.Upper:
      return asciiUpper(word);
    case StmtInflectCasePattern.Title:
      return asciiTitle(word);
    default:
      return word;
  }
}

// isRuneASCIILetter reports whether a single code point (string) is an ASCII
// letter.
function isRuneASCIILetter(r: string): boolean {
  return (r >= "a" && r <= "z") || (r >= "A" && r <= "Z");
}

// asciiUpper uppercases only ASCII letters, leaving other runes untouched.
function asciiUpper(s: string): string {
  let out = "";
  for (const r of s) {
    if (r >= "a" && r <= "z") {
      out += String.fromCharCode(r.charCodeAt(0) - 32);
    } else {
      out += r;
    }
  }
  return out;
}

// asciiLower lowercases only ASCII letters, leaving other runes untouched.
function asciiLower(s: string): string {
  let out = "";
  for (const r of s) {
    if (r >= "A" && r <= "Z") {
      out += String.fromCharCode(r.charCodeAt(0) + 32);
    } else {
      out += r;
    }
  }
  return out;
}

// asciiTitle uppercases the first ASCII letter and lowercases the remaining ASCII
// letters, leaving non-ASCII runes untouched.
function asciiTitle(s: string): string {
  let out = "";
  let seen = false;
  for (const r of s) {
    if (r >= "A" && r <= "Z") {
      if (seen) {
        out += String.fromCharCode(r.charCodeAt(0) + 32);
      } else {
        out += r;
      }
      seen = true;
    } else if (r >= "a" && r <= "z") {
      if (!seen) {
        out += String.fromCharCode(r.charCodeAt(0) - 32);
      } else {
        out += r;
      }
      seen = true;
    } else {
      out += r;
    }
  }
  return out;
}

// --- Singular base reduction and pluralization -------------------------------

// stmtInflectToSingular reduces a canonical (already-lowercased) noun to its
// singular base. Invariant nouns and unknown nouns whose plural we cannot
// confidently reverse are returned unchanged. Reduction order mirrors the
// generated table precedence in reverse:
//
//  1. invariant     — return as-is
//  2. irregular     — reverse the irregular map (plural -> singular)
//  3. default rules — reverse the generated default pluralization suffixes
function stmtInflectToSingular(canonical: string): string {
  if (canonical === "") {
    return canonical;
  }
  if (stmtInflectInvariantSet.has(canonical)) {
    return canonical;
  }
  // Already a known singular irregular (e.g. "child") — leave it.
  if (Object.prototype.hasOwnProperty.call(stmtInflectParsed.irregular, canonical)) {
    return canonical;
  }
  // Known irregular plural (e.g. "children") — reverse it.
  const singular = stmtInflectPluralToSingular.get(canonical);
  if (singular !== undefined) {
    return singular;
  }
  // Reduce regular plural endings to a fixed point. Reversal of the ambiguous
  // "-s" ending can itself yield a further-reducible form (e.g. "ases" -> "as" ->
  // "a"); iterating until the form is stable makes the singular base a true fixed
  // point of the reducer, which is what guarantees correction idempotence
  // (Requirement 6.6). The loop is bounded by the shrinking word length and
  // cannot run away.
  let prev = canonical;
  for (let i = 0; i < canonical.length; i++) {
    const next = stmtInflectReverseDefault(prev);
    if (next === prev) {
      break;
    }
    prev = next;
  }
  return prev;
}

// stmtInflectReverseDefault reverses the generated default pluralization rules to
// recover a singular base from a regular plural. The generated forward rules are
// (in order): "-s/-x/-z/-ch/-sh" + "es", consonant + "y" -> "ies", and a bare
// "+s". We reverse the most specific plural endings first so, e.g., "boxes" ->
// "box" and "cities" -> "city" while "dogs" -> "dog".
//
// Regular "-s"/"-es"/"-ies" endings are ambiguous: "bus" and "series" already end
// in "s" yet are singular. To avoid mangling a singular noun (and to guarantee
// the reduction is a fixed point, so correction is idempotent per Requirement
// 6.6), every reversal candidate is verified by re-pluralizing it: a candidate
// base is accepted only when stmtInflectToPlural(base) reproduces the original
// canonical form. Otherwise the word is treated as already singular and returned
// unchanged.
function stmtInflectReverseDefault(canonical: string): string {
  // Ordered candidate singular bases, most specific plural ending first.
  const candidates: string[] = [];

  // "-ies" (from consonant + y) -> "y". Require a consonant before "ies".
  if (canonical.endsWith("ies") && canonical.length > 3) {
    const base = canonical.slice(0, canonical.length - 3);
    if (isConsonantByte(base[base.length - 1])) {
      candidates.push(base + "y");
    }
  }
  // "-es" after a sibilant base (s/x/z/ch/sh) -> drop "es".
  if (canonical.endsWith("es") && canonical.length > 2) {
    const base = canonical.slice(0, canonical.length - 2);
    if (endsWithSibilant(base)) {
      candidates.push(base);
    }
  }
  // Regular "-s" -> drop "s" (but never reduce a bare "s").
  if (canonical.endsWith("s") && canonical.length > 1) {
    candidates.push(canonical.slice(0, canonical.length - 1));
  }

  // Accept the first candidate whose forward pluralization round-trips back to
  // the original canonical form. This rejects over-eager reductions like "bus" ->
  // "bu" (pluralizes to "buses", not "bus").
  for (const base of candidates) {
    if (base !== "" && stmtInflectToPlural(base) === canonical) {
      return base;
    }
  }
  // Already singular (or not confidently reducible).
  return canonical;
}

// stmtInflectToPlural pluralizes a canonical (already-lowercased) singular base
// using the generated tables in precedence order: invariant, irregular, then the
// ordered default pluralization rules.
function stmtInflectToPlural(canonical: string): string {
  if (canonical === "") {
    return canonical;
  }
  if (stmtInflectInvariantSet.has(canonical)) {
    return canonical;
  }
  const plural = stmtInflectParsed.irregular[canonical];
  if (plural !== undefined) {
    return plural;
  }
  for (const r of stmtInflectRulesSorted) {
    if (r.suffix_any !== undefined && r.suffix_any.length > 0) {
      if (hasAnySuffix(canonical, r.suffix_any)) {
        return canonical + (r.append ?? "");
      }
    } else if (r.suffix_regex !== undefined && r.suffix_regex !== "") {
      const re = stmtInflectRuleRE.get(r.id);
      if (re !== undefined && re.test(canonical)) {
        const base = trimSuffix(canonical, r.replace_suffix ?? "");
        return base + (r.with ?? "");
      }
    } else {
      // Unconditional default (append "s").
      return canonical + (r.append ?? "");
    }
  }
  // No rule matched (should not happen given the unconditional default).
  return canonical;
}

// --- Public correction entry points ------------------------------------------

// stmtInflectNoun corrects a single governed noun so its grammatical number
// agrees with `singular`. It preserves the surface capitalization of the input
// and is idempotent: the output only depends on the target number and the noun's
// canonical base, so re-applying with the same target is a no-op (Requirements
// 6.3, 6.4, 6.6).
export function stmtInflectNoun(noun: string, singular: boolean): string {
  if (noun.trim() === "") {
    return noun;
  }
  const pattern = stmtInflectDetectCase(noun);
  const canonical = asciiLower(noun);

  const base = stmtInflectToSingular(canonical);
  let corrected: string;
  if (singular) {
    corrected = base;
  } else {
    corrected = stmtInflectToPlural(base);
  }
  return stmtInflectApplyCase(corrected, pattern);
}

// stmtInflectNounForValue corrects a governed noun for the grammatical number
// implied by the presented value: singular exactly for the generated singular
// value (1), plural otherwise (Requirements 6.3, 6.4).
export function stmtInflectNounForValue(noun: string, presented: FixedPointValue): string {
  return stmtInflectNoun(noun, stmtInflectValueIsSingular(presented));
}

// --- Small deterministic helpers ---------------------------------------------

function isConsonantByte(b: string): boolean {
  switch (b) {
    case "a":
    case "e":
    case "i":
    case "o":
    case "u":
      return false;
  }
  return b >= "a" && b <= "z";
}

// endsWithSibilant reports whether s ends in a base that takes "-es": s, x, z, or
// the digraphs ch/sh. This mirrors the generated es_after_sibilant rule's suffix
// set so reversal and pluralization stay symmetric.
function endsWithSibilant(s: string): boolean {
  if (s.endsWith("ch") || s.endsWith("sh")) {
    return true;
  }
  if (s === "") {
    return false;
  }
  switch (s[s.length - 1]) {
    case "s":
    case "x":
    case "z":
      return true;
  }
  return false;
}

function hasAnySuffix(s: string, suffixes: readonly string[]): boolean {
  for (const suf of suffixes) {
    if (s.endsWith(suf)) {
      return true;
    }
  }
  return false;
}

// trimSuffix removes a trailing suffix from s when present, mirroring Go's
// strings.TrimSuffix (a no-op when the suffix is empty or absent).
function trimSuffix(s: string, suffix: string): string {
  if (suffix !== "" && s.endsWith(suffix)) {
    return s.slice(0, s.length - suffix.length);
  }
  return s;
}

// ===========================================================================
// Policy-parameterized Statement Gate rewrite and revalidation
// (port of agent-go/derivation_statement_gate.go, task 7.3)
// ===========================================================================

// StmtGatePolicy selects one of the implemented Requirement 6.2 statement
// policies. It is an explicit closed enum; production selection is owned by the
// isolated selector below (task 7.4), pinned to StmtGateNumberlessDrop. The
// other two values are non-production reference policies for tests and parity.
export type StmtGatePolicy = "strict" | "governed_incidental" | "numberless_drop";

// StmtGateStrict forbids every numeric literal other than presented_number.
// Non-production reference policy.
export const StmtGateStrict: StmtGatePolicy = "strict";
// StmtGateGovernedIncidental forbids truth leaks and governed mismatches but
// permits classified incidental proper-name numbers to remain.
// Non-production reference policy.
export const StmtGateGovernedIncidental: StmtGatePolicy = "governed_incidental";
// StmtGateNumberlessDrop enforces the numberless-claim contract: any scanned
// literal equal to true_number or presented_number drops the round, and no
// rewriting is attempted. This is the resolved and pinned production policy.
export const StmtGateNumberlessDrop: StmtGatePolicy = "numberless_drop";

// StmtGateResult is the complete, deterministic outcome of applying a statement
// policy to one claim. Exactly one of ok / abstain holds: when ok is true the
// rewritten, grammar-corrected, and re-validated statement is consistent under
// the policy; when ok is false the reason is AbstainStatementUnrecoverable and
// statement carries the best-effort rewritten text for diagnostics only (never
// emitted on a round).
export interface StmtGateResult {
  // ok reports whether the claim is consistent under the selected policy after
  // rewrite, grammar correction, and re-scan.
  ok: boolean;
  // statement is the rewritten claim. When ok it is the consistent text to emit;
  // when !ok it is the best-effort intermediate for diagnostics.
  statement: string;
  // reason is AbstainStatementUnrecoverable when !ok, and "" when ok.
  reason: AbstainReason | "";
  // policy echoes the policy that was applied (for deterministic diagnostics).
  policy: StmtGatePolicy;
}

// stmtGateApply runs the full Statement Gate under the selected policy:
//
//  1. scan the claim (task 7.1 scanner) for numeric literals + classification;
//  2. rewrite the numeric literals the policy requires to change so the claim
//     contains only permitted numbers, all governed occurrences equal presented
//     and no occurrence equals truth (Requirements 6.1, 6.2, 6.5);
//  3. correct singular/plural grammar of the noun governed by the presented value
//     (Requirements 6.3, 6.4, 6.6);
//  4. re-scan the rewritten statement and re-validate under the policy;
//  5. return the consistent statement or STATEMENT_UNRECOVERABLE (Req 6.7).
//
// truth and presented are the round's canonical values already produced by
// Numeric_Ingest. The function is pure and total: identical inputs always yield
// the identical StmtGateResult and the caller's inputs are never mutated.
export function stmtGateApply(
  statement: string,
  truth: FixedPointValue,
  presented: FixedPointValue,
  policy: StmtGatePolicy,
): StmtGateResult {
  // A truth value that also equals the presented value is a contradiction the
  // derivation core forbids (strict direction math guarantees presented != true).
  // If they are equal we cannot both require governed==presented and forbid
  // governed==truth, so the statement is unrecoverable regardless of policy.
  {
    const [cmp, ok] = compareFixed(truth, presented);
    if (ok && cmp === 0) {
      return stmtGateUnrecoverable(statement, policy);
    }
  }

  const scan = stmtScanStatement(statement, truth, presented);

  if (policy === StmtGateNumberlessDrop) {
    // The numberless-claim contract: the claim is the QUESTION text and must
    // carry neither the answer (truth leak) nor the anchor (a literal equal to
    // the derived presented number). Unrelated numerals are allowed and
    // nothing is rewritten — a violating round is unrecoverable so the caller
    // drops it. Word-form spellings and the model's original presented value
    // are statement-layer signals the caller (stmtGateStampStatement) checks
    // before invoking the gate.
    for (const lit of scan.literals) {
      if (lit.value === undefined) {
        continue;
      }
      if (lit.isTruthLeak) {
        return stmtGateUnrecoverable(statement, policy);
      }
      const [cmp, ok] = compareFixed(lit.value, presented);
      if (ok && cmp === 0) {
        return stmtGateUnrecoverable(statement, policy);
      }
    }
    return { ok: true, statement, reason: "", policy };
  }

  const [rewritten, ok] = stmtGateRewrite(scan, presented, policy);
  if (!ok) {
    return stmtGateUnrecoverable(rewritten, policy);
  }

  // Grammar correction: make the noun governed by the presented value agree in
  // number. This runs after numeric rewrite so the governed literal already
  // equals presented and inflection targets the correct grammatical number.
  const corrected = stmtGateCorrectGrammar(rewritten, presented);

  // Re-scan the corrected statement and re-validate under the policy. Grammar
  // correction only changes noun spelling, never numeric literals, so the literal
  // set is stable; re-scanning still guarantees the emitted text is what a
  // runtime would observe (Requirement 6.7).
  const reScan = stmtScanStatement(corrected, truth, presented);
  if (!stmtGateValidate(reScan, presented, policy)) {
    return stmtGateUnrecoverable(corrected, policy);
  }

  return { ok: true, statement: corrected, reason: "", policy };
}

// stmtGateUnrecoverable builds the deterministic abstain result.
function stmtGateUnrecoverable(statement: string, policy: StmtGatePolicy): StmtGateResult {
  return {
    ok: false,
    statement,
    reason: AbstainStatementUnrecoverable,
    policy,
  };
}

// stmtGateShouldRewrite reports whether a scanned literal must be rewritten to
// the presented value under the selected policy.
//
//   - A truth leak is ALWAYS rewritten (forbidden under both policies, Req 6.1).
//   - A governed literal is rewritten whenever its value differs from presented
//     (governed mismatch repair, both policies, Req 6.2/6.5).
//   - Under strict, EVERY other numeric literal is rewritten to presented so no
//     foreign number remains (Req 6.2 strict branch).
//   - Under governed/incidental, a non-governed, non-truth-leak literal is left
//     as-is (incidental numbers such as "Apollo 11" may remain).
//
// A literal with an undefined value (did not ingest) is never a truth leak; under
// strict it is still treated as a foreign literal and rewritten, under
// governed/incidental it is left alone unless it is the governed literal.
function stmtGateShouldRewrite(
  lit: StatementLiteral,
  presented: FixedPointValue,
  policy: StmtGatePolicy,
): boolean {
  if (lit.isTruthLeak) {
    return true;
  }
  if (lit.class === LiteralGoverned) {
    // Repair only a genuine mismatch; an already-correct governed literal is left
    // untouched so rewrite is idempotent.
    if (lit.value === undefined) {
      return true;
    }
    const [cmp, ok] = compareFixed(lit.value, presented);
    if (ok && cmp === 0) {
      return false;
    }
    return true;
  }
  // Non-governed, non-leak literal.
  if (policy === StmtGateStrict) {
    // Strict: an incidental/foreign literal already equal to presented is
    // harmless and may remain (keeps rewrite minimal and idempotent); anything
    // else is rewritten.
    if (lit.value !== undefined) {
      const [cmp, ok] = compareFixed(lit.value, presented);
      if (ok && cmp === 0) {
        return false;
      }
    }
    return true;
  }
  // governed/incidental: leave incidental literals in place.
  return false;
}

// stmtGateRewrite produces a rewritten statement in which every literal the
// policy requires to change is replaced by the canonical presented spelling.
// Replacement walks the scanned spans right-to-left so earlier byte offsets stay
// valid as later spans are spliced. It returns ok=false only when a literal that
// MUST be rewritten cannot be (which cannot currently occur, since presented is
// always representable, but the guard keeps the contract explicit and the port
// symmetric with Go).
function stmtGateRewrite(
  scan: StatementScan,
  presented: FixedPointValue,
  policy: StmtGatePolicy,
): [string, boolean] {
  const presentedText = formatFixedCanonical(presented);
  let out = scan.statement;
  // Iterate spans from last to first so splicing does not shift the offsets of
  // spans not yet processed.
  for (let i = scan.literals.length - 1; i >= 0; i--) {
    const lit = scan.literals[i];
    if (!stmtGateShouldRewrite(lit, presented, policy)) {
      continue;
    }
    if (lit.start < 0 || lit.end > out.length || lit.start > lit.end) {
      return [out, false];
    }
    out = out.slice(0, lit.start) + presentedText + out.slice(lit.end);
  }
  return [out, true];
}

// stmtGateValidate re-checks the (already-rewritten) statement against the
// policy. It reads the re-scanned literals directly: no literal may equal truth
// (both policies), every governed literal must equal presented (both policies),
// and under strict no numeric literal other than presented may remain.
function stmtGateValidate(
  scan: StatementScan,
  presented: FixedPointValue,
  policy: StmtGatePolicy,
): boolean {
  for (let i = 0; i < scan.literals.length; i++) {
    const lit = scan.literals[i];
    // No literal may be a truth leak under either policy (Req 6.1).
    if (lit.isTruthLeak) {
      return false;
    }
    let equalsPresented = false;
    if (lit.value !== undefined) {
      const [cmp, ok] = compareFixed(lit.value, presented);
      if (ok && cmp === 0) {
        equalsPresented = true;
      }
    }
    if (lit.class === LiteralGoverned) {
      // The governed literal must equal presented (Req 6.2, 6.5).
      if (!equalsPresented) {
        return false;
      }
    } else if (policy === StmtGateStrict) {
      // Strict: every remaining literal must equal presented (Req 6.2).
      if (!equalsPresented) {
        return false;
      }
    }
    // governed/incidental: an incidental literal may remain with any (non-truth)
    // value; nothing more to check.
  }
  return true;
}

// stmtGateCorrectGrammar corrects the singular/plural grammar of the noun
// governed by the presented value. It locates the governed numeric literal in the
// statement (the one whose value equals presented, preferring a standalone
// occurrence), then inflects the immediately-following word to agree with the
// presented value using the generated inflection tables (Requirements 6.3, 6.4,
// 6.6). When no governed noun can be located the statement is returned unchanged;
// grammar correction is best-effort and never fabricates text.
//
// Correction is idempotent because stmtInflectNounForValue is idempotent: the
// governed noun is reduced to its canonical base and re-inflected toward the
// grammatical number implied by presented, so re-running produces the same word.
function stmtGateCorrectGrammar(statement: string, presented: FixedPointValue): string {
  const scan = stmtScanStatement(statement, presented, presented);
  if (scan.governedIndex < 0 || scan.governedIndex >= scan.literals.length) {
    return statement;
  }
  const lit = scan.literals[scan.governedIndex];

  // Find the noun that follows the governed number: skip a single run of
  // separator bytes (spaces/tabs) after the literal, then read the following word
  // (a maximal run of ASCII letters).
  const nounStart = stmtGateSkipSeparators(statement, lit.end);
  if (nounStart >= statement.length) {
    return statement;
  }
  const nounEnd = stmtGateReadWord(statement, nounStart);
  if (nounEnd === nounStart) {
    return statement;
  }
  const noun = statement.slice(nounStart, nounEnd);
  const corrected = stmtInflectNounForValue(noun, presented);
  if (corrected === noun) {
    return statement;
  }
  return statement.slice(0, nounStart) + corrected + statement.slice(nounEnd);
}

// stmtGateSkipSeparators returns the index of the first non-separator byte at or
// after i. Separators are the ASCII space and tab; a single separator run between
// the number and its noun is expected ("3 dogs"). Punctuation ends the scan so we
// never inflect across a comma or period.
function stmtGateSkipSeparators(statement: string, i: number): number {
  while (i < statement.length) {
    const c = statement[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    break;
  }
  return i;
}

// stmtGateReadWord returns the end index of a maximal run of ASCII letters
// starting at i (or i itself when the byte at i is not a letter).
function stmtGateReadWord(statement: string, i: number): number {
  while (i < statement.length && stmtGateIsASCIILetter(statement[i])) {
    i++;
  }
  return i;
}

// stmtGateIsASCIILetter reports whether the single-character string b is an ASCII
// letter.
function stmtGateIsASCIILetter(b: string): boolean {
  return (b >= "a" && b <= "z") || (b >= "A" && b <= "Z");
}

// stmtGateContainsValue is a small deterministic helper used by tests and future
// callers to report whether any scanned literal in statement ingests to value v
// (using the exact kernel). It never allocates beyond the scan itself.
export function stmtGateContainsValue(statement: string, v: FixedPointValue): boolean {
  const scan = stmtScanStatement(statement, v, v);
  for (let i = 0; i < scan.literals.length; i++) {
    const lit = scan.literals[i];
    if (lit.value === undefined) {
      continue;
    }
    const [cmp, ok] = compareFixed(lit.value, v);
    if (ok && cmp === 0) {
      return true;
    }
  }
  return false;
}

// stmtGateValidPolicy reports whether p is one of the three implemented
// policies. It is used by callers/tests to reject an unset or unknown selector;
// it does NOT pick a default (production selection is owned by
// stmtProdPolicySelector).
export function stmtGateValidPolicy(p: StmtGatePolicy | string): boolean {
  return p === StmtGateStrict || p === StmtGateGovernedIncidental || p === StmtGateNumberlessDrop;
}

// ===========================================================================
// Production-policy selector and guard
// (port of agent-go/derivation_statement_policy.go, task 7.4)
// ===========================================================================
//
// Task 7.3 implemented the two coherent Requirement 6.2 rewrite policies
// (StmtGateStrict, StmtGateGovernedIncidental) behind one explicit selector; the
// production policy is RESOLVED and PINNED to StmtGateNumberlessDrop (the
// numberless-claim contract). This section owns the ISOLATED PRODUCTION selector
// and the fail-closed guard that trips if the selector is bound to anything
// other than the pinned policy.
//
// The contract (design "Statement Consistency Gate" / "Open Requirement
// Decision"; tasks Overview):
//
//   - The production selector is a single isolated value, RESOLVED and PINNED
//     to StmtGateNumberlessDrop: the generation prompt defines claim_statement
//     as the NUMBERLESS question text, so production enforces that contract
//     directly (drop on truth/presented literal, never rewrite). The rewrite
//     policies remain implemented as NON-PRODUCTION reference machinery for
//     direct injection, property tests, and parity fixtures.
//   - Tests may inject ANY implemented policy directly into stmtGateApply (as
//     the gate tests do); this guard never blocks that injection. It only
//     governs the PRODUCTION cutover.
//   - Any production cutover / check code path calls stmtProdPolicyCheck (or the
//     resolver stmtProdPolicyResolve) and FAILS CLOSED if the selector is
//     anything other than StmtGateNumberlessDrop, so the Statement Gate cannot
//     silently lose (or silently swap) its production policy
//     (Requirements 6.7, 8.10).
//
// Selecting a rewrite policy would contradict the prompt's numberless-claim
// contract. Should a future product change adopt declarative claims that carry
// the presented number, that change must update stmtProdPolicySelector AND the
// pinned CI guard (scripts/assert_statement_policy_resolved.mjs) together.

// StmtGateUnresolvedPolicy is the sentinel value marking the production
// selector UNRESOLVED. It is intentionally distinct from every implemented
// StmtGatePolicy so stmtGateValidPolicy rejects it and no code can mistake it
// for a real policy or a default. It remains as the fail-closed state the
// resolver and CI guard reject; production does not select it.
export const StmtGateUnresolvedPolicy = "UNRESOLVED";

// stmtProdPolicySelector is the single, isolated production policy selector.
//
// It is RESOLVED and PINNED to StmtGateNumberlessDrop: the numberless-claim
// contract the generation prompt defines. The previously unresolved
// Requirement 6.2 choice between the two rewrite policies is superseded —
// under a numberless claim there is no governed literal to repair, so
// enforcement is drop-only. Unit tests in all three runtimes and the CI guard
// pin this value.
const stmtProdPolicySelector: StmtGatePolicy | string = StmtGateNumberlessDrop;

// stmtProdPolicyUnresolvedMessage names the exact, reviewable change required so
// the fail-closed guard is actionable rather than mysterious. It mirrors the Go
// reference's ErrStmtProdPolicyUnresolved message.
export const stmtProdPolicyUnresolvedMessage =
  "statement gate production policy must be StmtGateNumberlessDrop: " +
  "restore stmtProdPolicySelector or change the pin deliberately " +
  "alongside scripts/assert_statement_policy_resolved.mjs";

// StmtProdPolicyUnresolvedError is the error type the production guard returns
// whenever the isolated selector is not bound to the pinned
// StmtGateNumberlessDrop. Callers can identify it with `err instanceof
// StmtProdPolicyUnresolvedError` (mirrors errors.Is against the Go sentinel).
export class StmtProdPolicyUnresolvedError extends Error {
  constructor() {
    super(stmtProdPolicyUnresolvedMessage);
    this.name = "StmtProdPolicyUnresolvedError";
  }
}

// stmtProdPolicyIsResolved reports whether the isolated production selector is
// bound to the pinned production policy (StmtGateNumberlessDrop). It is false
// for the UNRESOLVED sentinel, either rewrite policy, or any other value. This
// is the single predicate the cutover and CI guards consult; it never picks a
// default.
export function stmtProdPolicyIsResolved(): boolean {
  return stmtProdPolicySelector === StmtGateNumberlessDrop;
}

// stmtProdPolicyResolve returns the production Statement Gate policy for use by a
// production cutover path. Unless the selector is bound to the pinned
// StmtGateNumberlessDrop it FAILS CLOSED: it returns the unresolved sentinel,
// ok=false, and a StmtProdPolicyUnresolvedError. When the selector is pinned it
// returns StmtGateNumberlessDrop with ok=true and a null error.
//
// Production callers MUST treat ok=false as "do not activate the Statement Gate"
// and surface the error; they must not fall back to a default policy.
export function stmtProdPolicyResolve(): {
  policy: StmtGatePolicy | string;
  ok: boolean;
  err: StmtProdPolicyUnresolvedError | null;
} {
  if (!stmtProdPolicyIsResolved()) {
    return { policy: StmtGateUnresolvedPolicy, ok: false, err: new StmtProdPolicyUnresolvedError() };
  }
  return { policy: stmtProdPolicySelector, ok: true, err: null };
}

// stmtProdPolicyCheck is the fail-closed check invoked by the production
// cutover/check command. It returns null only when the isolated selector is
// bound to the pinned StmtGateNumberlessDrop, and a
// StmtProdPolicyUnresolvedError otherwise. A cutover/check command that treats
// a non-null error as a hard failure will therefore refuse to release the
// Statement Gate under any other selection (Requirements 6.7, 8.10). Tests that
// inject a policy directly into stmtGateApply do NOT call this and are
// unaffected.
export function stmtProdPolicyCheck(): StmtProdPolicyUnresolvedError | null {
  const { ok, err } = stmtProdPolicyResolve();
  if (!ok) {
    return err;
  }
  return null;
}
