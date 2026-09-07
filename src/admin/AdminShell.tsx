import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button, Card, CardTitle } from "@/index";
import { useAdminAuth } from "./auth";
import "./admin.css";

const NAV = [
  { to: "/admin", label: "Overview", exact: true },
  { to: "/admin/facts", label: "Content" },
  { to: "/admin/reports", label: "Moderation" },
  { to: "/admin/players", label: "Players" },
  { to: "/admin/daily", label: "Daily challenge" },
  { to: "/admin/analytics", label: "Game analytics" },
  { to: "/admin/roles", label: "Roles & access" },
  { to: "/admin/audit", label: "Audit log" },
] as const satisfies readonly { to: string; label: string; exact?: boolean }[];


function SignIn() {
  const { signIn, resetPassword, error } = useAdminAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResetSent(false);
    try {
      await signIn(email, password);
      await navigate({ to: "/admin", replace: true });
    } catch {
      /* error surfaced through context */
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (!email) return;
    setBusy(true);
    try {
      await resetPassword(email);
      setResetSent(true);
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
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
            <img
              src="/more-or-less-icon.png"
              alt="More or Less"
              style={{ width: "40px", height: "40px", borderRadius: "8px", objectFit: "contain" }}
            />
            <div>
              <CardTitle>More or Less — Admin</CardTitle>
              <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 14, margin: "2px 0 0" }}>
                Sign in with an authorised admin account.
              </p>
            </div>
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
          {resetSent ? (
            <p style={{ color: "var(--ds-arena-color-primary)", fontSize: 13, margin: 0 }}>
              Password reset email sent — check your inbox.
            </p>
          ) : null}
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          <button
            type="button"
            className="admin-reset-link"
            disabled={busy || !email}
            title={email ? undefined : "Enter your email above first"}
            onClick={() => void handleReset()}
          >
            Forgot password?
          </button>
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
        <p style={{ color: "var(--ds-arena-color-text-muted)" }}>Loading…</p>
      </main>
    );
  }

  if (!user) return <SignIn />;

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand" style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <img
            src="/more-or-less-icon.png"
            alt="More or Less"
            style={{ width: "30px", height: "30px", borderRadius: "6px", objectFit: "contain" }}
          />
          <div>
            More or <span>Less</span>
          </div>
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

export function InlineEditorRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <tr className="admin-inline-editor-row">
      <td colSpan={colSpan} className="admin-inline-editor-cell">
        {children}
      </td>
    </tr>
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

export function InfoTip({
  text,
  title,
  position = "top",
}: {
  text: string;
  title?: string;
  position?: "top" | "bottom";
}) {
  return (
    <span
      className={`admin-infotip ${position === "bottom" ? "admin-infotip--bottom" : ""}`}
      tabIndex={0}
      role="tooltip"
      aria-label={text}
      title={title ?? text}
    >
      ?
      <span className="admin-infotip-content">{text}</span>
    </span>
  );
}
