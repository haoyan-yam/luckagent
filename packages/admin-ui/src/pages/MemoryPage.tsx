import { useEffect, useState } from 'react';
import { Alert, Card, Drawer, Empty, Select, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { Overview } from '../api/types';
import { MarkdownView } from '../md';

interface MemEntry {
  title: string;
  file: string;
  hook: string;
  exists: boolean;
  sizeBytes: number | null;
  mtime: string | null;
}
interface MemOrphan { file: string; sizeBytes: number; mtime: string; }
interface MemPayload {
  exists: boolean;
  memoryDir?: string;
  workdir: string;
  hasIndex?: boolean;
  entries: MemEntry[];
  orphans: MemOrphan[];
}
interface MemFile { file: string; content: string; sizeBytes: number; mtime: string; }

export default function MemoryPage() {
  const { data: overview } = usePoll<Overview>(() => api.get('/admin/api/overview'), 30000);
  const [bot, setBot] = useState<string | null>(null);
  const [mem, setMem] = useState<MemPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ title: string; loading: boolean; data?: MemFile } | null>(null);

  const botNames = (overview?.bots || []).map((b) => b.name);
  useEffect(() => {
    if (!bot && botNames.length > 0) setBot(botNames[0]);
  }, [bot, botNames]);

  useEffect(() => {
    if (!bot) return;
    let stale = false;
    setLoading(true);
    setErr(null);
    api.get<MemPayload>(`/admin/api/memory?bot=${encodeURIComponent(bot)}`)
      .then((d) => { if (!stale) setMem(d); })
      .catch((e) => { if (!stale) { setMem(null); setErr(e?.message || '加载失败'); } })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [bot]);

  const openFile = async (file: string, title: string) => {
    if (!bot) return;
    setViewer({ title, loading: true });
    try {
      const d = await api.get<MemFile>(`/admin/api/memory/file?bot=${encodeURIComponent(bot)}&file=${encodeURIComponent(file)}`);
      setViewer({ title, loading: false, data: d });
    } catch {
      setViewer({ title, loading: false });
    }
  };

  const columns = [
    {
      title: '记忆',
      dataIndex: 'title',
      key: 'title',
      width: 260,
      render: (v: string, r: MemEntry) =>
        r.exists ? (
          <Typography.Link onClick={() => openFile(r.file, v)}><strong>{v}</strong></Typography.Link>
        ) : (
          <span><strong>{v}</strong> <Tag color="red">文件缺失</Tag></span>
        ),
    },
    { title: '钩子（何时想起它）', dataIndex: 'hook', key: 'hook', ellipsis: true },
    {
      title: '文件',
      dataIndex: 'file',
      key: 'file',
      width: 220,
      render: (v: string) => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text>,
    },
    {
      title: '更新',
      dataIndex: 'mtime',
      key: 'mtime',
      width: 110,
      render: (v: string | null) => (v ? dayjs(v).format('MM-DD HH:mm') : '—'),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title="Bot 私有记忆（auto-memory）"
        extra={
          <Select
            style={{ width: 220 }}
            placeholder="选择机器人"
            value={bot}
            onChange={setBot}
            options={botNames.map((n) => ({ value: n, label: n }))}
          />
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          这是该 bot 在对话中自主沉淀的私人笔记（按工作目录隔离，与其他 bot 互不可见）。
          「钩子」来自索引 MEMORY.md——bot 每次会话开始时加载的就是这份索引。
        </Typography.Paragraph>
        {err && <Alert type="error" banner message={err} style={{ marginBottom: 12 }} />}
        {mem && !mem.exists && (
          <Empty description="该 bot 还没有产生任何记忆（干过活、遇到值得记的事之后这里会出现内容）" />
        )}
        {mem?.exists && (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{mem.memoryDir}</Typography.Text>
            {!mem.hasIndex && mem.entries.length === 0 && (
              <Alert type="info" showIcon style={{ marginTop: 8 }} message="记忆目录存在但还没有 MEMORY.md 索引" />
            )}
            <Table
              rowKey="file"
              dataSource={mem.entries}
              columns={columns}
              pagination={false}
              size="small"
              loading={loading}
              style={{ marginTop: 8 }}
            />
            {mem.orphans.length > 0 && (
              <Card size="small" style={{ marginTop: 16 }} title={`未入索引的文件（${mem.orphans.length}）——存在于目录但 MEMORY.md 没有对应行`}>
                <Space wrap>
                  {mem.orphans.map((o) => (
                    <Typography.Link key={o.file} onClick={() => openFile(o.file, o.file)}>
                      <Tag>{o.file}</Tag>
                    </Typography.Link>
                  ))}
                </Space>
              </Card>
            )}
          </>
        )}
      </Card>

      <Drawer title={viewer?.title} open={!!viewer} onClose={() => setViewer(null)} width={720}>
        {viewer?.loading && <Typography.Text type="secondary">加载中…</Typography.Text>}
        {viewer && !viewer.loading && !viewer.data && <Alert type="warning" message="读取失败" />}
        {viewer?.data && (
          <>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              {viewer.data.file} · {(viewer.data.sizeBytes / 1024).toFixed(1)}KB · 更新于 {dayjs(viewer.data.mtime).format('YYYY-MM-DD HH:mm')}
            </Typography.Paragraph>
            <MarkdownView text={viewer.data.content} />
          </>
        )}
      </Drawer>
    </Space>
  );
}
