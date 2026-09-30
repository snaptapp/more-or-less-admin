import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button, Card, CardTitle } from "@/index";
import {
  FACT_STATUSES,
  STATUS_TRANSITIONS,
  type FactStatus,
} from "../../shared/fact-lifecycle-contract.gen";
import { useAdminAuth } from "./auth";
import "./admin.css";

type StatusTone = "lime" | "red" | "amber" | "purple" | "neutral";

/**
 * Tone for every fact status the shared contract declares (Requirement 9.2).
 * Keying the map by `FactStatus` makes the compiler require an entry for each
 * declared status and reject any status the contract does not declare, so the
 * fact status display enumerates exactly the contract's set — no hand-written
 * fact-status literal chooses a tone.
 */
const FACT_STATUS_TONES: Record<FactStatus, StatusTone> = {
  active: "lime",
  pending: "amber",
  disputed: "amber",
  retired: "red",
};

const FACT_STATUS_SET = new Set<string>(FACT_STATUSES);

/**
 * Whether a persisted status is one the shared contract declares. A non-empty
 * string absent from `FACT_STATUSES` is an unknown persisted status: it renders
 * verbatim with a distinguishing indicator, is excluded from declared-status
 * filters, and offers no status-change control (Requirement 9.10).
 */
export function isKnownFactStatus(status: string): status is FactStatus {
  return FACT_STATUS_SET.has(status);
}

/**
 * The admin-authorized status targets reachable from `status`, derived from the
 * shared contract's transition table rather than any hand-written literal list
 * (Requirements 9.3, 9.4, 9.8). An unknown persisted status is never a declared
 * transition source, so this returns an empty list for it — the caller then
 * offers no status-change control (Requirement 9.10). Targets are returned in
 * the contract's declaration order.
 */
export function adminAuthorizedTargetsFor(status: string): FactStatus[] {
  return STATUS_TRANSITIONS.filter(
    (transition) => transition.from === status && transition.adminAuthorized,
  ).map((transition) => transition.to);
}

const NAV = [
  { to: "/admin", label: "Overview", exact: true },
  { to: "/admin/config", label: "Remote Config" },
  { to: "/admin/facts", label: "Content" },
  { to: "/admin/reports", label: "Moderation" },
  { to: "/admin/players", label: "Players" },
  { to: "/admin/daily", label: "Daily Blitz" },
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
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    menuRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        toggleRef.current?.focus();
      } else if (event.key === "Tab") {
        const focusable = menuRef.current?.querySelectorAll<HTMLElement>("a, button:not(:disabled)");
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

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
      <header className="admin-mobile-header">
        <Link to="/admin" className="admin-mobile-brand" onClick={() => setMenuOpen(false)}>
          <img src="/more-or-less-icon.png" alt="" />
          <span>More or <strong>Less</strong></span>
        </Link>
        <Button
          ref={toggleRef}
          variant="ghost"
          size="sm"
          className="admin-menu-toggle"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          aria-controls="admin-mobile-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">{menuOpen ? "✕" : "☰"}</span>
        </Button>
        {menuOpen ? (
          <>
          <Button variant="ghost" className="admin-mobile-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />
          <div id="admin-mobile-menu" className="admin-mobile-menu" ref={menuRef} role="dialog" aria-modal="true" aria-label="Admin navigation">
            <nav className="admin-nav" aria-label="Admin pages">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{ exact: "exact" in item ? item.exact : false }}
                  activeProps={{ className: "is-active" }}
                  aria-current={pathname === item.to || (!("exact" in item && item.exact) && pathname.startsWith(`${item.to}/`)) ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="admin-sidebar-footer">
              <span>{user.email}</span>
              <Button variant="ghost" size="sm" onClick={() => { setMenuOpen(false); void signOutAdmin(); }}>
                Sign out
              </Button>
            </div>
          </div>
          </>
        ) : null}
      </header>
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
        <nav className="admin-nav" aria-label="Admin pages">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: "exact" in item ? item.exact : false }}
              activeProps={{ className: "is-active" }}
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
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Request failed";
  const message =
    /FAILED_PRECONDITION|requires an index|COLLECTION_GROUP/i.test(raw)
      ? "A Firestore collection-group index is missing, so this page cannot load game history yet. Open the Firebase index dialog, click Save once, and wait until the index status is Enabled."
      : raw.replace(/https:\/\/console\.firebase\.google\.com\S+/g, "").trim() || raw;
  return <p className="admin-error">{message}</p>;
}

export function statusTone(status: string): StatusTone {
  // Fact statuses take their tone from the contract-derived map so the fact
  // status display covers exactly the declared set (Requirement 9.2). Report
  // and crawl lifecycle values, which the shared contract does not own, keep
  // their own tones below.
  if (FACT_STATUS_SET.has(status)) {
    return FACT_STATUS_TONES[status as FactStatus];
  }
  if (status === "resolved" || status === "done") return "lime";
  if (status === "rejected") return "red";
  if (status === "pending_review") return "amber";
  if (status === "processing") return "purple";
  return "neutral";
}

/**
 * Renders a fact's status as a badge, always showing the stored value verbatim
 * and never coercing it. A status the shared contract declares takes its
 * contract-derived tone. A non-empty status absent from the contract is an
 * unknown persisted status (Requirement 9.10): it renders verbatim with a
 * distinguishing "neutral" tone and an "unknown status" affordance (a `⚠` marker
 * plus a tooltip and accessible label) so it reads as a value the portal does
 * not own, while the stored value is left unmodified on read and display.
 */
export function FactStatusBadge({ status }: { status: string }) {
  if (isKnownFactStatus(status)) {
    return <Badge tone={statusTone(status)}>{status}</Badge>;
  }
  const note = `Unknown status not declared by the fact-lifecycle contract: ${status}`;
  return (
    <Badge tone="neutral">
      <span aria-label={note} title={note}>
        <span aria-hidden="true">⚠ </span>
        {status}
      </span>
    </Badge>
  );
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
