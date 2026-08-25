import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { Overview, ScheduleTask } from '../api/types';

const LABEL_PREFIX = 'group-summary:';
const DEFAULT_CRON = '0 21 * * 1-5';
const DEFAULT_TEMPLATE = `请生成本群今日日报（本群 chat_id: {chatId}）。步骤：
1. 用 lark-cli（--profile {bot} --as bot）拉取本群今天 00:00 至现在的消息记录；
2. 归纳为四节：📌 今日主题 / ✅ 达成的决定 / 📋 待办与负责人 / ❓ 遗留问题；
3. 控制在一屏内，直接发到本群；若今日无有效讨论，只发一句「今日无讨论」。`;

interface Chat {
  chatId: string;
  name: string;
}

type RowStatus = 'on' | 'paused' | 'ignored' | 'unset' | 'orphan';

interface Row {
  chatId: string;
  name: string;
  status: RowStatus;
  task?: ScheduleTask;
}

export default function GroupSummaryPage() {
  const [bot, setBot] = useState<string | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [loadingChats, setLoadingChats] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<Row | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const { data: overview } = usePoll<Overview>(() => api.get('/admin/api/overview'), 30000);
  const botNames = (overview?.bots || []).map((b) => b.name);

  const { data: schedule, refresh: refreshSchedule } = usePoll<{ recurringTasks: ScheduleTask[] }>(
    () => api.get('/api/schedule'),
    10000,
  );

  // Auto-select the first bot once the list arrives.
  useEffect(() => {
    if (!bot && botNames.length) setBot(botNames[0]);
  }, [bot, botNames]);

  const loadSeq = useRef(0);
  const loadChats = useCallback(async (botName: string) => {
    const seq = ++loadSeq.current;
    setLoadingChats(true);
    setChatsError(null);
    try {
      const r = await api.get<{ chats: Chat[] }>(`/admin/api/feishu/chats?bot=${encodeURIComponent(botName)}`);
      if (seq === loadSeq.current) setChats(r.chats);
    } catch (err: any) {
      if (seq === loadSeq.current) {
        setChats([]);
        setChatsError(err?.message || '拉取群列表失败');
      }
    } finally {
      if (seq === loadSeq.current) setLoadingChats(false);
    }
  }, []);

  useEffect(() => {
    setChats([]);
    setExcluded([]);
    if (!bot) return;
    let cancelled = false;
    void loadChats(bot);
    void api
      .get<{ excluded: string[] }>(`/admin/api/group-summary?bot=${encodeURIComponent(bot)}`)
      .then((r) => { if (!cancelled) setExcluded(r.excluded); })
      .catch(() => { if (!cancelled) setExcluded([]); });
    return () => { cancelled = true; };
  }, [bot, loadChats]);

  const saveExcluded = useCallback(
    (update: (prev: string[]) => string[]) => {
      if (!bot) return;
      setExcluded((prev) => {
        const next = update(prev);
        api.put('/admin/api/group-summary', { bot, excluded: next }).catch(async (err: any) => {
          message.error(err?.message || '保存忽略名单失败');
          // 失败以服务端为准回读，避免本地状态漂移
          try {
            const r = await api.get<{ excluded: string[] }>(`/admin/api/group-summary?bot=${encodeURIComponent(bot)}`);
            setExcluded(r.excluded);
          } catch { /* 桥接不可达时保持现状 */ }
        });
        return next;
      });
    },
    [bot],
  );

  const rows: Row[] = useMemo(() => {
    if (!bot) return [];
    const tasks = (schedule?.recurringTasks || []).filter(
      (t) => t.botName === bot && (t.label || '').startsWith(LABEL_PREFIX),
    );
    const taskByChat = new Map(tasks.map((t) => [(t.label || '').slice(LABEL_PREFIX.length), t]));
    const list: Row[] = chats.map((c) => {
      const task = taskByChat.get(c.chatId);
      if (task) return { chatId: c.chatId, name: c.name, status: task.status === 'paused' ? 'paused' : 'on', task };
      if (excluded.includes(c.chatId)) return { chatId: c.chatId, name: c.name, status: 'ignored' };
      return { chatId: c.chatId, name: c.name, status: 'unset' };
    });
    // Tasks whose group the bot has since left → orphans, still deletable.
    // Only when the chats fetch SUCCEEDED with data — an error/empty list
    // must not mislabel every healthy task as orphaned (and invite mass
    // deletion).
    if (!chatsError && chats.length > 0) {
      for (const t of tasks) {
        const cid = (t.label || '').slice(LABEL_PREFIX.length);
        if (!chats.some((c) => c.chatId === cid)) {
          list.push({ chatId: cid, name: '（bot 已不在此群）', status: 'orphan', task: t });
        }
      }
    }
    return list;
  }, [bot, chats, chatsError, excluded, schedule]);

  const unsetCount = rows.filter((r) => r.status === 'unset').length;

  const openEditor = (row: Row) => {
    setEditorTarget(row);
    form.setFieldsValue({
      cronExpr: row.task?.cronExpr || DEFAULT_CRON,
      prompt:
        row.task?.prompt ||
        DEFAULT_TEMPLATE.replaceAll('{bot}', bot || '').replaceAll('{chatId}', row.chatId),
    });
    setEditorOpen(true);
  };

  const submitEditor = async () => {
    if (!bot || !editorTarget) return;
    const { cronExpr, prompt } = await form.validateFields();
    setSaving(true);
    try {
      if (editorTarget.task) {
        await api.patch(`/api/schedule/${editorTarget.task.id}`, { cronExpr, prompt });
        message.success('已更新');
      } else {
        await api.post('/api/schedule', {
          botName: bot,
          chatId: editorTarget.chatId,
          prompt,
          cronExpr,
          label: `${LABEL_PREFIX}${editorTarget.chatId}`,
        });
        // 开启日报的群顺手移出忽略名单
        saveExcluded((prev) => prev.filter((c) => c !== editorTarget.chatId));
        message.success('日报已开启（调度即时生效，无需重启）');
      }
      setEditorOpen(false);
      void refreshSchedule();
    } catch (err: any) {
      message.error(err?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      void refreshSchedule();
    } catch (err: any) {
      message.error(err?.message || '操作失败');
    }
  };

  const runNow = async (row: Row) => {
    if (!bot) return;
    const prompt =
      row.task?.prompt || DEFAULT_TEMPLATE.replaceAll('{bot}', bot).replaceAll('{chatId}', row.chatId);
    try {
      await api.post('/api/talk', { botName: bot, chatId: row.chatId, prompt, async: true });
      message.success('已触发一次日报，稍后到群里查看结果');
    } catch (err: any) {
      message.error(err?.message || '触发失败');
    }
  };

  const statusTag = (s: RowStatus) =>
    s === 'on' ? (
      <Tag color="green">已开日报</Tag>
    ) : s === 'paused' ? (
      <Tag color="orange">已暂停</Tag>
    ) : s === 'ignored' ? (
      <Tag>已忽略</Tag>
    ) : s === 'orphan' ? (
      <Tag color="red">失效</Tag>
    ) : (
      <Tag color="blue">未配置</Tag>
    );

  const columns = [
    {
      title: '群',
      key: 'name',
      render: (_: unknown, r: Row) => (
        <span>
          <strong>{r.name}</strong>{' '}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.chatId.slice(0, 14)}…
          </Typography.Text>
        </span>
      ),
    },
    { title: '状态', key: 'status', render: (_: unknown, r: Row) => statusTag(r.status) },
    {
      title: '计划',
      key: 'plan',
      render: (_: unknown, r: Row) =>
        r.task ? (
          <span>
            <Typography.Text code>{r.task.cronExpr}</Typography.Text>{' '}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              下次 {r.task.nextExecuteAt ? dayjs(r.task.nextExecuteAt).format('MM-DD HH:mm') : '—'}
            </Typography.Text>
          </span>
        ) : (
          '—'
        ),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, r: Row) => (
        <Space wrap>
          {r.status === 'unset' && (
            <>
              <Button size="small" type="primary" onClick={() => openEditor(r)}>
                开启日报
              </Button>
              <Button size="small" onClick={() => saveExcluded((prev) => [...prev, r.chatId])}>
                忽略
              </Button>
            </>
          )}
          {r.status === 'ignored' && (
            <>
              <Button size="small" onClick={() => saveExcluded((prev) => prev.filter((c) => c !== r.chatId))}>
                取消忽略
              </Button>
              <Button size="small" type="primary" onClick={() => openEditor(r)}>
                开启日报
              </Button>
            </>
          )}
          {(r.status === 'on' || r.status === 'paused') && r.task && (
            <>
              {r.status === 'on' ? (
                <Button size="small" onClick={() => act(() => api.post(`/api/schedule/${r.task!.id}/pause`), '已暂停')}>
                  暂停
                </Button>
              ) : (
                <Button size="small" onClick={() => act(() => api.post(`/api/schedule/${r.task!.id}/resume`), '已恢复')}>
                  恢复
                </Button>
              )}
              <Button size="small" onClick={() => openEditor(r)}>
                修改
              </Button>
              <Button size="small" onClick={() => runNow(r)}>
                立即试跑
              </Button>
              <Popconfirm
                title="关闭该群日报？"
                description="删除对应的周期任务；群会回到「未配置」状态。"
                onConfirm={() => act(() => api.del(`/api/schedule/${r.task!.id}`), '已关闭')}
              >
                <Button size="small" danger>
                  关闭
                </Button>
              </Popconfirm>
            </>
          )}
          {r.status === 'orphan' && r.task && (
            <Popconfirm title="删除这条失效任务？" onConfirm={() => act(() => api.del(`/api/schedule/${r.task!.id}`), '已删除')}>
              <Button size="small" danger>
                删除失效任务
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="群日报"
      extra={
        <Space>
          <Select
            style={{ width: 200 }}
            placeholder="选择 bot"
            value={bot}
            onChange={setBot}
            options={botNames.map((n) => ({ value: n, label: n }))}
          />
          <Button onClick={() => bot && loadChats(bot)} loading={loadingChats}>
            刷新群列表
          </Button>
        </Space>
      }
    >
      {chatsError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`无法拉取群列表：${chatsError}`}
          description="bot 需处于运行状态且飞书凭证有效（需要 im:chat:readonly 权限）。"
        />
      )}
      {!chatsError && unsetCount > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`有 ${unsetCount} 个群尚未配置日报——逐个「开启」或「忽略」后此提示消失。`}
        />
      )}
      <Table
        rowKey="chatId"
        dataSource={rows}
        columns={columns}
        loading={loadingChats}
        pagination={{ pageSize: 20 }}
        size="small"
        locale={{ emptyText: bot ? '该 bot 不在任何群里（先把 bot 拉进群）' : '先选择一个 bot' }}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        日报本质是 label 为 <Typography.Text code>group-summary:&lt;chatId&gt;</Typography.Text> 的周期任务
        （也会出现在「定时任务」页），调度改动即时生效、无需重启；日报内容由 bot 在对应群会话里
        用 lark-cli 拉取当天消息后生成并直接发群。忽略名单存于{' '}
        <Typography.Text code>~/.luckagent/group-summary.json</Typography.Text>。
      </Typography.Paragraph>

      <Modal
        title={editorTarget?.task ? `修改日报：${editorTarget?.name}` : `开启日报：${editorTarget?.name}`}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        onOk={submitEditor}
        confirmLoading={saving}
        okText={editorTarget?.task ? '保存' : '开启'}
        cancelText="取消"
        width={640}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="cronExpr"
            label="发送时间（cron 表达式）"
            rules={[{ required: true, message: '必填' }]}
            extra="默认工作日 21:00；时区取 .env 的 SCHEDULE_TIMEZONE"
          >
            <Input placeholder={DEFAULT_CRON} />
          </Form.Item>
          <Form.Item name="prompt" label="日报提示词模板" rules={[{ required: true, message: '必填' }]}>
            <Input.TextArea rows={8} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
