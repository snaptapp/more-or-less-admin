import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge, Button, Card } from "@/index";
import { useAdminAuth } from "@/admin/auth";
import { listAdminUsers, setAdminRole } from "@/lib/admin/roles.functions";

export const Route = createFileRoute("/admin/roles")({
  head: () => ({ meta: [
    { title: "Roles & Access — More or Less Admin" },
    { name: "description", content: "Manage administrator access for More or Less." },
    { property: "og:title", content: "Roles & Access — More or Less Admin" },
    { property: "og:description", content: "Manage administrator access for More or Less." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: RolesPage,
});

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function RolesPage() {
  const { user } = useAdminAuth();
  const queryClient = useQueryClient();
  const fetchUsers = useServerFn(listAdminUsers);
  const updateRole = useServerFn(setAdminRole);
  const [search, setSearch] = useState("");
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: users = [], isLoading, error } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => fetchUsers(),
  });

  const filtered = users.filter((record) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return (
      record.email?.toLowerCase().includes(needle) ||
      record.displayName?.toLowerCase().includes(needle) ||
      record.uid.toLowerCase().includes(needle)
    );
  });

  async function toggleAdmin(uid: string, currentlyAdmin: boolean) {
    const target = users.find((record) => record.uid === uid);
    const label = target?.email ?? uid;
    if (
      !window.confirm(
        currentlyAdmin
          ? `Revoke admin access for ${label}? They will lose access on their next sign-in or token refresh.`
          : `Grant admin access to ${label}? They must sign out and back in for it to take effect.`,
      )
    ) {
      return;
    }
    setBusyUid(uid);
    setActionError(null);
    try {
      await updateRole({ data: { uid, admin: !currentlyAdmin } });
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Role update failed");
    } finally {
      setBusyUid(null);
    }
  }

  return (
    <>
      <header className="admin-page-head">
        <h1>Roles &amp; access</h1>
        <p>
          Grant or revoke admin access. Changes apply on the user's next sign-in or token refresh
          (up to ~1 hour). Email-allowlisted accounts also pass the gate — manage that list in the
          project secrets.
        </p>
      </header>

      <div className="admin-toolbar">
        <div className="admin-field" style={{ flex: 1, maxWidth: 360 }}>
          <label htmlFor="role-search">Search users</label>
          <input
            id="role-search"
            className="admin-input"
            type="search"
            placeholder="Email, name, or UID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {actionError ? <p className="admin-error">{actionError}</p> : null}
      {error ? <p className="admin-error">{error.message}</p> : null}

      <Card>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th>MFA</th>
                <th>Created</th>
                <th>Last sign-in</th>
                <th>Role</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="admin-empty">
                    Loading users…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="admin-empty">
                    No users match your search.
                  </td>
                </tr>
              ) : (
                filtered.map((record) => {
                  const isSelf = record.uid === user?.uid;
                  return (
                    <tr key={record.uid}>
                      <td>
                        <strong>{record.email ?? "(no email)"}</strong>
                        {record.displayName ? ` — ${record.displayName}` : ""}
                        <br />
                        <span style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 12 }}>
                          {record.uid}
                        </span>
                      </td>
                      <td>
                        {record.disabled ? (
                          <Badge tone="red">Disabled</Badge>
                        ) : record.emailVerified ? (
                          <Badge tone="lime">Verified</Badge>
                        ) : (
                          <Badge tone="amber">Unverified</Badge>
                        )}
                      </td>
                      <td>
                        {record.mfaEnrolled ? (
                          <Badge tone="lime">Enrolled</Badge>
                        ) : (
                          <Badge>None</Badge>
                        )}
                      </td>
                      <td>{formatDate(record.createdAt)}</td>
                      <td>{formatDate(record.lastSignInAt)}</td>
                      <td>
                        {record.isAdmin ? <Badge tone="purple">Admin</Badge> : <Badge>Player</Badge>}
                        {isSelf ? (
                          <>
                            {" "}
                            <Badge tone="amber">You</Badge>
                          </>
                        ) : null}
                      </td>
                      <td className="admin-row-actions">
                        <Button
                          variant={record.isAdmin ? "ghost" : "primary"}
                          size="sm"
                          disabled={busyUid === record.uid || (isSelf && record.isAdmin)}
                          title={
                            isSelf && record.isAdmin
                              ? "You cannot revoke your own admin access"
                              : undefined
                          }
                          onClick={() => void toggleAdmin(record.uid, record.isAdmin)}
                        >
                          {busyUid === record.uid
                            ? "Saving…"
                            : record.isAdmin
                              ? "Revoke admin"
                              : "Make admin"}
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
