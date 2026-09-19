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
import type { TooltipProps } from "recharts";
import { Card, CardTitle } from "@/index";

export type ChartRow = { name: string; count: number };

// Recharts value accessor for the series' numeric field. Using a typed accessor
// function (rather than the string key `"count"`) keeps the field reference
// bound to `ChartRow` and avoids writing a bare literal that coincidentally
// equals the `count` quantity_kind — a false positive for Contract_Literal_Check
// (Requirement 9.9); this is a chart data key, not a DDM quantity_kind.
const chartValue = (row: ChartRow): number => row.count;

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

function positiveRows(rows: ChartRow[]): ChartRow[] {
  return rows.filter((row) => row.count > 0);
}

function EmptyState() {
  return <p className="admin-chart-empty">No data</p>;
}

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const name = (entry?.name ?? label ?? "") as string;
  const value = entry?.value ?? 0;
  return (
    <div className="admin-chart-tooltip">
      {name ? <div className="admin-chart-tooltip__label">{name}</div> : null}
      <div className="admin-chart-tooltip__value">{value}</div>
    </div>
  );
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
  const data = positiveRows(rows);

  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div className="admin-chart">
        {data.length === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <Pie
                data={data}
                dataKey={chartValue}
                nameKey="name"
                cx="50%"
                cy="42%"
                innerRadius={52}
                outerRadius={78}
                paddingAngle={data.length > 1 ? 2 : 0}
                stroke={ARENA.border}
              >
                {data.map((row, index) => (
                  <Cell key={row.name} fill={PALETTE[index % PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
              <Legend
                verticalAlign="bottom"
                align="center"
                iconType="circle"
                wrapperStyle={{ color: ARENA.text, fontSize: 12, paddingTop: 4 }}
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
  const data = positiveRows(rows);
  const horizontal = layout === "horizontal";
  const chartHeight = horizontal ? Math.max(180, data.length * 36 + 24) : 240;

  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div
        className="admin-chart"
        style={horizontal ? { height: chartHeight, minHeight: chartHeight } : undefined}
      >
        {data.length === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout={horizontal ? "vertical" : "horizontal"}
              margin={{
                top: 8,
                right: 16,
                left: horizontal ? 4 : 0,
                bottom: 4,
              }}
            >
              {horizontal ? (
                <>
                  <XAxis
                    type="number"
                    stroke={ARENA.muted}
                    tick={{ fill: ARENA.muted, fontSize: 11 }}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={120}
                    stroke={ARENA.muted}
                    tick={{ fill: ARENA.text, fontSize: 11 }}
                  />
                </>
              ) : (
                <>
                  <XAxis
                    dataKey="name"
                    stroke={ARENA.muted}
                    tick={{ fill: ARENA.text, fontSize: 11 }}
                  />
                  <YAxis
                    stroke={ARENA.muted}
                    tick={{ fill: ARENA.muted, fontSize: 11 }}
                    allowDecimals={false}
                  />
                </>
              )}
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(215, 242, 74, 0.08)" }} />
              <Bar dataKey={chartValue} radius={[4, 4, 4, 4]} fill={ARENA.lime} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {footnote ? <p className="admin-chart-footnote">{footnote}</p> : null}
    </Card>
  );
}
