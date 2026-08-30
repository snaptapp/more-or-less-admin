import { Link } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import type {} from "react";
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
  { to: "/admin/roles", label: "Roles & access" },
] as const satisfies readonly { to: string; label: string; exact?: boolean }[];

function MfaChallenge() {
  const { verifyMfa, error } = useAdminAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await verifyMfa(code);
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
            <CardTitle>Two-factor verification</CardTitle>
            <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 14, margin: "6px 0 0" }}>
              Enter the 6-digit code from your authenticator app.
            </p>
          </div>
          <div className="admin-field">
            <label htmlFor="admin-mfa-code">Verification code</label>
            <input
              id="admin-mfa-code"
              className="admin-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          {error ? <p className="admin-error">{error}</p> : null}
          <Button type="submit" disabled={busy}>
            {busy ? "Verifying…" : "Verify & sign in"}
          </Button>
        </form>
      </Card>
    </main>
  );
}

function MfaEnroll() {
  const { user, beginTotpEnrollment, finalizeTotpEnrollment, signOutAdmin, error } = useAdminAuth();
  const [qr, setQr] = useState<string | null>(null);
  const [manualKey, setManualKey] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);

  async function handleBegin() {
    setBusy(true);
    try {
      const enrollment = await beginTotpEnrollment();
      const { toDataURL } = await import("qrcode");
      setQr(await toDataURL(enrollment.qrUrl, { margin: 1, width: 200 }));
      setManualKey(enrollment.manualKey);
      setStarted(true);
    } catch {
      /* error surfaced through context */
    } finally {
      setBusy(false);
    }
  }

  async function handleFinalize(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await finalizeTotpEnrollment(code);
    } catch {
      /* error surfaced through context */
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="admin-signin">
      <Card>
        <div>
          <CardTitle>Set up two-factor authentication</CardTitle>
          <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 14, margin: "6px 0 0" }}>
            Admin accounts must protect sign-in with an authenticator app. Scan the QR code with
            Google Authenticator, 1Password, Authy, or any TOTP app, then enter the 6-digit code.
          </p>
        </div>
        {!started ? (
          <Button onClick={() => void handleBegin()} disabled={busy}>
            {busy ? "Preparing…" : "Begin setup"}
          </Button>
        ) : (
          <form onSubmit={handleFinalize}>
            {qr ? (
              <img
                src={qr}
                alt="QR code for authenticator app enrollment"
                width={200}
                height={200}
                style={{ alignSelf: "center", borderRadius: 8, background: "#fff", padding: 8 }}
              />
            ) : null}
            {manualKey ? (
              <p style={{ fontSize: 12, color: "var(--ds-arena-color-text-muted)", margin: 0 }}>
                Can't scan? Enter this key manually:{" "}
                <code style={{ color: "var(--ds-arena-color-primary)" }}>{manualKey}</code>
              </p>
            ) : null}
            <div className="admin-field">
              <label htmlFor="admin-enroll-code">6-digit code from your app</label>
              <input
                id="admin-enroll-code"
                className="admin-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            {error ? <p className="admin-error">{error}</p> : null}
            <Button type="submit" disabled={busy}>
              {busy ? "Verifying…" : "Enable two-factor"}
            </Button>
          </form>
        )}
        <button
          type="button"
          className="admin-reset-link"
          disabled={busy}
          onClick={() => void signOutAdmin()}
        >
          Sign out ({user?.email})
        </button>
      </Card>
    </main>
  );
}

function SignIn() {
  const { signIn, resetPassword, error } = useAdminAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResetSent(false);
    try {
      // When MFA is required the auth context flips mfaPending and the
      // shell swaps this form for the challenge step automatically.
      await signIn(email, password);
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
          <div>
            <CardTitle>More or Less — Admin</CardTitle>
            <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 14, margin: "6px 0 0" }}>
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
