/**
 * OIDC client for the Go Gemini pack factory (`agent-go` on Cloud Run).
 *
 * Browser never talks to Cloud Run. Ops server functions mint an ID token
 * (same pattern as the game Worker `src/goagent.ts`) and POST /pack.
 * Admin drafts send X-Mol-Pack-Budget: admin so Cloud Run uses the long
 * 15-round budget without raising the live-game 35s timeout.
 */
import { getOidcIdToken } from "../firebase/credentials.server";
import { DAILY_BLITZ_ROUNDS, mapPackRounds, type EditableRound } from "./daily-blitz";
import { isAbortError, responseSnippet } from "./http";

const ADMIN_PACK_TIMEOUT_MS = 170_000;
const ADMIN_PACK_BUDGET_HEADER = "X-Mol-Pack-Budget";

function agentBaseUrl(): string {
  const raw = (process.env["GO_AGENT_URL"] ?? "").trim().replace(/\/+$/, "");
  if (!raw) {
    throw new Error(
      "GO_AGENT_URL is not configured on the ops Worker. Set it to the Cloud Run agent-go URL.",
    );
  }
  return raw;
}

function goAgentAccountJson(): string | undefined {
  const dedicated = process.env["GO_AGENT_SERVICE_ACCOUNT_JSON"]?.trim();
  if (dedicated) return dedicated;
  return undefined;
}

export function goAgentConfigured(): boolean {
  return Boolean((process.env["GO_AGENT_URL"] ?? "").trim());
}

export interface GoPackRequest {
  topic: string;
  numRounds?: number;
  guidance?: string;
  excludeAngles?: string[];
  difficulty?: "casual" | "medium" | "hard";
}

export interface GoPackResult {
  category: string;
  status_message: string;
  is_valid: boolean;
  rounds: EditableRound[];
}

export async function generatePackViaGoAgent(input: GoPackRequest): Promise<GoPackResult> {
  const topic = input.topic.trim();
  if (!topic) throw new Error("Topic is required for a Go agent draft.");

  const numRounds = Math.min(DAILY_BLITZ_ROUNDS, Math.max(1, input.numRounds ?? DAILY_BLITZ_ROUNDS));
  const baseUrl = agentBaseUrl();
  const idToken = await getOidcIdToken(baseUrl, goAgentAccountJson());

  const body: Record<string, unknown> = {
    topic,
    content_rating: "standard",
    difficulty: input.difficulty ?? "casual",
    num_rounds: numRounds,
    exclude_angles: input.excludeAngles ?? [],
  };
  const guidance = input.guidance?.trim();
  if (guidance) body.guidance = guidance;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/pack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
        [ADMIN_PACK_BUDGET_HEADER]: "admin",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ADMIN_PACK_TIMEOUT_MS),
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(`Go agent /pack timed out after ${ADMIN_PACK_TIMEOUT_MS}ms`);
    }
    throw err;
  }

  if (!response.ok) {
    const detail = await responseSnippet(response, 300);
    throw new Error(`Go agent /pack failed (${response.status}): ${detail}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error("Go agent /pack returned invalid JSON");
  }
  const roundsRaw = Array.isArray(raw.rounds) ? raw.rounds : [];
  const rounds = mapPackRounds(roundsRaw, topic);
  const isValid = raw.is_valid !== false && rounds.length > 0;
  const status =
    typeof raw.status_message === "string" && raw.status_message.trim()
      ? raw.status_message.trim()
      : isValid
        ? `Drafted ${rounds.length} DDM-gated rounds.`
        : "Go agent returned an empty or invalid pack.";

  if (!isValid) {
    throw new Error(status);
  }

  return {
    category: typeof raw.category === "string" && raw.category.trim() ? raw.category : topic,
    status_message: status,
    is_valid: true,
    rounds,
  };
}
