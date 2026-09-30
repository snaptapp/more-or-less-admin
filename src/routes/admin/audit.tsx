import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge, Button, Card } from "@/index";
import { PageHead } from "@/admin/AdminShell";
import { fetchAuditLogEntries } from "@/lib/admin/roles.functions";
import { DerivationInspector } from "@/admin/DerivationInspector";
import type { CandidateSide, TrapDirection } from "@/lib/admin/derivation-audit";

export const Route = createFileRoute("/admin/audit")({
  validateSearch: (search: Record<string, unknown>): {
    tab?: "admin" | "derivation";
    true?: string;
    unit?: string;
    surprise?: string;
    kind?: string;
    side?: string;
    trap?: string;
    pmin?: string;
    pmax?: string;
    presented?: string;
    topic?: string;
  } => {
    return {
      tab: search.tab === "admin" ? "admin" : "derivation", // default to derivation auditor
      true: typeof search.true === "string" ? search.true : undefined,
      unit: typeof search.unit === "string" ? search.unit : undefined,
      surprise: typeof search.surprise === "string" ? search.surprise : undefined,
      kind: typeof search.kind === "string" ? search.kind : undefined,
      side: typeof search.side === "string" ? search.side : undefined,
      trap: typeof search.trap === "string" ? search.trap : undefined,
      pmin: typeof search.pmin === "string" ? search.pmin : undefined,
      pmax: typeof search.pmax === "string" ? search.pmax : undefined,
      presented: typeof search.presented === "string" ? search.presented : undefined,
      topic: typeof search.topic === "string" ? search.topic : undefined,
    };
  },
  head: () => ({ meta: [
    { title: "Audit Log & Derivation Inspector — More or Less Admin" },
    { name: "description", content: "Review admin actions and fact derivation evidence." },
    { property: "og:title", content: "Audit Log & Derivation Inspector — More or Less Admin" },
    { property: "og:description", content: "Review admin actions and fact derivation evidence." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
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
  const searchParams = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const activeTab = searchParams.tab ?? "derivation";

  const load = useServerFn(fetchAuditLogEntries);
  const [search, setSearch] = useState("");

  const { data: logs = [], isLoading, error } = useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => load(),
    enabled: activeTab === "admin",
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

  const handleSelectTab = (tab: "admin" | "derivation") => {
    navigate({
      search: (prev) => ({ ...prev, tab }),
    });
  };

  return (
    <>
      <PageHead
        title="Audit &amp; Decision Inspector"
        description="Inspect agent-go decision-making, DDM distractor mathematics, and administrative audit trails."
      />

      {/* Main Tab Navigation */}
      <div style={{ display: "flex", gap: "var(--ds-arena-space-2)", borderBottom: "1px solid var(--ds-arena-color-border)", paddingBottom: 12 }}>
        <Button
          type="button"
          size="sm"
          variant={activeTab === "derivation" ? "primary" : "ghost"}
          onClick={() => handleSelectTab("derivation")}
        >
          🔬 Agent-Go &amp; DDM Decision Auditor
        </Button>
        <Button
          type="button"
          size="sm"
          variant={activeTab === "admin" ? "primary" : "ghost"}
          onClick={() => handleSelectTab("admin")}
        >
          📋 Admin Action Trail
        </Button>
      </div>

      {activeTab === "derivation" ? (
        <DerivationInspector
          initialValues={{
            trueNumber: searchParams.true,
            unit: searchParams.unit,
            surpriseFactor: searchParams.surprise,
            quantityKind: searchParams.kind,
            forcedSide: searchParams.side as CandidateSide | undefined,
            trapDirection: searchParams.trap as TrapDirection | undefined,
            plausibleMin: searchParams.pmin,
            plausibleMax: searchParams.pmax,
            presentedNumber: searchParams.presented,
            topic: searchParams.topic,
          }}
        />
      ) : (
        <>
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
              <table className="admin-table admin-card-table admin-card-table--audit">
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
      )}
    </>
  );
}
