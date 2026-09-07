import { useState, type FormEvent, type ReactNode } from "react";
import { Button, Card, CardTitle } from "@/index";
import { ErrorNote } from "@/admin/AdminShell";
import type { ChatCard, ChatMessage } from "@/lib/admin/daily-blitz";

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
}) {
  const [input, setInput] = useState("");

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || pending) return;
    setInput("");
    onSend(text);
  };

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
        <textarea
          className="admin-textarea"
          rows={3}
          value={input}
          placeholder={placeholder}
          onChange={(e) => setInput(e.target.value)}
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
