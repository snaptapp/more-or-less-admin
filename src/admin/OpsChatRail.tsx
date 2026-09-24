import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { Button, Card, CardTitle } from "@/index";
import { ErrorNote } from "@/admin/AdminShell";
import type { ChatCard, ChatMessage, PromptSuggestion } from "@/lib/admin/daily-blitz";

/**
 * Renders a chat interface with message history, submission controls, status feedback, and actionable cards.
 *
 * @param onApplyCard - Handles applying supported cards from chat messages.
 * @returns The rendered chat interface.
 */
export function OpsChatRail({
  title = "Strategist",
  subtitle,
  emptyHint,
  placeholder,
  badge,
  messages,
  pending,
  error,
  onSend,
  onApplyCard,
  applyLabel = "Apply to editor",
  suggestions,
  onFetchSuggestions,
  isLoadingSuggestions = false,
  suggestionsError,
}: {
  title?: string;
  subtitle: string;
  emptyHint: string;
  placeholder: string;
  badge?: ReactNode;
  messages: ChatMessage[];
  pending: boolean;
  error: unknown;
  onSend: (text: string) => void;
  onApplyCard?: (card: ChatCard) => void;
  applyLabel?: string;
  suggestions?: PromptSuggestion[];
  onFetchSuggestions?: () => Promise<void> | void;
  isLoadingSuggestions?: boolean;
  suggestionsError?: string | null;
}) {
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [consumedBubbleIds, setConsumedBubbleIds] = useState<Set<string>>(() => new Set());

  const handleToggleSuggestions = () => {
    if (pending) return;
    if (!showSuggestions) {
      void Promise.resolve(onFetchSuggestions?.()).catch(() => {});
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
    }
  };

  const handleBubbleClick = (suggestion: PromptSuggestion) => {
    setInput((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed}\n\n${suggestion.prompt}` : suggestion.prompt;
    });
    setConsumedBubbleIds((prev) => new Set([...prev, suggestion.id]));
  };

  const handleInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value;
    setInput(nextValue);
    if (nextValue.trim() === "" && consumedBubbleIds.size > 0) {
      setConsumedBubbleIds(new Set());
    }
  };

  const handleSubmit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || pending) return;
    setInput("");
    setConsumedBubbleIds(new Set());
    setShowSuggestions(false);
    onSend(text);
  };

  const visibleSuggestions = (suggestions ?? []).filter((s) => !consumedBubbleIds.has(s.id));

  return (
    <Card className="daily-blitz-chat-card">
      <div className="admin-page-head">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="daily-blitz-chat-sub">{subtitle}</p>
        </div>
        {badge}
      </div>

      <div className="daily-blitz-chat-log">
        {messages.length === 0 ? (
          <p className="admin-empty" style={{ padding: "12px 0" }}>
            {emptyHint}
          </p>
        ) : null}
        {messages.map((msg, i) => (
          <div key={`${msg.role}-${i}`} className={`daily-blitz-msg daily-blitz-msg--${msg.role}`}>
            <span className="daily-blitz-msg-role">{msg.role === "user" ? "You" : "Strategist"}</span>
            <p>{msg.text}</p>
            {msg.cards?.map((card) => (
              <div key={card.id} className="daily-blitz-card">
                <strong>{card.title}</strong>
                <p>{card.summary}</p>
                {onApplyCard && (card.applyKind === "pack" || card.applyKind === "round") ? (
                  <Button size="sm" type="button" onClick={() => onApplyCard(card)}>
                    {applyLabel}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ))}
        {pending ? (
          <p className="daily-blitz-chat-pending">
            Working. A grounded Go draft can take a couple of minutes.
          </p>
        ) : null}
      </div>

      <ErrorNote error={error} />

      <form onSubmit={handleSubmit} className="daily-blitz-chat-form">
        {onFetchSuggestions || suggestions ? (
          <div className="daily-blitz-chat-suggestions-bar">
            <button
              type="button"
              disabled={pending}
              className="daily-blitz-chat-suggestions-btn"
              onClick={handleToggleSuggestions}
            >
              💡 {showSuggestions ? "Hide suggestions" : "Prompt suggestions"}
            </button>
            {showSuggestions ? (
              <div className="daily-blitz-chat-suggestions-panel">
                {isLoadingSuggestions ? (
                  <p className="daily-blitz-chat-suggestions-hint">Checking fact bank coverage…</p>
                ) : suggestionsError ? (
                  <div className="daily-blitz-chat-suggestions-error-wrap">
                    <p className="daily-blitz-chat-suggestions-error">{suggestionsError}</p>
                    {onFetchSuggestions ? (
                      <button
                        type="button"
                        className="daily-blitz-chat-suggestions-retry"
                        onClick={() => {
                          void Promise.resolve(onFetchSuggestions()).catch(() => {});
                        }}
                      >
                        Retry
                      </button>
                    ) : null}
                  </div>
                ) : visibleSuggestions.length > 0 ? (
                  <div className="daily-blitz-chat-bubbles">
                    {visibleSuggestions.map((suggestion) => (
                      <button
                        key={suggestion.id}
                        type="button"
                        className="daily-blitz-chat-bubble"
                        onClick={() => handleBubbleClick(suggestion)}
                        title={suggestion.prompt}
                      >
                        {suggestion.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="daily-blitz-chat-suggestions-hint">
                    {consumedBubbleIds.size > 0 ? "" : "No coverage gaps right now."}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        <textarea
          className="admin-textarea"
          rows={3}
          aria-label={`${title} message`}
          value={input}
          placeholder={placeholder}
          onChange={handleInputChange}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
        />
        <Button type="submit" disabled={pending || !input.trim()}>
          {pending ? "Thinking…" : "Send"}
        </Button>
      </form>
    </Card>
  );
}
