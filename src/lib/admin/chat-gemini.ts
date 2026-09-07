/**
 * Gemini 3.8 Flash Vertex backend for ops chat.
 *
 * Preserves thoughtSignature by echoing raw model parts back into contents.
 */
import { getAccessToken } from "../firebase/credentials.server";
import {
  functionCalls,
  visibleText,
  type ChatBackend,
  type ChatCompleteResult,
  type ChatContent,
  type ChatToolDeclaration,
} from "./chat-backend";
import { isAbortError, responseSnippet, asJsonObject } from "./http";

const MODEL_ID = "gemini-3.8-flash";

function projectId(): string {
  return (
    process.env["GOOGLE_CLOUD_PROJECT"]?.trim() ||
    process.env["FIREBASE_PROJECT_ID"]?.trim() ||
    "more-or-less-505908"
  );
}

function vertexUrl(): string {
  const loc = (process.env["VERTEX_LOCATION"] ?? "global").trim() || "global";
  return `https://aiplatform.googleapis.com/v1/projects/${projectId()}/locations/${loc}/publishers/google/models/${MODEL_ID}:generateContent`;
}

function geminiTools(tools: ChatToolDeclaration[]) {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ];
}

async function generateContent(
  contents: ChatContent[],
  system: string,
  tools: ChatToolDeclaration[],
): Promise<ChatContent> {
  const token = await getAccessToken(["https://www.googleapis.com/auth/cloud-platform"]);
  let response: Response;
  try {
    response = await fetch(vertexUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { role: "system", parts: [{ text: system }] },
        contents,
        tools: geminiTools(tools),
        generationConfig: {
          temperature: 0.4,
          thinkingConfig: { thinkingLevel: "LOW" },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error("Gemini chat timed out.");
    }
    throw err;
  }
  if (!response.ok) {
    const detail = await responseSnippet(response, 400);
    throw new Error(
      `Gemini chat failed (${response.status}): ${detail}. Grant the ops service account roles/aiplatform.user on ${projectId()} if this is 403.`,
    );
  }
  let payload: {
    candidates?: Array<{ content?: ChatContent }>;
    error?: { message?: string };
  };
  try {
    const parsed = asJsonObject(await response.json());
    if (!parsed) throw new Error("not an object");
    payload = parsed;
  } catch {
    throw new Error("Gemini chat returned invalid JSON.");
  }
  const content = payload.candidates?.[0]?.content;
  if (!content?.parts?.length) {
    throw new Error(payload.error?.message || "Gemini returned no content.");
  }
  return { role: content.role === "user" ? "user" : "model", parts: content.parts };
}

export const geminiChatBackend: ChatBackend = {
  id: "gemini",
  async complete(input): Promise<ChatCompleteResult> {
    const assistantMessage = await generateContent(input.contents, input.system, input.tools);
    return {
      text: visibleText(assistantMessage.parts),
      toolCalls: functionCalls(assistantMessage.parts),
      assistantMessage,
    };
  },
};
