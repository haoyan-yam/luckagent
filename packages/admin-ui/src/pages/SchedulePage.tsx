import { useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { Overview, ScheduleTask } from '../api/types';

export default function SchedulePage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const { data, refresh } = usePoll<{ tasks: ScheduleTask[]; recurringTasks: ScheduleTask[] }>(
    () => api.get('/api/schedule'),
    10000,
  );
  const { data: overview } = usePoll<Overview>(() => api.get('/admin/api/overview'), 30000);
  const botNames = (overview?.bots || []).map((b) => b.name);

  const all: ScheduleTask[] = [
    ...(data?.recurringTasks || []),
    ...(data?.tasks || []).filter((t) => t.status === 'pending'),
  ];

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      void refresh();
    } catch (err: any) {
      message.error(err?.message || '操作失败');
    }
  };

  const onCreate = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      if (v.mode === 'cron') {
        await api.post('/api/schedule', {
          botName: v.botName,
          chatId: v.chatId,
          prompt: v.prompt,
          cronExpr: v.cronExpr,
          label: v.label || undefined,
        });
      } else {
        await api.post('/api/schedule', {
          botName: v.botName,
          chatId: v.chatId,
          prompt: v.prompt,
          delaySeconds: v.delaySeconds,
          label: v.label || undefined,
        });
      }
      message.success('已创建');
      setCreateOpen(false);
      form.resetFields();
      void refresh();
    } catch (err: any) {
      message.error(err?.message || '创建失败');
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (v: string) => (v === 'recurring' ? <Tag color="blue">周期</Tag> : <Tag>一次性</Tag>),
    },
    { title: 'Bot', dataIndex: 'botName', key: 'bot' },
    {
      title: '标签 / 提示词',
      key: 'prompt',
      render: (_: unknown, t: ScheduleTask) => (
        <span>
          {t.label && <Tag color="geekblue">{t.label}</Tag>}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t.prompt.length > 60 ? `${t.prompt.slice(0, 60)}…` : t.prompt}
          </Typography.Text>
        </span>
      ),
    },
    {
      title: '计划',
      key: 'plan',
      render: (_: unknown, t: ScheduleTask) =>
        t.type === 'recurring' ? (
          <span>
            <Typography.Text code>{t.cronExpr}</Typography.Text>{' '}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              下次 {t.nextExecuteAt ? dayjs(t.nextExecuteAt).format('MM-DD HH:mm') : '—'}
            </Typography.Text>
          </span>
        ) : (
          <span>{t.executeAt ? dayjs(t.executeAt).format('MM-DD HH:mm') : '—'}</span>
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) =>
        v === 'active' ? <Tag color="green">进行中</Tag> : v === 'paused' ? <Tag color="orange">已暂停</Tag> : <Tag>{v}</Tag>,
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, t: ScheduleTask) => (
        <Space>
          {t.type === 'recurring' && t.status === 'active' && (
            <Button size="small" onClick={() => act(() => api.post(`/api/schedule/${t.id}/pause`), '已暂停')}>
              暂停
            </Button>
          )}
          {t.type === 'recurring' && t.status === 'paused' && (
            <Button size="small" onClick={() => act(() => api.post(`/api/schedule/${t.id}/resume`), '已恢复')}>
              恢复
            </Button>
          )}
          <Popconfirm title="确认删除该任务？" onConfirm={() => act(() => api.del(`/api/schedule/${t.id}`), '已删除')}>
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
      title="定时任务"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建任务
        </Button>
      }
    >
      <Table rowKey="id" dataSource={all} columns={columns} pagination={{ pageSize: 20 }} size="small" />
      <Typography.Paragraph type="secondary">
        任务持久化在 <Typography.Text code>~/.luckagent/scheduled-tasks.json</Typography.Text>
        ，桥接重启后自动恢复；周期任务按 cron 表达式与时区（<Typography.Text code>SCHEDULE_TIMEZONE</Typography.Text>）计算下次触发。
      </Typography.Paragraph>

      <Modal title="新建定时任务" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={onCreate} confirmLoading={saving} okText="创建" cancelText="取消">
        <Form form={form} layout="vertical" initialValues={{ mode: 'cron' }}>
          <Form.Item name="botName" label="Bot" rules={[{ required: true }]}>
            <Select options={botNames.map((n) => ({ value: n, label: n }))} showSearch placeholder="选择 bot" />
          </Form.Item>
          <Form.Item name="chatId" label="目标会话 chatId" rules={[{ required: true }]} extra="飞书群 oc_ 开头；可在群里让 bot 告诉你，或从日志中获取">
            <Input placeholder="oc_xxxxxxxx" />
          </Form.Item>
          <Form.Item name="prompt" label="提示词" rules={[{ required: true }]}>
            <Input.TextArea rows={3} placeholder="到点后发给 bot 执行的内容" />
          </Form.Item>
          <Form.Item name="label" label="标签（可选）">
            <Input placeholder="daily-report" />
          </Form.Item>
          <Form.Item name="mode" label="触发方式">
            <Radio.Group
              options={[
                { value: 'cron', label: '周期（cron）' },
                { value: 'once', label: '一次性（延迟秒数）' },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.mode !== b.mode}>
            {({ getFieldValue }) =>
              getFieldValue('mode') === 'cron' ? (
                <Form.Item name="cronExpr" label="cron 表达式" rules={[{ required: true }]} extra="如 0 9 * * 1-5（工作日每天 9:00）">
                  <Input placeholder="0 9 * * 1-5" />
                </Form.Item>
              ) : (
                <Form.Item name="delaySeconds" label="延迟秒数" rules={[{ required: true }]}>
                  <InputNumber min={10} style={{ width: '100%' }} placeholder="3600 = 一小时后" />
                </Form.Item>
              )
            }
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
