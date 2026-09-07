import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Card, CardTitle } from "@/index";
import { ErrorNote } from "@/admin/AdminShell";
import { chatDailyBlitz } from "@/lib/admin/ops.functions";
import type { ChatCard, ChatMessage, EditableRound } from "@/lib/admin/daily-blitz";

export function DailyBlitzChat({
  date,
  topic,
  brief,
  rounds,
  unfilledDates,
  onApplyPack,
  onApplyRound,
}: {
  date: string;
  topic: string;
  brief: string;
  rounds: EditableRound[];
  unfilledDates: string[];
  onApplyPack: (rounds: EditableRound[], topic?: string) => void;
  onApplyRound: (index: number, round: EditableRound) => void;
}) {
  const chat = useServerFn(chatDailyBlitz);
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({});
  const [input, setInput] = useState("");
  const messages = threads[date] ?? [];

  useEffect(() => {
    setInput("");
  }, [date]);

  const mutation = useMutation({
    mutationFn: (next: ChatMessage[]) =>
      chat({
        data: {
          date,
          topic,
          brief,
          rounds,
          unfilledDates,
          messages: next.map(({ role, text }) => ({ role, text })),
        },
      }),
    onSuccess: (res, next) => {
      setThreads((prev) => ({
        ...prev,
        [date]: [
          ...next,
          {
            role: "assistant",
            text: res.text,
            cards: res.cards,
          },
        ],
      }));
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || mutation.isPending) return;
    const next: ChatMessage[] = [...messages, { role: "user", text }];
    setThreads((prev) => ({ ...prev, [date]: next }));
    setInput("");
    mutation.mutate(next);
  };

  const applyCard = (card: ChatCard) => {
    if (card.applyKind === "pack" && card.rounds?.length) {
      onApplyPack(card.rounds, card.topic);
      return;
    }
    if (card.applyKind === "round" && card.round) {
      const index = card.roundIndex ?? Math.max(0, (card.round.round_number || 1) - 1);
      onApplyRound(index, card.round);
    }
  };

  return (
    <Card className="daily-blitz-chat-card">
      <div className="admin-page-head">
        <div>
          <CardTitle>Strategist</CardTitle>
          <p className="daily-blitz-chat-sub">
            Gemini plans. Go writes packs. You click Apply, then Save. Thread for {date}.
          </p>
        </div>
        <Badge tone={unfilledDates.length ? "amber" : "lime"}>
          {unfilledDates.length ? `${unfilledDates.length} unfilled` : "Strip filled"}
        </Badge>
      </div>

      <div className="daily-blitz-chat-log">
        {messages.length === 0 ? (
          <p className="admin-empty" style={{ padding: "12px 0" }}>
            Ask for a 15-round Sports mix, a swap, or which of the next two weeks are still on the
            Sports bank cycle.
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
                {card.applyKind === "pack" || card.applyKind === "round" ? (
                  <Button size="sm" type="button" onClick={() => applyCard(card)}>
                    Apply to editor
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ))}
        {mutation.isPending ? (
          <p className="daily-blitz-chat-pending">
            Working. A 15-round grounded draft can take a couple of minutes.
          </p>
        ) : null}
      </div>

      <ErrorNote error={mutation.error} />

      <form onSubmit={handleSubmit} className="daily-blitz-chat-form">
        <textarea
          className="admin-textarea"
          rows={3}
          value={input}
          placeholder="e.g. Draft a 15-round NBA mix, avoid Super Bowl, then flag empty dates."
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
        />
        <Button type="submit" disabled={mutation.isPending || !input.trim()}>
          {mutation.isPending ? "Thinking…" : "Send"}
        </Button>
      </form>
    </Card>
  );
}
