import { useEffect, useRef, useState } from 'react';
import { Card, Input, Radio, Select, Space, Switch, Typography } from 'antd';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';

export default function LogsPage() {
  const [file, setFile] = useState<'out' | 'error'>('out');
  const [lines, setLines] = useState(200);
  const [auto, setAuto] = useState(true);
  const [keyword, setKeyword] = useState('');
  const boxRef = useRef<HTMLPreElement>(null);

  const { data, refresh } = usePoll<{ file: string; lines: string[]; truncated: boolean }>(
    () => api.get(`/admin/api/logs?file=${file}&lines=${lines}`),
    auto ? 3000 : 3600_000,
    [file, lines, auto],
  );

  useEffect(() => {
    // Stick to bottom on refresh.
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data]);

  const display = (data?.lines || []).filter((l) => !keyword || l.toLowerCase().includes(keyword.toLowerCase()));

  const highlight = (line: string) => {
    if (!keyword) return line;
    const idx = line.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx === -1) return line;
    return (
      <>
        {line.slice(0, idx)}
        <mark>{line.slice(idx, idx + keyword.length)}</mark>
        {line.slice(idx + keyword.length)}
      </>
    );
  };

  return (
    <Card
      title="运行日志"
      extra={
        <Space>
          <Radio.Group
            value={file}
            onChange={(e) => setFile(e.target.value)}
            options={[
              { value: 'out', label: 'out.log' },
              { value: 'error', label: 'error.log' },
            ]}
            optionType="button"
          />
          <Select
            value={lines}
            onChange={setLines}
            options={[100, 200, 500, 1000].map((n) => ({ value: n, label: `${n} 行` }))}
            style={{ width: 100 }}
          />
          <Input.Search placeholder="过滤关键字" allowClear onSearch={setKeyword} style={{ width: 200 }} />
          <span>
            自动刷新 <Switch checked={auto} onChange={(v) => { setAuto(v); if (v) void refresh(); }} />
          </span>
        </Space>
      }
    >
      <pre
        ref={boxRef}
        style={{
          background: '#0b0e14',
          color: '#d5dbe5',
          padding: 16,
          borderRadius: 8,
          height: '65vh',
          overflow: 'auto',
          fontSize: 12,
          lineHeight: 1.6,
          margin: 0,
        }}
      >
        {display.length ? display.map((l, i) => <div key={i}>{highlight(l)}</div>) : '（暂无日志）'}
      </pre>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        仅读取桥接日志尾部（最多 1000 行 / 512KB）。core 服务日志请用终端：
        <Typography.Text code>luckagent logs --core</Typography.Text>
      </Typography.Paragraph>
    </Card>
  );
}
