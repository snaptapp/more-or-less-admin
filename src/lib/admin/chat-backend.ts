/**
 * Provider-agnostic chat backend for ops strategists.
 *
 * The tool loop lives in ops (`runChatLoop`). Backends only implement one
 * model turn: system + history + tools -> text and/or tool calls.
 * Selected by OPS_CHAT_BACKEND: gemini (default) | adk.
 *
 * Go stays POST /pack. Do not add /ops/chat on agent-go.
 */
export interface ChatToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface ChatContent {
  role: "user" | "model";
  parts: ChatPart[];
}

export interface ChatCompleteInput {
  system: string;
  tools: ChatToolDeclaration[];
  contents: ChatContent[];
}

export interface ChatCompleteResult {
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Opaque assistant turn to echo back (Gemini thoughtSignature / raw parts). */
  assistantMessage: ChatContent;
}

export interface ChatBackend {
  id: "gemini" | "adk";
  complete(input: ChatCompleteInput): Promise<ChatCompleteResult>;
}

/**
 * Selects the configured chat backend identifier.
 *
 * @returns `adk` when `OPS_CHAT_BACKEND` is set to `adk`, `gemini` otherwise.
 */
export function selectedChatBackendId(): "gemini" | "adk" {
  const raw = (process.env["OPS_CHAT_BACKEND"] ?? "gemini").trim().toLowerCase();
  return raw === "adk" ? "adk" : "gemini";
}

/**
 * Selects and loads the configured chat backend.
 *
 * @returns The selected chat backend implementation.
 */
export async function selectChatBackend(): Promise<ChatBackend> {
  if (selectedChatBackendId() === "adk") {
    const { adkChatBackend } = await import("./chat-adk");
    return adkChatBackend;
  }
  const { geminiChatBackend } = await import("./chat-gemini");
  return geminiChatBackend;
}

/**
 * Normalizes a value into a JSON-safe record.
 *
 * @param value - The value to normalize
 * @returns The value when it is a non-array object; otherwise, a record containing the value under the `value` key
 */
export function jsonSafe(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value: value as unknown };
}

/**
 * Extracts visible text from chat parts and joins the non-empty segments with newlines.
 *
 * @param parts - The chat parts to process
 * @returns The combined visible text, or an empty string when no visible text exists
 */
export function visibleText(parts: ChatPart[]): string {
  return parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Extracts named function calls from chat parts.
 *
 * @param parts - The chat parts to inspect
 * @returns The function calls with their names and arguments
 */
export function functionCalls(
  parts: ChatPart[],
): Array<{ name: string; args: Record<string, unknown> }> {
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const part of parts) {
    const name = part.functionCall?.name?.trim();
    if (!name) continue;
    out.push({ name, args: part.functionCall?.args ?? {} });
  }
  return out;
}

/**
 * Converts recent chat messages into model content entries.
 *
 * @param messages - User and assistant messages to convert; only the last 12 messages starting with the first user message are included
 * @param fallbackUser - User message used when no messages are available
 * @returns Chat contents with assistant messages represented as model entries
 */
export function historyToContents(
  messages: Array<{ role: "user" | "assistant"; text: string }>,
  fallbackUser: string,
): ChatContent[] {
  const contents: ChatContent[] = [];
  const trimmed = messages.slice(-12);
  // Find first user message to ensure history starts with user role
  const firstUserIndex = trimmed.findIndex((m) => m.role === "user");
  const validMessages = firstUserIndex >= 0 ? trimmed.slice(firstUserIndex) : trimmed;
  
  for (const msg of validMessages) {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.text }],
    });
  }
  if (!contents.length) {
    contents.push({ role: "user", parts: [{ text: fallbackUser }] });
  }
  return contents;
}
