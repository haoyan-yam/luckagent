import { useCallback, useState } from 'react';
import { Button, Card, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import { PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { Overview, BotOverview } from '../api/types';
import { RunStatusTag } from '../components/StatusTag';
import BotFormDrawer from './BotFormDrawer';
import FeishuWizard from './FeishuWizard';

export default function BotsPage({ onChanged }: { onChanged: () => void }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [testingName, setTestingName] = useState<string | null>(null);

  // Overview merges bots.json entries with the running registry, so bots whose
  // startup failed (bad credentials etc.) still show up here — with a red tag.
  const { data, refresh } = usePoll<Overview>(() => api.get('/admin/api/overview'), 10000);
  const bots = data?.bots || [];

  const testConnection = useCallback(async (name: string) => {
    setTestingName(name);
    try {
      const r = await api.post<{ ok: boolean; msg: string; feishuCode: number | null }>(
        '/admin/api/feishu/test-connection',
        { botName: name },
      );
      if (r.ok) message.success(`「${name}」凭证有效 ✓`);
      else message.error(`「${name}」验证失败：${r.msg}（code ${r.feishuCode ?? 'n/a'}）`);
    } catch (err: any) {
      message.error(err?.message || '测试失败');
    } finally {
      setTestingName(null);
    }
  }, []);

  const removeBot = useCallback(
    async (name: string) => {
      try {
        await api.del(`/api/bots/${encodeURIComponent(name)}`);
        message.success(`已删除「${name}」，重启桥接后生效`);
        onChanged();
        void refresh();
      } catch (err: any) {
        message.error(err?.message || '删除失败');
      }
    },
    [onChanged, refresh],
  );

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name', render: (v: string) => <strong>{v}</strong> },
    {
      title: '状态',
      key: 'status',
      render: (_: unknown, b: BotOverview) => <RunStatusTag running={b.running} />,
    },
    { title: '引擎', dataIndex: 'engine', key: 'engine', render: (v?: string) => <Tag>{v || 'claude'}</Tag> },
    {
      title: '今日任务',
      key: 'today',
      render: (_: unknown, b: BotOverview) => `${b.today.tasks}${b.today.failed ? `（${b.today.failed} 失败）` : ''}`,
    },
    {
      title: '工作目录',
      dataIndex: 'workDir',
      key: 'wd',
      render: (v?: string | null) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {v || '—'}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, b: BotOverview) => (
        <Space>
          <Button
            size="small"
            onClick={() => {
              setEditing(b.name);
              setDrawerOpen(true);
            }}
          >
            编辑
          </Button>
          <Button size="small" loading={testingName === b.name} onClick={() => testConnection(b.name)}>
            测试连接
          </Button>
          <Popconfirm
            title={`确认删除「${b.name}」？`}
            description="仅从 bots.json 移除配置；工作目录与历史数据不会被删除。"
            onConfirm={() => removeBot(b.name)}
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
          >
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="机器人列表"
      extra={
        <Space>
          <Button icon={<ThunderboltOutlined />} onClick={() => setWizardOpen(true)}>
            飞书接入向导
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setDrawerOpen(true);
            }}
          >
            新建机器人
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="name"
        dataSource={bots}
        columns={columns}
        pagination={false}
        locale={{ emptyText: '还没有机器人 —— 点右上角「飞书接入向导」创建第一个' }}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
        提示：新增 / 修改 / 删除机器人都写入 <Typography.Text code>bots.json</Typography.Text>
        ，需要重启桥接进程才会生效（顶栏「重启桥接」按钮）。凭证保存后以掩码显示，编辑时留空即保持不变。
      </Typography.Paragraph>

      <BotFormDrawer
        open={drawerOpen}
        editing={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => {
          onChanged();
          void refresh();
        }}
      />
      <FeishuWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={() => {
          onChanged();
          void refresh();
        }}
      />
    </Card>
  );
}
