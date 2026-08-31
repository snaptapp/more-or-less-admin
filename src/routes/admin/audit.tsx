import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge, Card } from "@/index";
import { PageHead } from "@/admin/AdminShell";
import { fetchAuditLogEntries } from "@/lib/admin/roles.functions";

export const Route = createFileRoute("/admin/audit")({
  head: () => ({ meta: [{ title: "Audit Log — More or Less Admin" }] }),
  component: AuditLogPage,
});

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function toneForAction(action: string): "lime" | "amber" | "red" | "purple" | "neutral" {
  if (action.includes("create") || action.includes("grant")) return "lime";
  if (action.includes("retire") || action.includes("revoke") || action.includes("reject")) return "red";
  if (action.includes("update") || action.includes("fix")) return "amber";
  if (action.includes("dispatch") || action.includes("schedule")) return "purple";
  return "neutral";
}

function AuditLogPage() {
  const load = useServerFn(fetchAuditLogEntries);
  const [search, setSearch] = useState("");

  const { data: logs = [], isLoading, error } = useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => load(),
  });

  const filtered = logs.filter((entry) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return (
      entry.action.toLowerCase().includes(term) ||
      (entry.adminEmail && entry.adminEmail.toLowerCase().includes(term)) ||
      entry.targetId.toLowerCase().includes(term) ||
      (entry.details && entry.details.toLowerCase().includes(term))
    );
  });

  return (
    <>
      <PageHead
        title="Audit log"
        description="Immutable record of administrative actions and system events."
      />

      <div className="admin-toolbar">
        <div className="admin-field" style={{ flex: 1, maxWidth: 360 }}>
          <label htmlFor="audit-search">Search log</label>
          <input
            id="audit-search"
            className="admin-input"
            type="search"
            placeholder="Action, admin email, or target ID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {error ? <p className="admin-error">{error.message}</p> : null}

      <Card>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Admin</th>
                <th>Action</th>
                <th>Target</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="admin-empty">
                    Loading audit trail…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="admin-empty">
                    No audit records found.
                  </td>
                </tr>
              ) : (
                filtered.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span style={{ fontSize: 13, whiteSpace: "nowrap" }}>
                        {formatDate(item.createdAt as string)}
                      </span>
                    </td>
                    <td>
                      <strong>{item.adminEmail || item.adminUid}</strong>
                    </td>
                    <td>
                      <Badge tone={toneForAction(item.action)}>{item.action}</Badge>
                    </td>
                    <td>
                      <span style={{ fontFamily: "var(--ds-arena-font-mono)", fontSize: 12 }}>
                        {item.targetType}: {item.targetId}
                      </span>
                    </td>
                    <td>{item.details || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
