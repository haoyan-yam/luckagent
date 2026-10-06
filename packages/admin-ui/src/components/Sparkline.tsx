/**
 * 迷你柱状趋势图（stat tile / 表格单元格用）。单一序列：历史柱用弱化灰，
 * 最后一根（今天）用强调色；底部对齐、顶端小圆角。每根柱有原生 tooltip，
 * 具体数值同时在卡片 / 表格里有文字，tooltip 只是补充。
 */
export function Sparkline({
  values,
  labels,
  format = (v) => String(v),
  width = 84,
  height = 24,
}: {
  values: number[];
  labels?: string[];
  format?: (v: number) => string;
  width?: number;
  height?: number;
}) {
  const n = values.length;
  if (n === 0) return null;
  const max = Math.max(...values, 0);
  const gap = 2;
  const barW = Math.min(10, (width - gap * (n - 1)) / n);
  const total = barW * n + gap * (n - 1);
  const x0 = (width - total) / 2;
  const r = Math.min(2, barW / 2);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="近期趋势" style={{ display: 'block' }}>
      {values.map((v, i) => {
        const h = max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * (height - 1)) : 0;
        const x = x0 + i * (barW + gap);
        const y = height - h;
        const last = i === n - 1;
        const fill = last ? '#2a78d6' : '#c3c2bd';
        // 顶端圆角、底部平直：圆角矩形 + 盖住下半部分圆角的方块
        return (
          <g key={i}>
            <title>{`${labels?.[i] ?? ''} ${format(v)}`.trim()}</title>
            {/* 透明命中区：整列可悬停，比柱子本身大 */}
            <rect x={x - gap / 2} y={0} width={barW + gap} height={height} fill="transparent" />
            {h > 0 && (
              <>
                <rect x={x} y={y} width={barW} height={h} rx={r} fill={fill} />
                {h > r && <rect x={x} y={y + r} width={barW} height={h - r} fill={fill} />}
              </>
            )}
            {h === 0 && <rect x={x} y={height - 1} width={barW} height={1} fill="#e4e3df" />}
          </g>
        );
      })}
    </svg>
  );
}
