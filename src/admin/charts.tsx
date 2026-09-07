import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardTitle } from "@/index";

export type ChartRow = { name: string; count: number };

const ARENA = {
  lime: "#d7f24a",
  amber: "#f6c344",
  red: "#f2495c",
  purple: "#a76cff",
  muted: "#8d95a6",
  surface: "#14161c",
  text: "#f5f7fa",
  border: "#262a34",
} as const;

const PALETTE = [ARENA.lime, ARENA.amber, ARENA.red, ARENA.purple, ARENA.muted, "#5b8def", "#2dd4bf"] as const;

const tooltipStyle = {
  background: ARENA.surface,
  border: `1px solid ${ARENA.border}`,
  borderRadius: 8,
  color: ARENA.text,
  fontSize: 12,
};

function hasData(rows: ChartRow[]): boolean {
  return rows.some((row) => row.count > 0);
}

function EmptyState() {
  return <p className="admin-chart-empty">No data</p>;
}

export function StatusPie({
  title,
  rows,
  footnote,
}: {
  title: string;
  rows: ChartRow[];
  footnote?: string;
}) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div className="admin-chart">
        {!hasData(rows) ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={rows}
                dataKey="count"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={48}
                outerRadius={78}
                paddingAngle={2}
                stroke={ARENA.border}
              >
                {rows.map((row, index) => (
                  <Cell key={row.name} fill={PALETTE[index % PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value: number) => [value, "count"]}
              />
              <Legend
                wrapperStyle={{ color: ARENA.muted, fontSize: 12 }}
                formatter={(value) => <span style={{ color: ARENA.text }}>{value}</span>}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
      {footnote ? <p className="admin-chart-footnote">{footnote}</p> : null}
    </Card>
  );
}

export function CountBar({
  title,
  rows,
  layout = "vertical",
  footnote,
}: {
  title: string;
  rows: ChartRow[];
  layout?: "vertical" | "horizontal";
  footnote?: string;
}) {
  const horizontal = layout === "horizontal";
  const chartHeight = Math.max(240, rows.length * 28);

  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div
        className="admin-chart"
        style={horizontal ? { height: chartHeight, minHeight: chartHeight } : undefined}
      >
        {!hasData(rows) ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              layout={horizontal ? "vertical" : "horizontal"}
              margin={{ top: 8, right: 12, left: horizontal ? 8 : 0, bottom: 4 }}
            >
              {horizontal ? (
                <>
                  <XAxis type="number" stroke={ARENA.muted} tick={{ fill: ARENA.muted, fontSize: 11 }} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={110}
                    stroke={ARENA.muted}
                    tick={{ fill: ARENA.text, fontSize: 11 }}
                  />
                </>
              ) : (
                <>
                  <XAxis dataKey="name" stroke={ARENA.muted} tick={{ fill: ARENA.text, fontSize: 11 }} />
                  <YAxis stroke={ARENA.muted} tick={{ fill: ARENA.muted, fontSize: 11 }} allowDecimals={false} />
                </>
              )}
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(215, 242, 74, 0.08)" }} />
              <Bar dataKey="count" radius={[4, 4, 4, 4]} fill={ARENA.lime} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {footnote ? <p className="admin-chart-footnote">{footnote}</p> : null}
    </Card>
  );
}
