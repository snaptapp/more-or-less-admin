import { useState } from "react";
import {
  AnswerButton,
  Badge,
  Button,
  Card,
  CardLabel,
  CardTitle,
  CodeInput,
  LeaderboardRow,
  NavBar,
  ProgressBar,
  ResultBanner,
  ShotClock,
  StatValue,
  TabBar,
  TierRow,
  TopicTile,
} from "../index";

const colorTokens = [
  ["--ds-arena-color-bg", "App canvas"],
  ["--ds-arena-color-surface", "Card surface"],
  ["--ds-arena-color-surface-raised", "Raised row"],
  ["--ds-arena-color-surface-sunken", "Chrome / inputs"],
  ["--ds-arena-color-border", "Hairline"],
  ["--ds-arena-color-border-strong", "Input border"],
  ["--ds-arena-color-text", "Primary text"],
  ["--ds-arena-color-text-muted", "Mono labels"],
  ["--ds-arena-color-lime", "Primary / correct"],
  ["--ds-arena-color-red", "Danger / wrong"],
  ["--ds-arena-color-purple", "Daily / featured"],
  ["--ds-arena-color-amber", "Skip / caution"],
];

const typeScale = [
  ["Display", "var(--ds-arena-font-display)", "2.5rem", "Versus Arena"],
  ["Heading", "var(--ds-arena-font-display)", "1.5rem", "Deep Sea Creatures"],
  ["Body", "var(--ds-arena-font-body)", "1rem", "Weight of an adult giraffe's heart in pounds"],
  ["Label", "var(--ds-arena-font-mono)", "0.75rem", "ROUND 3 OF 5"],
];

const section: React.CSSProperties = {
  display: "grid",
  gap: "var(--ds-arena-space-4)",
  padding: "var(--ds-arena-space-5) var(--ds-arena-space-4)",
  borderBottom: "1px solid var(--ds-arena-color-border)",
};

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="ds-display" style={{ fontSize: "var(--ds-arena-text-xl)" }}>
      {children}
    </h2>
  );
}

export function Showcase() {
  const [topic, setTopic] = useState("Space Records");
  const [tab, setTab] = useState("play");

  return (
    <div className="ds-app" style={{ maxWidth: 720, margin: "0 auto" }}>
      <NavBar
        title="Arena DS"
        leading={<Badge tone="lime">v0.1</Badge>}
        trailing={<Badge tone="purple">Draft</Badge>}
      />

      <section style={section}>
        <SectionTitle>Colors</SectionTitle>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: "var(--ds-arena-space-3)",
          }}
        >
          {colorTokens.map(([token, role]) => (
            <div key={token} style={{ display: "grid", gap: "var(--ds-arena-space-2)" }}>
              <div
                style={{
                  height: 56,
                  borderRadius: "var(--ds-arena-radius-md)",
                  background: `var(${token})`,
                  border: "1px solid var(--ds-arena-color-border)",
                }}
              />
              <code className="ds-label">{token}</code>
              <span className="ds-label" style={{ letterSpacing: 0 }}>
                {role}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section style={section}>
        <SectionTitle>Typography</SectionTitle>
        {typeScale.map(([name, family, size, sample]) => (
          <div key={name} style={{ display: "grid", gap: "var(--ds-arena-space-1)" }}>
            <span className="ds-label">
              {name} · {family} · {size}
            </span>
            <span
              style={{
                fontFamily: family,
                fontSize: size,
                textTransform: family.includes("display") ? "uppercase" : "none",
              }}
            >
              {sample}
            </span>
          </div>
        ))}
      </section>

      <section style={section}>
        <SectionTitle>Buttons</SectionTitle>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--ds-arena-space-3)" }}>
          <Button variant="primary">Play today's pack</Button>
          <Button variant="danger">Create challenge</Button>
          <Button variant="daily">Daily drop</Button>
          <Button variant="skip">Skip</Button>
          <Button variant="ghost">Copy code</Button>
          <Button variant="primary" disabled>
            Locked
          </Button>
          <Button variant="ghost" size="sm">
            Join
          </Button>
        </div>
        <Button variant="primary" size="lg">
          Next round (2/5) →
        </Button>
      </section>

      <section style={section}>
        <SectionTitle>Badges</SectionTitle>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--ds-arena-space-2)" }}>
          <Badge>5 rounds</Badge>
          <Badge tone="lime">+120 pts</Badge>
          <Badge tone="red">Endless</Badge>
          <Badge tone="purple">Daily</Badge>
          <Badge tone="amber">2 free / day</Badge>
        </div>
      </section>

      <section style={section}>
        <SectionTitle>Cards</SectionTitle>
        <Card variant="featured">
          <CardLabel>Daily global drop</CardLabel>
          <CardTitle>Deep Sea Creatures</CardTitle>
          <p style={{ color: "var(--ds-arena-color-text-muted)", marginBottom: "var(--ds-arena-space-3)" }}>
            Global 5-round showdown · 12s shot clock · One pack per day
          </p>
          <Button variant="daily" size="lg">
            Play today's pack →
          </Button>
        </Card>
        <Card>
          <CardLabel>Solo · standard</CardLabel>
          <CardTitle>Mega Roller Coasters</CardTitle>
          <p style={{ color: "var(--ds-arena-color-text-muted)" }}>
            Pick a topic. Play a fixed 5-round mixed pack.
          </p>
        </Card>
      </section>

      <section style={section}>
        <SectionTitle>Lobby inputs</SectionTitle>
        <CodeInput label="Room code" placeholder="Enter 6-char room code" maxLength={6} />
        <CodeInput
          label="Custom AI topic"
          placeholder="e.g. Tallest Roller Coasters"
        />
        <CodeInput label="Room code" defaultValue="S6HUK" error="Codes are 6 characters" />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "var(--ds-arena-space-3)",
          }}
        >
          {["Space Records", "Deadliest Animals", "Mega Roller Coasters", "Supercars & Speed"].map(
            (t) => (
              <TopicTile key={t} selected={topic === t} onClick={() => setTopic(t)}>
                {t}
              </TopicTile>
            ),
          )}
        </div>
      </section>

      <section style={section}>
        <SectionTitle>Play surface</SectionTitle>
        <ShotClock remaining={8.3} total={12} />
        <ShotClock remaining={2.1} total={12} label="Sudden death" />
        <Card>
          <p style={{ fontSize: "var(--ds-arena-text-lg)", textAlign: "center" }}>
            Weight of an adult giraffe's heart in pounds
          </p>
          <p className="ds-label" style={{ textAlign: "center", marginTop: "var(--ds-arena-space-2)" }}>
            Swipe up more · down less · right skip
          </p>
        </Card>
        <StatValue value={53} unit="pounds" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--ds-arena-space-3)" }}>
          <AnswerButton choice="more">More</AnswerButton>
          <AnswerButton choice="less">Less</AnswerButton>
        </div>
        <AnswerButton choice="skip">Skip</AnswerButton>
      </section>

      <section style={section}>
        <SectionTitle>Round result</SectionTitle>
        <ResultBanner outcome="wrong" />
        <ResultBanner outcome="correct" />
        <Card>
          <StatValue value={20} unit="inches" tone="wrong" />
          <p style={{ marginTop: "var(--ds-arena-space-3)", color: "var(--ds-arena-color-text-muted)" }}>
            A giraffe's dark prehensile tongue can extend up to 20 inches to strip leaves from
            thorny acacia trees.
          </p>
        </Card>
      </section>

      <section style={section}>
        <SectionTitle>Reward track</SectionTitle>
        <ProgressBar label="Milestones cleared" value={1} max={4} tone="lime" />
        <TierRow
          eyebrow="Tier 1 · completed"
          title="Starter Pack"
          state="completed"
          action={<Button size="lg">Collect reward</Button>}
        />
        <TierRow
          eyebrow="Tier 2 · 6/10 games"
          title="Getting Warm"
          state="active"
          value={6}
          max={10}
        />
        <TierRow eyebrow="Tier 3 · locked" title="Trivia Machine" state="locked" />
      </section>

      <section style={section}>
        <SectionTitle>Leaderboard</SectionTitle>
        <ul style={{ listStyle: "none", display: "grid", gap: "var(--ds-arena-space-2)" }}>
          <LeaderboardRow rank={1} name="SolarFlare" score="9.0k" />
          <LeaderboardRow rank={2} name="LightningZap" score="8.7k" />
          <LeaderboardRow rank={3} name="QuantumBrain" score="8.4k" />
          <LeaderboardRow rank={4} name="NovaDrift" score="7.9k" />
        </ul>
      </section>

      <TabBar
        activeId={tab}
        onSelect={setTab}
        items={[
          { id: "play", label: "Play" },
          { id: "party", label: "Party" },
          { id: "vault", label: "Vault" },
          { id: "profile", label: "Profile" },
        ]}
      />
    </div>
  );
}
