/**
 * Whole-suite wall-clock budget (Requirement 6.11).
 *
 * Vitest has no built-in "entire run must finish within N ms" option, so the
 * budget is enforced here: `globalSetup` starts the clock and its returned
 * teardown throws when the run overran, which fails `vitest run` with a
 * non-zero exit even though every individual test passed.
 *
 * Per-test timeout (10 s) is a plain Vitest option, see `vitest.config.ts`.
 */

/** Whole-suite budget in milliseconds. */
export const SUITE_BUDGET_MS = 120_000;

export default function setup(): () => void {
  const startedAt = Date.now();

  return function teardown(): void {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > SUITE_BUDGET_MS) {
      throw new Error(
        `Test suite budget exceeded: the run took ${(elapsedMs / 1000).toFixed(1)}s, ` +
          `budget is ${(SUITE_BUDGET_MS / 1000).toFixed(0)}s (Requirement 6.11).`,
      );
    }
  };
}
