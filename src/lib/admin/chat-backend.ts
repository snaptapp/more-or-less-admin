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

export function selectedChatBackendId(): "gemini" | "adk" {
  const raw = (process.env["OPS_CHAT_BACKEND"] ?? "gemini").trim().toLowerCase();
  return raw === "adk" ? "adk" : "gemini";
}

export async function selectChatBackend(): Promise<ChatBackend> {
  if (selectedChatBackendId() === "adk") {
    const { adkChatBackend } = await import("./chat-adk");
    return adkChatBackend;
  }
  const { geminiChatBackend } = await import("./chat-gemini");
  return geminiChatBackend;
}

export function jsonSafe(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value: value as unknown };
}

export function visibleText(parts: ChatPart[]): string {
  return parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

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
