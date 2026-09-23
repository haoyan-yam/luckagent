import { useCallback, useEffect, useState } from 'react';
import { Alert, AutoComplete, Button, Card, Divider, Form, Input, Modal, Radio, Select, Space, Tag, Typography, message } from 'antd';
import { api } from '../api/client';
import type { CodexProbe, ConfigDefaults, DefaultValue } from '../api/types';

type Key = keyof ConfigDefaults['values'];

/** Write-only on the server too: the form starts empty, only typed values (or an explicit clear) are sent. */
const SECRET_KEYS = ['ARK_API_KEY', 'TOS_ACCESS_KEY', 'TOS_SECRET_KEY'] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

const TOS_REGIONS = ['cn-beijing', 'cn-shanghai', 'cn-guangzhou', 'cn-hongkong', 'ap-southeast-1'];

interface FormValues {
  LUCKAGENT_ENGINE: string;
  claudeMode: 'follow' | 'custom';
  CLAUDE_MODEL: string;
  // undefined (not '') so the Select shows its "默认 …" placeholder
  DEEPSEEK_MODEL?: string;
  MINIMAX_MODEL?: string;
  IMAGE_GEN_PROVIDER: string;
  TOS_BUCKET?: string;
  TOS_REGION?: string;
  ARK_API_KEY?: string;
  TOS_ACCESS_KEY?: string;
  TOS_SECRET_KEY?: string;
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
    TOS_BUCKET: v.TOS_BUCKET.disk,
    TOS_REGION: v.TOS_REGION.disk || undefined,
    ARK_API_KEY: '',
    TOS_ACCESS_KEY: '',
    TOS_SECRET_KEY: '',
  };
}

/** Form → the plain (non-secret) .env values to write ('' = unset). */
function toEnv(f: FormValues): Partial<Record<Key, string>> {
  return {
    LUCKAGENT_ENGINE: f.LUCKAGENT_ENGINE === 'claude' ? '' : f.LUCKAGENT_ENGINE,
    CLAUDE_MODEL: f.claudeMode === 'follow' ? '' : (f.CLAUDE_MODEL || '').trim(),
    DEEPSEEK_MODEL: f.DEEPSEEK_MODEL || '',
    MINIMAX_MODEL: f.MINIMAX_MODEL || '',
    IMAGE_GEN_PROVIDER: f.IMAGE_GEN_PROVIDER || '',
    TOS_BUCKET: (f.TOS_BUCKET || '').trim(),
    TOS_REGION: (f.TOS_REGION || '').trim(),
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
  const [cleared, setCleared] = useState<Set<SecretKey>>(new Set());
  const [tosProbe, setTosProbe] = useState<{ ok: boolean; message: string } | null>(null);
  const [tosProbing, setTosProbing] = useState(false);
  const claudeMode = Form.useWatch('claudeMode', form);

  const load = useCallback(async () => {
    try {
      const d = await api.get<ConfigDefaults>('/admin/api/config/defaults');
      setData(d);
      setLoadError(null);
      setCleared(new Set());
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

  const runTosProbe = useCallback(async () => {
    setTosProbing(true);
    try {
      setTosProbe(await api.post<{ ok: boolean; message: string }>('/admin/api/video-gen/tos-probe'));
    } catch (err: any) {
      message.error(err?.message || '测试失败');
    } finally {
      setTosProbing(false);
    }
  }, []);

  const toggleClear = useCallback((k: SecretKey) => {
    setCleared((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const onSave = useCallback(async () => {
    if (!data) return;
    const values = await form.validateFields();
    const next = toEnv(values);
    const changed: Partial<Record<Key, string>> = {};
    // LUCKAGENT_ENGINE: unset and "claude" mean the same thing — don't count it as a change
    const norm = (k: Key, s: string) => (k === 'LUCKAGENT_ENGINE' && s === 'claude' ? '' : s);
    for (const k of Object.keys(next) as Key[]) {
      if (norm(k, next[k] ?? '') !== norm(k, data.values[k].disk)) changed[k] = next[k] ?? '';
    }
    // secrets: send only what was typed, or an explicit clear — never the (masked) current value
    for (const k of SECRET_KEYS) {
      const typed = (values[k] || '').trim();
      if (typed) changed[k] = typed;
      else if (cleared.has(k)) changed[k] = '';
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
  }, [cleared, data, form, load, onRestart]);

  const v = data?.values;
  const ig = data?.imageGen;
  const vg = data?.videoGen;

  /** Write-only secret input: empty = keep; typed = replace; 「清除」 = unset. */
  const secretItem = (k: SecretKey, label: string, hint: string) => {
    const current = v?.[k];
    const isCleared = cleared.has(k);
    const placeholder = isCleared
      ? '保存后清除'
      : current?.disk
        ? `已配置 ${current.disk}（留空 = 不修改）`
        : '未配置';
    return (
      <Form.Item
        label={label}
        extra={
          <Space direction="vertical" size={4}>
            {hint && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {hint}
              </Typography.Text>
            )}
            <FieldState v={current} fmt={orDefault('未配置')} />
          </Space>
        }
      >
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name={k} noStyle>
            <Input.Password placeholder={placeholder} autoComplete="new-password" disabled={isCleared} />
          </Form.Item>
          {current?.disk && (
            <Button onClick={() => toggleClear(k)} danger={!isCleared}>
              {isCleared ? '撤销清除' : '清除'}
            </Button>
          )}
        </Space.Compact>
      </Form.Item>
    );
  };
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

        <Divider orientation="left" plain>
          视频生成（Seedance）
        </Divider>
        <Space size={4} wrap style={{ marginBottom: 12 }}>
          <Tag color={vg?.hasArkApiKey ? 'green' : 'orange'}>{vg?.hasArkApiKey ? '视频生成已开通' : '视频生成未开通（缺火山方舟 key）'}</Tag>
          <Tag color={vg?.tosConfigured ? 'green' : 'default'}>
            {vg?.tosConfigured ? '可参考本地视频 / 音频（TOS 已配置）' : '参考本地视频 / 音频需配 TOS（可选）'}
          </Tag>
        </Space>
        {secretItem('ARK_API_KEY', '火山方舟 key（ARK_API_KEY）', '视频生成必需；火山 Seedream 生图也用这把 key。还需在方舟控制台开通 Doubao-Seedance / Doubao-Seedream 模型。')}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          TOS 只在「用群里发的视频 / 音频当参考素材」时需要：本地文件先传到 TOS 换临时链接，生成结束后自动删除。
          建议用只授权这个桶读写删的子用户 AK/SK（主账号 AK/SK 权限过大）。
        </Typography.Paragraph>
        {secretItem('TOS_ACCESS_KEY', 'TOS Access Key', '')}
        {secretItem('TOS_SECRET_KEY', 'TOS Secret Key', '')}
        <Form.Item
          label="TOS 桶名"
          extra={<FieldState v={v?.TOS_BUCKET} fmt={orDefault('未配置')} />}
          name="TOS_BUCKET"
          rules={[{ pattern: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, message: '桶名为 3–63 位小写字母、数字或 -' }]}
        >
          <Input placeholder="例如 team-seedance-refs" />
        </Form.Item>
        <Form.Item label="TOS 地域" extra={<FieldState v={v?.TOS_REGION} fmt={orDefault('cn-beijing')} />} name="TOS_REGION">
          <AutoComplete placeholder="默认 cn-beijing" options={TOS_REGIONS.map((r) => ({ value: r }))} />
        </Form.Item>
        <Space direction="vertical" size={4}>
          <Space size={8} wrap>
            <Button size="small" loading={tosProbing} disabled={!vg?.tosConfigured} onClick={runTosProbe}>
              测试 TOS
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              测试的是已保存的配置（上传一个小文件再删除），改完先点「保存」
            </Typography.Text>
          </Space>
          {tosProbe && <Alert type={tosProbe.ok ? 'success' : 'error'} showIcon message={tosProbe.message} />}
        </Space>
      </Form>
    </Card>
  );
}
