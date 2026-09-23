import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Modal, Radio, Select, Space, Tag, Typography, message } from 'antd';
import { api } from '../api/client';
import type { CodexProbe, ConfigDefaults, DefaultValue } from '../api/types';

type Key = keyof ConfigDefaults['values'];

interface FormValues {
  LUCKAGENT_ENGINE: string;
  claudeMode: 'follow' | 'custom';
  CLAUDE_MODEL: string;
  // undefined (not '') so the Select shows its "默认 …" placeholder
  DEEPSEEK_MODEL?: string;
  MINIMAX_MODEL?: string;
  IMAGE_GEN_PROVIDER: string;
}

const ENGINE_LABEL: Record<string, string> = { claude: 'Claude Code', deepseek: 'DeepSeek', minimax: 'MiniMax' };
const IMAGE_GEN_LABEL: Record<string, string> = { '': '自动（Codex 优先）', codex: 'Codex（ChatGPT 订阅）', seedream: '火山 Seedream' };

function toForm(d: ConfigDefaults): FormValues {
  const v = d.values;
  return {
    LUCKAGENT_ENGINE: v.LUCKAGENT_ENGINE.disk || 'claude',
    claudeMode: v.CLAUDE_MODEL.disk ? 'custom' : 'follow',
    CLAUDE_MODEL: v.CLAUDE_MODEL.disk,
    DEEPSEEK_MODEL: v.DEEPSEEK_MODEL.disk || undefined,
    MINIMAX_MODEL: v.MINIMAX_MODEL.disk || undefined,
    IMAGE_GEN_PROVIDER: v.IMAGE_GEN_PROVIDER.disk,
  };
}

/** Form → the .env values to write ('' = unset). */
function toEnv(f: FormValues): Record<Key, string> {
  return {
    LUCKAGENT_ENGINE: f.LUCKAGENT_ENGINE === 'claude' ? '' : f.LUCKAGENT_ENGINE,
    CLAUDE_MODEL: f.claudeMode === 'follow' ? '' : (f.CLAUDE_MODEL || '').trim(),
    DEEPSEEK_MODEL: f.DEEPSEEK_MODEL || '',
    MINIMAX_MODEL: f.MINIMAX_MODEL || '',
    IMAGE_GEN_PROVIDER: f.IMAGE_GEN_PROVIDER || '',
  };
}

/** Pending-restart / locked hints under each field. */
function FieldState({ v, fmt }: { v?: DefaultValue; fmt: (s: string) => string }) {
  if (!v) return null;
  if (v.lockedByProcessEnv)
    return <Tag color="red">由进程环境变量固定（{fmt(v.live)}），改 .env 不会生效</Tag>;
  // compare what each value means (unset vs explicit default read the same)
  if (fmt(v.disk) !== fmt(v.live))
    return <Tag color="orange">已保存，重启桥接后生效（当前运行：{fmt(v.live)}）</Tag>;
  return null;
}

export default function DefaultsCard({ onRestart }: { onRestart: () => void }) {
  const [form] = Form.useForm<FormValues>();
  const [data, setData] = useState<ConfigDefaults | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<CodexProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const claudeMode = Form.useWatch('claudeMode', form);

  const load = useCallback(async () => {
    try {
      const d = await api.get<ConfigDefaults>('/admin/api/config/defaults');
      setData(d);
      setLoadError(null);
      form.setFieldsValue(toForm(d));
    } catch (err: any) {
      setLoadError(err?.message || '读取失败');
    }
  }, [form]);

  useEffect(() => {
    void load();
  }, [load]);

  const runProbe = useCallback(async () => {
    setProbing(true);
    try {
      setProbe(await api.get<CodexProbe>('/admin/api/image-gen/probe'));
    } catch (err: any) {
      message.error(err?.message || '检测失败');
    } finally {
      setProbing(false);
    }
  }, []);

  const onSave = useCallback(async () => {
    if (!data) return;
    const values = await form.validateFields();
    const next = toEnv(values);
    const changed: Partial<Record<Key, string>> = {};
    // LUCKAGENT_ENGINE: unset and "claude" mean the same thing — don't count it as a change
    const norm = (k: Key, s: string) => (k === 'LUCKAGENT_ENGINE' && s === 'claude' ? '' : s);
    for (const k of Object.keys(next) as Key[]) {
      if (norm(k, next[k]) !== norm(k, data.values[k].disk)) changed[k] = next[k];
    }
    if (Object.keys(changed).length === 0) {
      message.info('没有改动');
      return;
    }
    setSaving(true);
    try {
      const r = await api.put<{ saved: string[]; runningTasks: number }>('/admin/api/config/defaults', changed);
      await load();
      Modal.confirm({
        title: '已写入 .env，需要重启桥接才能生效',
        content:
          r.runningTasks > 0
            ? `当前有 ${r.runningTasks} 个任务正在运行，重启会中断它们。现在重启吗？`
            : '当前没有任务在运行。现在重启吗？',
        okText: '立即重启',
        okButtonProps: { danger: r.runningTasks > 0 },
        cancelText: '稍后手动重启',
        onOk: onRestart,
      });
    } catch (err: any) {
      message.error(err?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }, [data, form, load, onRestart]);

  const v = data?.values;
  const ig = data?.imageGen;
  const orDefault = (fallback: string) => (s: string) => s || fallback;
  const codexInstalled = probe ? probe.installed : ig?.codexInstalled;
  const codexLoggedIn = probe ? probe.loggedIn : ig?.codexLoggedIn;

  return (
    <Card
      title="默认设置"
      extra={
        <Button type="primary" loading={saving} disabled={!data} onClick={onSave}>
          保存
        </Button>
      }
    >
      {loadError && <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} />}
      <Typography.Paragraph type="secondary">
        全机默认值，写入 .env，重启桥接后生效。单个机器人在「机器人管理 → 编辑」里单独设置的引擎 / 模型优先于这里。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" style={{ maxWidth: 560 }}>
        <Form.Item label="默认引擎" extra={<FieldState v={v?.LUCKAGENT_ENGINE} fmt={(s) => ENGINE_LABEL[s || 'claude']} />}>
          <Form.Item name="LUCKAGENT_ENGINE" noStyle>
            <Select options={Object.entries(ENGINE_LABEL).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
        </Form.Item>

        <Form.Item
          label="Claude 默认模型"
          extra={
            <Space direction="vertical" size={4}>
              <FieldState v={v?.CLAUDE_MODEL} fmt={orDefault('跟随订阅档位')} />
              {data?.anthropicModel && (
                <Tag color="orange">选「跟随订阅」时实际会用 ANTHROPIC_MODEL={data.anthropicModel}</Tag>
              )}
            </Space>
          }
        >
          <Form.Item name="claudeMode" noStyle>
            <Radio.Group>
              <Radio value="follow">跟随订阅档位（推荐）</Radio>
              <Radio value="custom">指定模型</Radio>
            </Radio.Group>
          </Form.Item>
          {claudeMode === 'custom' && (
            <Form.Item
              name="CLAUDE_MODEL"
              style={{ marginTop: 8, marginBottom: 0 }}
              rules={[
                { required: true, message: '填写模型 ID' },
                { pattern: /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/, message: '模型 ID 只能含字母、数字和 . _ : / [ ] -' },
              ]}
            >
              <Input placeholder="模型 ID，例如 claude-opus-5（超出订阅档位的会被服务端静默降级）" />
            </Form.Item>
          )}
        </Form.Item>

        <Form.Item
          label="DeepSeek 默认模型"
          extra={<FieldState v={v?.DEEPSEEK_MODEL} fmt={orDefault(data?.options.deepseek.defaultModel ?? '默认')} />}
        >
          <Form.Item name="DEEPSEEK_MODEL" noStyle>
            <Select
              allowClear
              placeholder={`默认 ${data?.options.deepseek.defaultModel ?? ''}`}
              options={data?.options.deepseek.models.map((m) => ({ value: m.id, label: `${m.id}（${m.note}）` }))}
            />
          </Form.Item>
        </Form.Item>

        <Form.Item
          label="MiniMax 默认模型"
          extra={<FieldState v={v?.MINIMAX_MODEL} fmt={orDefault(data?.options.minimax.defaultModel ?? '默认')} />}
        >
          <Form.Item name="MINIMAX_MODEL" noStyle>
            <Select
              allowClear
              placeholder={`默认 ${data?.options.minimax.defaultModel ?? ''}`}
              options={data?.options.minimax.models.map((m) => ({ value: m.id, label: `${m.id}（${m.note}）` }))}
            />
          </Form.Item>
        </Form.Item>

        <Form.Item
          label="生图后端"
          extra={
            <Space direction="vertical" size={4}>
              <FieldState v={v?.IMAGE_GEN_PROVIDER} fmt={(s) => IMAGE_GEN_LABEL[s] ?? s} />
              <Space size={4} wrap>
                <Tag color={codexLoggedIn ? 'green' : 'orange'}>
                  {!codexInstalled ? '未装 Codex' : codexLoggedIn ? 'Codex 已登录' : 'Codex 未登录'}
                  {probe?.version ? ` · ${probe.version}` : ''}
                </Tag>
                <Tag color={ig?.hasArkApiKey ? 'green' : 'default'}>{ig?.hasArkApiKey ? '已配火山 key' : '未配火山 key'}</Tag>
                <Button size="small" loading={probing} onClick={runProbe}>
                  重新检测
                </Button>
              </Space>
              {!codexLoggedIn && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  用 Codex 需在这台 Mac 的终端执行 <Typography.Text code>npm i -g @openai/codex</Typography.Text>（已装可跳过）和{' '}
                  <Typography.Text code>codex login</Typography.Text>，登录后点「重新检测」。
                </Typography.Text>
              )}
            </Space>
          }
        >
          <Form.Item name="IMAGE_GEN_PROVIDER" noStyle>
            <Select options={Object.entries(IMAGE_GEN_LABEL).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
        </Form.Item>
      </Form>
    </Card>
  );
}
