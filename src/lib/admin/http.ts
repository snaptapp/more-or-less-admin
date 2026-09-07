/** Safe error-body extraction after a failed fetch. Never throws. */
export async function responseSnippet(response: Response, max = 300): Promise<string> {
  try {
    return (await response.text()).slice(0, max);
  } catch {
    return "response body unavailable";
  }
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  return name === "TimeoutError" || name === "AbortError";
}
