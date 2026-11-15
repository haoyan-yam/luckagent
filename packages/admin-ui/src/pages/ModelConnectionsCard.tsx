import { useEffect, useState } from 'react';
import { Alert, Button, Card, Collapse, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from 'antd';
import { api } from '../api/client';
import type { ModelConnectionInfo, ModelConnectionsResponse } from '../api/types';
import ClaudeAuthStatus from '../components/ClaudeAuthStatus';

export default function ModelConnectionsCard({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<ModelConnectionsResponse>();
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ModelConnectionInfo | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string>();
  const [defaultDraft, setDefaultDraft] = useState<string>();
  const [testResults, setTestResults] = useState<Record<string, { revision?: number; ok: boolean; message: string }>>({});
  const [form] = Form.useForm();
  const clearKey = Form.useWatch('clearApiKey', form);
  const load = async () => {
    try {
      const next = await api.get<ModelConnectionsResponse>('/admin/api/model-connections');
      setData(next);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30000);
    return () => window.clearInterval(timer);
  }, []);
  const changed = async () => { setTestResults({}); await load(); onChanged(); message.success('已保存，待通过顶部入口重启生效'); };
  const edit = (c: ModelConnectionInfo | null) => {
    form.resetFields();
    form.setFieldsValue(c
      ? { provider: c.provider || 'custom', name: c.name, baseUrl: c.baseUrl, model: c.model, disableNonessentialTraffic: c.disableNonessentialTraffic ?? false }
      : { provider: 'lmuai', name: '灵眸', baseUrl: 'https://api.lmuai.ai', disableNonessentialTraffic: false });
    setEditing(c);
  };
  const save = async () => {
    let values;
    try { values = await form.validateFields(); } catch { return; }
    setBusy(true);
    try {
      if (editing) await api.put(`/admin/api/model-connections/${editing.id}`, values);
      else await api.post('/admin/api/model-connections', values);
      setEditing(undefined); await changed();
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };
  const test = async (id: string) => {
    setTesting(id);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/admin/api/model-connections/${id}/test`);
      setTestResults(prev => ({ ...prev, [id]: { ...r, revision: data?.revision } }));
      if (r.ok) message.success(r.message); else message.error(r.message, 8);
    } catch (e) { message.error((e as Error).message); }
    finally { setTesting(undefined); }
  };
  const applyDefault = () => {
    if (!data || !defaultDraft || defaultDraft === data.defaultConnection) return;
    const name = defaultDraft === 'legacy' ? '兼容旧配置' : defaultDraft === 'local' ? '本机 Claude 登录' : data.connections.find(c => c.id === defaultDraft)?.name;
    Modal.confirm({ title: `将默认连接设为「${name}」？`,
      content: <Space direction="vertical"><Typography.Text>重启后将影响 {data.inheritedBots.length} 个继承默认连接的 bot：</Typography.Text><Typography.Text>{data.inheritedBots.join('、') || '无'}</Typography.Text><Typography.Text type="secondary">固定绑定其他连接的 bot 不受影响。保存不会立即切换运行中的连接。</Typography.Text></Space>,
      okText: '保存默认连接', cancelText: '取消', onOk: async () => {
        setBusy(true);
        try { await api.put('/admin/api/model-connections/default', { connection: defaultDraft }); setDefaultDraft(undefined); await changed(); }
        catch (e) { message.error((e as Error).message); throw e; }
        finally { setBusy(false); }
      },
    });
  };
  return <Card title="模型接入" extra={<Button type="primary" onClick={() => edit(null)} disabled={!data}>新增连接</Button>}>
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error && <Alert type="error" message={error} action={<Button onClick={() => void load()}>重试</Button>} />}
      <Typography.Text type="secondary">连接只保存一份，机器人可独立选择。Key 保存后不回显；测试连接会发送一条简短请求，产生少量费用。</Typography.Text>
      {!!data?.runtimeSummary?.length && <Space wrap>{data.runtimeSummary.map((item, i) => <Tag key={`${item.name}-${i}`} color="blue">{item.name}：{item.count} 个 bot</Tag>)}<Typography.Text type="secondary">当前运行接入</Typography.Text></Space>}
      <Space wrap>
        <span>默认模型连接</span>
        <Select style={{ minWidth: 260 }} value={defaultDraft ?? data?.defaultConnection} disabled={!data || busy}
          options={[
            { value: 'legacy', label: '兼容旧配置（保留原引擎与认证）' },
            { value: 'local', label: '本机 Claude 登录（官方端点）' },
            ...(data?.connections || []).map(c => ({ value: c.id, label: `${c.name}${c.hasApiKey ? '' : '（未填 Key）'}` })),
          ]}
          onChange={setDefaultDraft} />
        <Button type="primary" disabled={!data || !defaultDraft || defaultDraft === data.defaultConnection || busy} onClick={applyDefault}>保存默认连接</Button>
        {defaultDraft && defaultDraft !== data?.defaultConnection && <Button onClick={() => setDefaultDraft(undefined)}>撤销选择</Button>}
      </Space>
      <Typography.Text type="secondary">默认连接变更将在重启后影响 {data?.inheritedBots.length ?? '—'} 个 bot。查看影响范围后再保存。</Typography.Text>
      {data?.configDirty && <Alert type="warning" message="存在已保存、待重启的配置。下方同时列出已保存的绑定和当前运行的绑定，请使用顶部统一重启入口。" />}
      <Card size="small" title="本机 Claude 登录" extra={<Tag>内置接入</Tag>}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <ClaudeAuthStatus a={data?.claudeAuth} />
          <Typography.Text type="secondary">以 Claude CLI 的认证查询结果为准，每分钟更新；查询不会发送模型请求。</Typography.Text>
          <Typography.Text strong>运行中使用本机登录（{data?.localLoginUsage?.runningBots?.length ?? '—'} 个）：{(data?.localLoginUsage?.runningBots?.join('、') ?? '状态未获取') || '无'}</Typography.Text>
          <Collapse size="small" items={[{ key: 'bindings', label: '查看绑定来源与兼容详情', children: <Space direction="vertical">
            <Typography.Text>通过旧配置使用本机账号：{data?.localLoginUsage?.inheritedLoginBots?.length ?? '—'} 个 bot。</Typography.Text>
            <Typography.Text>已保存配置中明确绑定此接入（含继承全局默认）：{data?.localLoginUsage ? data.localLoginUsage.configuredBots.join('、') || '无' : '状态未获取'}</Typography.Text>
            <Typography.Text type="secondary">这些信息用于解释配置来源，不改变当前接入。运行列表不包含会话中的临时模型切换。</Typography.Text>
          </Space> }]} />
          {!!data?.localLoginUsage?.legacyClaudeBots?.length && <>
            <Typography.Text>沿用旧环境、未确认为此账号：{data.localLoginUsage.legacyClaudeBots.join('、')}</Typography.Text>
            <Typography.Text type="secondary">这些 bot 的 CLI 查询失败、未登录，或使用其他账号及认证方式，因此未计入本机登录列表。</Typography.Text>
          </>}
        </Space>
      </Card>
      <Table<ModelConnectionInfo> rowKey="id" size="small" pagination={false} dataSource={data?.connections || []} scroll={{ x: 1200 }} locale={{ emptyText: '尚未添加连接，点击「新增连接」配置灵眸或其他兼容服务' }} columns={[
        { title: '连接', dataIndex: 'name' },
        { title: '服务商', render: (_, c) => `${data?.presets?.find(p => p.provider === (c.provider || c.displayProvider))?.name || '自定义兼容接口'}${!c.provider && c.displayProvider !== 'custom' ? '（按地址识别）' : ''}` },
        { title: '接口地址', dataIndex: 'baseUrl' },
        { title: '默认模型', dataIndex: 'model' },
        { title: 'Key', render: (_, c) => <Tag color={c.hasApiKey ? 'green' : 'orange'}>{c.hasApiKey ? '已配置' : '未配置'}</Tag> },
        { title: '禁用非必要流量', render: (_, c) => <Tag color={c.disableNonessentialTraffic ? 'blue' : undefined}>{c.disableNonessentialTraffic ? '开启' : '关闭'}</Tag> },
        { title: '已保存绑定', render: (_, c) => c.affectedBots.join('、') || '未绑定' },
        { title: '当前运行', render: (_, c) => (c.runningBots?.join('、') ?? '状态未获取') || '未使用' },
        { title: '调用验证', render: (_, c) => { const result = testResults[c.id]; return result && result.revision === data?.revision ? <Tag color={result.ok ? 'green' : 'red'} title={result.message}>{result.ok ? '本次测试通过' : '本次测试失败'}</Tag> : <Tag>未测试</Tag>; } },
        { title: '操作', render: (_, c) => <Space>
          <Button size="small" onClick={() => edit(c)}>编辑</Button>
          <Button size="small" disabled={!c.hasApiKey || !!testing} loading={testing === c.id} onClick={() => void test(c.id)}>测试连接</Button>
          <Popconfirm title="删除此连接？" onConfirm={async () => {
            try { await api.del(`/admin/api/model-connections/${c.id}`); await changed(); }
            catch (e) { message.error((e as Error).message); }
          }}><Button size="small" danger>删除</Button></Popconfirm>
        </Space> },
      ]} />
      {!!data?.legacyConnections?.length && <Collapse items={[{
        key: 'legacy', label: '旧配置兼容与复制（高级）', children: <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">旧配置继续生效。复制会在本机保留 Key 并新建独立连接，不改变任何 bot 的接入方式；之后可在机器人编辑页选择新连接。复制后两份配置独立维护。</Typography.Text>
          {data.legacyConnections.map(c => <Space key={c.source} wrap>
            <span>{c.name} · {c.model} · {c.hasApiKey ? 'Key 已配置' : '未配置 Key'}</span>
            <Button size="small" disabled={!!c.importedId || busy} onClick={async () => {
              setBusy(true);
              try { await api.post('/admin/api/model-connections/import', { source: c.source }); await changed(); }
              catch (e) { message.error((e as Error).message); }
              finally { setBusy(false); }
            }}>{c.importedId ? '已复制为连接' : '复制为独立连接'}</Button>
          </Space>)}
        </Space>,
      }]} />}
    </Space>
    <Modal title={editing ? '编辑模型连接' : '新增模型连接'} open={editing !== undefined} onCancel={() => setEditing(undefined)} onOk={() => void save()} confirmLoading={busy} okText="保存" cancelText="取消" destroyOnHidden>
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="provider" label="服务商" rules={[{ required: true }]} extra={editing ? '如需更换服务商，请新增连接后切换机器人。' : '选择后预填接口地址和默认模型，可按账号权限调整。'}>
          <Select disabled={!!editing} options={data?.presets?.map(p => ({ value: p.provider, label: p.name }))} onChange={provider => {
            const preset = data?.presets?.find(p => p.provider === provider);
            if (preset) form.setFieldsValue({ name: preset.name, baseUrl: preset.baseUrl, model: preset.model, apiKey: '' });
          }} />
        </Form.Item>
        <Form.Item name="name" label="连接名称" rules={[{ required: true }, { max: 80 }]}><Input placeholder="例如：灵眸" /></Form.Item>
        <Form.Item name="baseUrl" label="接口地址（Base URL）" rules={[{ required: true }, { type: 'url' }]} extra="填写服务商的 Anthropic Base URL，例如 https://api.lmuai.ai，不要填写 /v1/messages。"><Input /></Form.Item>
        <Form.Item name="model" label="默认模型 ID" rules={[{ required: true }]} extra="填写此 Key 可用的准确模型 ID；机器人可以单独覆盖。"><Input placeholder="从服务商的可用模型列表复制" /></Form.Item>
        <Form.Item name="apiKey" label={editing?.hasApiKey ? '替换 API Key（留空保留原值）' : 'API Key（也可保存后再填）'}><Input.Password disabled={clearKey} autoComplete="new-password" /></Form.Item>
        {editing?.hasApiKey && <Form.Item name="clearApiKey" label="清除已保存的 Key" valuePropName="checked"><Switch /></Form.Item>}
        <Form.Item name="disableNonessentialTraffic" label="禁用非必要流量" valuePropName="checked"
          extra="默认关闭。开启后禁用自动更新、遥测、错误上报等，也可能影响部分 Claude 功能。仅作用于使用此连接的 bot，重启桥接后生效。">
          <Switch checkedChildren="开启" unCheckedChildren="关闭" />
        </Form.Item>
        {editing && <Alert type="info" message={`保存后将影响：${editing.affectedBots.join('、') || '目前没有 bot 使用此连接'}。重启后生效。`} />}
      </Form>
    </Modal>
  </Card>;
}
