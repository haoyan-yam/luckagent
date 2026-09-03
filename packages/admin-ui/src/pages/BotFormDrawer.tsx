import { useEffect, useState } from 'react';
import {
  Button,
  Collapse,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Typography,
  message,
} from 'antd';
import { api } from '../api/client';
import type { BotEntry } from '../api/types';
import MemberPicker from '../components/MemberPicker';

const MASK_PREFIX = '••••';

/**
 * Create/edit form for one feishuBots entry.
 *
 * Secret-field contract (must match the backend):
 *  - On edit, secrets arrive masked ("••••1234"). Leaving the field untouched
 *    means "unchanged" — the key is REMOVED from the payload entirely (the
 *    server treats ''/null as "delete this key" and additionally strips any
 *    surviving mask, so a mask must never be sent as a value).
 *  - Typing a new value replaces the secret.
 */
export default function BotFormDrawer({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: string | null; // bot name when editing, null when creating
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) {
      void api.get<{ config: BotEntry }>(`/api/bots/${encodeURIComponent(editing)}`).then((r) => {
        const cfg = r.config || {};
        form.setFieldsValue({
          ...cfg,
          groupOnlyAllowUsers: cfg.groupOnlyAllowUsers || [],
        });
      });
    }
  }, [open, editing, form]);

  const isMasked = (v: unknown) => typeof v === 'string' && v.startsWith(MASK_PREFIX);

  // Non-secret top-level fields that may be CLEARED from the edit form.
  // In edit mode an empty value is sent as '' — the server's updateBot treats
  // '' as "delete this key", so clearing the whitelist / model override etc.
  // actually removes it from bots.json instead of being ignored.
  const CLEARABLE = [
    'description', 'model', 'maxTurns', 'maxBudgetUsd', 'budgetLimitDaily',
    'maxConcurrentTasks', 'downloadsDir', 'ttsVoice', 'groupOnlyAllowUsers',
  ];

  const isEmpty = (v: unknown) =>
    v === '' || v === undefined || v === null || (Array.isArray(v) && v.length === 0);

  const buildPayload = (values: Record<string, unknown>): Record<string, unknown> => {
    const payload: Record<string, unknown> = { ...values };
    if (Array.isArray(payload.groupOnlyAllowUsers)) {
      payload.groupOnlyAllowUsers = (payload.groupOnlyAllowUsers as string[])
        .map((s) => s.trim())
        .filter(Boolean);
    }
    // Never send masked/unchanged secrets or empty strings.
    const scrub = (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) {
        if (isMasked(v)) delete obj[k];
        else if (isEmpty(v)) delete obj[k];
        else if (v && typeof v === 'object' && !Array.isArray(v)) {
          scrub(v as Record<string, unknown>);
          if (Object.keys(v as object).length === 0) delete obj[k];
        }
      }
    };
    // Edit mode: record which clearable fields the user emptied BEFORE scrub
    // removes them, then re-add them as explicit '' delete-markers.
    const cleared = editing ? CLEARABLE.filter((k) => k in values && isEmpty(values[k])) : [];
    scrub(payload);
    for (const k of cleared) payload[k] = '';
    return payload;
  };

  const onSubmit = async () => {
    const values = await form.validateFields();
    const payload = buildPayload(values);
    setLoading(true);
    try {
      if (editing) {
        await api.put(`/api/bots/${encodeURIComponent(editing)}`, payload);
        message.success('已保存，重启桥接后生效');
      } else {
        const r = await api.post<{ skillsWarning?: string }>('/api/bots', { ...payload, platform: 'feishu', installSkills: true });
        if (r.skillsWarning) message.warning(r.skillsWarning, 8);
        message.success('机器人已创建（含工作目录/技能/模板），重启桥接后生效');
      }
      onSaved();
      onClose();
    } catch (err: any) {
      message.error(err?.message || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  const onTest = async () => {
    const appId = form.getFieldValue('feishuAppId');
    const appSecret = form.getFieldValue('feishuAppSecret');
    setTesting(true);
    try {
      const body =
        isMasked(appSecret) || !appSecret
          ? { botName: editing }
          : { appId, appSecret };
      const r = await api.post<{ ok: boolean; msg: string; feishuCode: number | null }>(
        '/admin/api/feishu/test-connection',
        body,
      );
      if (r.ok) message.success('凭证有效 ✓');
      else message.error(`验证失败：${r.msg}（code ${r.feishuCode ?? 'n/a'}）`);
    } catch (err: any) {
      message.error(err?.message || '测试失败');
    } finally {
      setTesting(false);
    }
  };

  const engine = Form.useWatch('engine', form) || 'claude';
  const botName = Form.useWatch('name', form);

  return (
    <Drawer
      title={editing ? `编辑机器人：${editing}` : '新建机器人'}
      width={520}
      open={open}
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={onTest} loading={testing}>
            测试连接
          </Button>
          <Button type="primary" onClick={onSubmit} loading={loading}>
            保存
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" initialValues={{}}>
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '必填' }, { pattern: /^[\w-]+$/, message: '仅限字母/数字/下划线/连字符' }]}
        >
          <Input disabled={!!editing} placeholder="my-bot" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input placeholder="这个 bot 是做什么的" />
        </Form.Item>
        <Form.Item
          name="feishuAppId"
          label="飞书 App ID"
          rules={editing ? [] : [{ required: true, message: '必填' }]}
        >
          <Input placeholder="cli_xxxxxxxxxxxxxxxx" />
        </Form.Item>
        <Form.Item
          name="feishuAppSecret"
          label={
            <span>
              飞书 App Secret{' '}
              {editing && <Typography.Text type="secondary">（留空 = 不修改）</Typography.Text>}
            </span>
          }
          rules={editing ? [] : [{ required: true, message: '必填' }]}
        >
          <Input.Password placeholder={editing ? '不修改请留空' : 'App Secret'} />
        </Form.Item>
        {editing ? (
          <Form.Item name="defaultWorkingDirectory" label="工作目录">
            <Input disabled />
          </Form.Item>
        ) : (
          <Form.Item label="工作目录">
            <Typography.Text type="secondary">
              自动创建：~/projects/{botName || '<名称>'}（含 inputs/ 附件目录与说明模板；技能走全局层）
            </Typography.Text>
          </Form.Item>
        )}
        {editing ? (
          <Form.Item name="engine" label="引擎（留空 = 用全局默认）">
            <Select
              allowClear
              options={[
                { value: 'claude', label: 'Claude Code' },
                { value: 'deepseek', label: 'DeepSeek' },
                { value: 'minimax', label: 'MiniMax' },
              ]}
            />
          </Form.Item>
        ) : (
          <Form.Item label="引擎">
            <Typography.Text type="secondary">使用安装时选定的全局默认引擎（建好后可在「编辑」里按 bot 调整）</Typography.Text>
          </Form.Item>
        )}

        {editing && engine === 'deepseek' && (
          <Collapse
            size="small"
            defaultActiveKey={['deepseek']}
            items={[
              {
                key: 'deepseek',
                forceRender: true,
                label: 'DeepSeek 引擎设置（无需装 CLI，只要 API key）',
                children: (
                  <>
                    <Form.Item name={['deepseek', 'apiKey']} label="API Key（留空 = 不修改/用全局 DEEPSEEK_API_KEY）">
                      <Input.Password placeholder="sk-..." />
                    </Form.Item>
                    <Form.Item name={['deepseek', 'model']} label="模型">
                      <Select
                        allowClear
                        placeholder="默认 deepseek-v4-flash"
                        options={[
                          { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash（快 · 便宜 · 默认）' },
                          { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro（更强推理）' },
                              ]}
                      />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />
        )}

        {editing && engine === 'minimax' && (
          <Collapse
            size="small"
            defaultActiveKey={['minimax']}
            items={[
              {
                key: 'minimax',
                forceRender: true,
                label: 'MiniMax 引擎设置（Anthropic 兼容端点，无需装 CLI）',
                children: (
                  <>
                    <Form.Item name={['minimax', 'apiKey']} label="API Key（留空 = 不修改/用全局 MINIMAX_API_KEY）">
                      <Input.Password placeholder="sk-cp-..." />
                    </Form.Item>
                    <Form.Item name={['minimax', 'model']} label="模型">
                      <Select
                        allowClear
                        placeholder="默认 MiniMax-M3"
                        options={[
                          { value: 'MiniMax-M3', label: 'MiniMax-M3（旗舰 · 原生看图 · 默认）' },
                          { value: 'MiniMax-M2.5', label: 'MiniMax-M2.5（上一代 · 更省）' },
                        ]}
                      />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />
        )}

        <Collapse
          size="small"
          style={{ marginTop: 16 }}
          items={[
            ...(editing ? [
            {
              key: 'limits',
              forceRender: true,
              label: '限制与预算（可选）',
              children: (
                <>
                  <Form.Item name="model" label="模型覆盖（Claude）">
                    <Input placeholder="留空用默认" />
                  </Form.Item>
                  <Form.Item name="maxTurns" label="单任务最大回合数">
                    <InputNumber min={1} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="maxBudgetUsd" label="单任务预算上限（美元）">
                    <InputNumber min={0} step={0.1} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="budgetLimitDaily" label="每日预算上限（美元）">
                    <InputNumber min={0} step={0.5} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="maxConcurrentTasks" label="最大并发任务数">
                    <InputNumber min={1} style={{ width: '100%' }} />
                  </Form.Item>
                </>
              ),
            }] : []),
            {
              key: 'group',
              forceRender: true,
              label: '群聊限制（可选）',
              children: (
                <>
                  <Form.Item name="groupOnly" label="仅群聊模式（私聊只允许白名单）" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                  <Form.Item name="groupOnlyAllowUsers" label="私聊白名单（按姓名选群成员，或粘贴 open_id）">
                    <MemberPicker botName={editing} />
                  </Form.Item>
                  <Form.Item name="groupNoMention" label="群里无需 @ 也响应" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                  <Form.Item
                    name="privateRequireMention"
                    label="私聊也需要 @ 才响应（两人群同）"
                    tooltip="开启后私聊里不 @ 机器人的消息静默忽略（图片/文件会暂存，下次 @ 时自动带上）；两人群不再视同私聊，按普通群规则处理"
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                </>
              ),
            },
            ...(editing ? [
            {
              key: 'paths',
              forceRender: true,
              label: '目录与语音（可选）',
              children: (
                <>
                  <Form.Item name="downloadsDir" label="附件下载目录" extra="聊天里发来的文件落在这里，持久保留">
                    <Input placeholder="留空 = 自动使用 <工作目录>/inputs" />
                  </Form.Item>
                  <Form.Item name="ttsVoice" label="TTS 音色">
                    <Input placeholder="留空用默认" />
                  </Form.Item>
                </>
              ),
            }] : []),
          ]}
        />
      </Form>
    </Drawer>
  );
}
