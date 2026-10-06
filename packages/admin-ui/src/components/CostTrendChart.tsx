import { useEffect, useMemo, useRef, useState } from 'react';
import { Segmented, Space, Table, Typography } from 'antd';
import dayjs from 'dayjs';

/**
 * 每日成本堆叠柱状图（手写 SVG，不引图表库）。
 * - 颜色固定跟 bot 走：按整个 30 天窗口的成本取前 5 名分配分类色（顺序固定，
 *   已用 dataviz 校验脚本验证过相邻色弱可分），其余合并为「其他」中性灰；
 *   切换 7 / 30 天只是截取，不会重新上色。
 * - 2px 背景色间隙分隔堆叠段，最上段顶端 4px 圆角、底部平直；悬停整列出明细；
 *   图例常显；另有表格视图（部分颜色对背景对比度不足 3:1，需要文字兜底）。
 */

export interface DailySeriesInput {
  days: string[];
  byBot: Record<string, { cost: number[] }>;
  dataSince: string | null;
}

const SLOTS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
const OTHER = '#b4b2ab';
const TOP_N = SLOTS.length;
const GAP = 2;

const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usdShort = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`);

function niceMax(v: number): number {
  if (v <= 0) return 10;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  // 只取四等分后仍是整数刻度的上限（400 → 100 一格，300 → 75 一格）
  const nice = [1, 2, 2.5, 3, 4, 5, 6, 8, 10].find((n) => f <= n) ?? 10;
  return nice * exp;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

interface Series { key: string; label: string; color: string; values: number[]; }

export function CostTrendChart({ data }: { data: DailySeriesInput }) {
  const [range, setRange] = useState<7 | 30>(7);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();

  // 颜色按整个窗口排名一次性分配（跟 bot 走，不跟当前视图走）
  const allSeries: Series[] = useMemo(() => {
    const ranked = Object.entries(data.byBot)
      .map(([bot, d]) => ({ bot, cost: d.cost, total: d.cost.reduce((a, b) => a + b, 0) }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);
    const top = ranked.slice(0, TOP_N).map((r, i) => ({ key: r.bot, label: r.bot, color: SLOTS[i], values: r.cost }));
    const rest = ranked.slice(TOP_N);
    if (rest.length) {
      const values = data.days.map((_, i) => rest.reduce((s, r) => s + r.cost[i], 0));
      top.push({ key: '__other', label: `其他 ${rest.length} 个`, color: OTHER, values });
    }
    return top;
  }, [data]);

  const start = Math.max(0, data.days.length - range);
  const days = data.days.slice(start);
  const series = allSeries.map((s) => ({ ...s, values: s.values.slice(start) }));
  const totals = days.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const noData = (d: string) => !!data.dataSince && d < data.dataSince;
  const firstDataDay = days.find((d) => !noData(d));

  // ---- 几何 ----
  const H = 250;
  const M = { top: 22, right: 8, bottom: 26, left: 52 };
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = H - M.top - M.bottom;
  const yMax = niceMax(Math.max(...totals, 0));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const band = days.length ? plotW / days.length : 0;
  const barW = Math.min(24, Math.max(4, band * 0.6));
  const y = (v: number) => M.top + plotH - (v / yMax) * plotH;
  const labelEvery = range === 30 ? 5 : 1;
  const todayIdx = days.length - 1;

  const tooltip = hover !== null && (
    <div
      style={{
        position: 'absolute',
        left: Math.min(Math.max(0, M.left + band * hover + band / 2 - 90), Math.max(0, width - 180)),
        top: 0,
        width: 180,
        pointerEvents: 'none',
        background: '#fff',
        border: '1px solid #e8e8e4',
        borderRadius: 6,
        boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
        padding: '8px 10px',
        fontSize: 12,
        zIndex: 2,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {dayjs(days[hover]).format('M月D日')}
        {hover === todayIdx && '（今天，截至此刻）'}
      </div>
      {noData(days[hover]) ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>无数据（活动记录从 {dayjs(data.dataSince).format('M/D')} 开始）</Typography.Text>
      ) : (
        <>
          {[...series].reverse().filter((s) => s.values[hover] > 0).map((s) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flex: 'none' }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{usd(s.values[hover])}</span>
            </div>
          ))}
          <div style={{ display: 'flex', borderTop: '1px solid #f0efec', marginTop: 4, paddingTop: 4 }}>
            <span style={{ flex: 1 }}>合计</span>
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{usd(totals[hover])}</strong>
          </div>
        </>
      )}
    </div>
  );

  const chart = (
    <div ref={ref} style={{ position: 'relative', width: '100%' }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={`近 ${range} 天每日成本，按 bot 堆叠`} style={{ display: 'block' }}>
          {/* 网格与 y 轴刻度：发丝线、实线、弱化 */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#d9d8d3' : '#f0efec'} strokeWidth={1} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="rgba(0,0,0,0.45)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {usdShort(t)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const cx = M.left + band * i + band / 2;
            const x = cx - barW / 2;
            let acc = 0;
            const segs = series
              .map((s) => ({ s, v: s.values[i] }))
              .filter((p) => p.v > 0)
              .map((p) => {
                const y0 = y(acc);
                acc += p.v;
                const y1 = y(acc);
                return { ...p, top: y1, bottom: y0 };
              });
            const lastSeg = segs.length - 1;
            return (
              <g key={d}>
                {hover === i && <rect x={M.left + band * i} y={M.top} width={band} height={plotH} fill="#f5f5f2" />}
                {noData(d) && <line x1={x} x2={x + barW} y1={y(0) - 1} y2={y(0) - 1} stroke="#d9d8d3" />}
                {segs.map((p, k) => {
                  // 段与段之间留 2px 背景色间隙（从每段顶部扣掉）
                  // 太薄的段（< 4px）不扣间隙，否则只剩一条细线、看不出颜色
                  const yTop = p.top;
                  const full = p.bottom - yTop;
                  const h = Math.max(0, full - (k === 0 || full < 4 ? 0 : GAP));
                  if (h <= 0) return null;
                  if (k === lastSeg) {
                    const r = Math.min(4, barW / 2, h);
                    const path = `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`;
                    return <path key={p.s.key} d={path} fill={p.s.color} />;
                  }
                  return <rect key={p.s.key} x={x} y={yTop} width={barW} height={h} fill={p.s.color} />;
                })}
                {/* 只给今天的柱子标总额（选择性标注，其余看 tooltip / 表格） */}
                {i === todayIdx && totals[i] > 0 && (
                  <text x={cx} y={y(totals[i]) - 6} textAnchor="middle" fontSize={11} fill="rgba(0,0,0,0.65)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {usdShort(totals[i])}
                  </text>
                )}
                {(todayIdx - i) % labelEvery === 0 && (
                  <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="rgba(0,0,0,0.45)">
                    {i === todayIdx ? '今天' : dayjs(d).format('M/D')}
                  </text>
                )}
                {/* 整列命中区，比柱子大 */}
                <rect
                  x={M.left + band * i}
                  y={M.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  tabIndex={0}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  aria-label={`${d} 合计 ${usd(totals[i])}`}
                />
              </g>
            );
          })}
        </svg>
      )}
      {tooltip}
    </div>
  );

  const table = (
    <Table
      size="small"
      pagination={false}
      scroll={{ x: true }}
      rowKey="day"
      dataSource={[...days].reverse().map((d) => {
        const i = days.indexOf(d);
        return { day: d, i };
      })}
      columns={[
        { title: '日期', key: 'day', render: (_: unknown, r: { day: string; i: number }) => (r.i === todayIdx ? '今天' : dayjs(r.day).format('M/D')) },
        ...series.map((s) => ({
          title: s.label,
          key: s.key,
          align: 'right' as const,
          render: (_: unknown, r: { day: string; i: number }) => (noData(r.day) ? '—' : usd(s.values[r.i])),
        })),
        {
          title: '合计',
          key: 'total',
          align: 'right' as const,
          render: (_: unknown, r: { day: string; i: number }) => (noData(r.day) ? '—' : <strong>{usd(totals[r.i])}</strong>),
        },
      ]}
    />
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <Space size={12} wrap>
          {series.map((s) => (
            <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color }} />
              <span style={{ color: 'rgba(0,0,0,0.65)' }}>{s.label}</span>
            </span>
          ))}
        </Space>
        <Space size={8}>
          <Segmented size="small" value={range} onChange={(v) => setRange(v as 7 | 30)} options={[{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }]} />
          <Segmented size="small" value={view} onChange={(v) => setView(v as 'chart' | 'table')} options={[{ value: 'chart', label: '图表' }, { value: 'table', label: '表格' }]} />
        </Space>
      </div>
      {view === 'chart' ? chart : table}
      {data.dataSince && firstDataDay !== days[0] && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          活动记录从 {dayjs(data.dataSince).format('M月D日')} 开始，之前的日期没有数据（不是零花费）；保留期已延长到 35 天，会逐步积累满 30 天。
        </Typography.Text>
      )}
    </div>
  );
}
