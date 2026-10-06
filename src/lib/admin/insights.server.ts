/** Placement insights: asks Gemini (Vertex) to summarize pasted click counts. Read-only. */
import { getAccessToken } from "../firebase/credentials.server";
import { isAbortError, responseSnippet } from "./http";

export type PlacementRow = { event: string; location: string; count: number };

const MODEL_ID = "gemini-3.8-flash";

const SYSTEM =
  "You analyse click analytics for Snaptapp, an independent game studio website whose main goal is sending visitors to play More or Less. Be concise and specific. Use only the numbers given; never invent data. Output plain markdown under 300 words with three sections: 'Trends', 'Weakest placements', 'Recommendations' (3-5 numbered, actionable items naming the placement).";

export async function summarizePlacements(input: {
  startDate: string;
  endDate: string;
  rows: PlacementRow[];
  notes?: string | undefined;
}): Promise<string> {
  const id = process.env["GOOGLE_CLOUD_PROJECT"]?.trim() || process.env["FIREBASE_PROJECT_ID"]?.trim();
  if (!id) throw new Error("GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID must be configured");
  const loc = (process.env["VERTEX_LOCATION"] ?? "global").trim() || "global";
  const url = `https://aiplatform.googleapis.com/v1/projects/${id}/locations/${loc}/publishers/google/models/${MODEL_ID}:generateContent`;
  const token = await getAccessToken(["https://www.googleapis.com/auth/cloud-platform"]);

  const table = input.rows.map((r) => `${r.event} | ${r.location} | ${r.count}`).join("\n");
  const prompt = `Date range: ${input.startDate} to ${input.endDate}\n\nevent | location | clicks\n${table}${
    input.notes ? `\n\nAdmin notes: ${input.notes}` : ""
  }`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { role: "system", parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (isAbortError(err)) throw new Error("Insights request timed out.");
    throw err;
  }
  if (response.status === 429) throw new Error("AI is busy right now — try again in a minute.");
  if (!response.ok) throw new Error(`Insights request failed (${response.status}): ${await responseSnippet(response, 300)}`);
  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  };
  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();
  if (!text) throw new Error("AI returned an empty summary.");
  return text;
}
