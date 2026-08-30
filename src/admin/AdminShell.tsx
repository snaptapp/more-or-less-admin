import { Link } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button, Card, CardTitle } from "@/index";
import { useAdminAuth } from "./auth";
import "./admin.css";

const NAV = [
  { to: "/admin", label: "Overview", exact: true },
  { to: "/admin/facts", label: "Fact bank" },
  { to: "/admin/reports", label: "Moderation" },
  { to: "/admin/taxonomy", label: "Taxonomy & crawl" },
  { to: "/admin/players", label: "Players" },
  { to: "/admin/daily", label: "Daily challenge" },
  { to: "/admin/analytics", label: "Game analytics" },
] as const satisfies readonly { to: string; label: string; exact?: boolean }[];

function SignIn() {
  const { signIn, error } = useAdminAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await signIn(email, password);
    } catch {
      /* error surfaced through context */
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="admin-signin">
      <Card>
        <form onSubmit={handleSubmit}>
          <div>
            <CardTitle>More or Less — Admin</CardTitle>
            <p style={{ color: "var(--color-text-muted)", fontSize: 14, margin: "6px 0 0" }}>
              Sign in with an authorised admin account.
            </p>
          </div>
          <div className="admin-field">
            <label htmlFor="admin-email">Email</label>
            <input
              id="admin-email"
              className="admin-input"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="admin-password">Password</label>
            <input
              id="admin-password"
              className="admin-input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error ? <p className="admin-error">{error}</p> : null}
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </main>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const { user, ready, signOutAdmin } = useAdminAuth();

  if (!ready) {
    return (
      <main className="admin-signin">
        <p style={{ color: "var(--color-text-muted)" }}>Loading…</p>
      </main>
    );
  }

  if (!user) return <SignIn />;

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          More or <span>Less</span>
        </div>
        <nav className="admin-nav">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: "exact" in item ? item.exact : false }}
              activeProps={{ className: "active" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <Badge tone="lime">Admin</Badge>
          <span>{user.email}</span>
          <Button variant="ghost" size="sm" onClick={() => void signOutAdmin()}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="admin-main">{children}</main>
    </div>
  );
}

export function PageHead({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="admin-page-head">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="admin-toolbar">{actions}</div> : null}
    </header>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Request failed";
  return <p className="admin-error">{message}</p>;
}

export function statusTone(status: string): "lime" | "red" | "amber" | "purple" | "neutral" {
  if (status === "active" || status === "resolved" || status === "done") return "lime";
  if (status === "retired" || status === "rejected") return "red";
  if (status === "disputed" || status === "pending_review") return "amber";
  if (status === "processing") return "purple";
  return "neutral";
}
