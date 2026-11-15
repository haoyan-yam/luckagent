import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from 'antd';
import { api } from '../api/client';
import type { ModelConnectionInfo, ModelConnectionsResponse } from '../api/types';

export default function ModelConnectionsCard({ onRestart }: { onRestart: () => void }) {
  const [data, setData] = useState<ModelConnectionsResponse>();
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ModelConnectionInfo | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string>();
  const [pending, setPending] = useState(false);
  const [form] = Form.useForm();
  const clearKey = Form.useWatch('clearApiKey', form);
  const load = async () => {
    try { setData(await api.get<ModelConnectionsResponse>('/admin/api/model-connections')); setError(''); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);
  const changed = async () => { setPending(true); await load(); message.success('已保存，重启桥接后生效'); };
  const edit = (c: ModelConnectionInfo | null) => {
    form.resetFields();
    form.setFieldsValue(c
      ? { name: c.name, baseUrl: c.baseUrl, model: c.model, disableNonessentialTraffic: c.disableNonessentialTraffic ?? false }
      : { name: '灵眸', baseUrl: 'https://api.lmuai.ai', disableNonessentialTraffic: false });
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
      if (r.ok) message.success(r.message); else message.error(r.message, 8);
    } catch (e) { message.error((e as Error).message); }
    finally { setTesting(undefined); }
  };
  return <Card title="模型接入（Claude / Anthropic 兼容）" extra={<Button type="primary" onClick={() => edit(null)} disabled={!data}>新增连接</Button>}>
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error && <Alert type="error" message={error} action={<Button onClick={() => void load()}>重试</Button>} />}
      <Typography.Text type="secondary">连接只保存一份，机器人可独立选择。Key 保存后不回显；测试连接会发送一条简短请求，产生少量费用。</Typography.Text>
      <Space wrap>
        <span>Claude 全局默认连接</span>
        <Select style={{ minWidth: 260 }} value={data?.defaultConnection} disabled={!data || busy}
          options={[
            { value: 'legacy', label: '沿用现有环境 / Claude 配置' },
            { value: 'local', label: '本机 Claude 登录（官方端点）' },
            ...(data?.connections || []).map(c => ({ value: c.id, label: `${c.name}${c.hasApiKey ? '' : '（未填 Key）'}` })),
          ]}
          onChange={async connection => {
            setBusy(true);
            try { await api.put('/admin/api/model-connections/default', { connection }); await changed(); }
            catch (e) { message.error((e as Error).message); }
            finally { setBusy(false); }
          }} />
      </Space>
      <Typography.Text type="secondary">继承默认的 Claude bot：{data?.inheritedBots.join('、') || '无'}</Typography.Text>
      {pending && <Alert type="warning" message="配置已保存，待重启生效。重启桥接会中断正在执行的任务。" action={<Button onClick={onRestart}>重启桥接</Button>} />}
      <Table<ModelConnectionInfo> rowKey="id" size="small" pagination={false} dataSource={data?.connections || []} scroll={{ x: 850 }} locale={{ emptyText: '尚未添加连接，点击「新增连接」配置灵眸或其他兼容服务' }} columns={[
        { title: '连接', dataIndex: 'name' },
        { title: '接口地址', dataIndex: 'baseUrl' },
        { title: '默认模型', dataIndex: 'model' },
        { title: 'Key', render: (_, c) => <Tag color={c.hasApiKey ? 'green' : 'orange'}>{c.hasApiKey ? '已配置' : '未配置'}</Tag> },
        { title: '禁用非必要流量', render: (_, c) => <Tag color={c.disableNonessentialTraffic ? 'blue' : undefined}>{c.disableNonessentialTraffic ? '开启' : '关闭'}</Tag> },
        { title: '影响的 Claude bot', render: (_, c) => c.affectedBots.join('、') || '无' },
        { title: '操作', render: (_, c) => <Space>
          <Button size="small" onClick={() => edit(c)}>编辑</Button>
          <Button size="small" disabled={!c.hasApiKey || !!testing} loading={testing === c.id} onClick={() => void test(c.id)}>测试连接</Button>
          <Popconfirm title="删除此连接？" onConfirm={async () => {
            try { await api.del(`/admin/api/model-connections/${c.id}`); await changed(); }
            catch (e) { message.error((e as Error).message); }
          }}><Button size="small" danger>删除</Button></Popconfirm>
        </Space> },
      ]} />
    </Space>
    <Modal title={editing ? '编辑模型连接' : '新增模型连接'} open={editing !== undefined} onCancel={() => setEditing(undefined)} onOk={() => void save()} confirmLoading={busy} okText="保存" cancelText="取消" destroyOnHidden>
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="name" label="连接名称" rules={[{ required: true }, { max: 80 }]}><Input placeholder="例如：灵眸" /></Form.Item>
        <Form.Item name="baseUrl" label="接口地址（Base URL）" rules={[{ required: true }, { type: 'url' }]} extra="填写服务商的 Anthropic Base URL，例如 https://api.lmuai.ai，不要填写 /v1/messages。"><Input /></Form.Item>
        <Form.Item name="model" label="默认模型 ID" rules={[{ required: true }]} extra="填写此 Key 可用的准确模型 ID；机器人可以单独覆盖。"><Input placeholder="从服务商的可用模型列表复制" /></Form.Item>
        <Form.Item name="apiKey" label={editing?.hasApiKey ? '替换 API Key（留空保留原值）' : 'API Key（也可保存后再填）'}><Input.Password disabled={clearKey} autoComplete="new-password" /></Form.Item>
        {editing?.hasApiKey && <Form.Item name="clearApiKey" label="清除已保存的 Key" valuePropName="checked"><Switch /></Form.Item>}
        <Form.Item name="disableNonessentialTraffic" label="禁用非必要流量" valuePropName="checked"
          extra="默认关闭。开启后禁用自动更新、遥测、错误上报等，也可能影响部分 Claude 功能。仅作用于使用此连接的 bot，重启桥接后生效。">
          <Switch checkedChildren="开启" unCheckedChildren="关闭" />
        </Form.Item>
        {editing && <Alert type="info" message={`保存后将影响：${editing.affectedBots.join('、') || '目前没有 Claude bot 使用此连接'}。重启后生效。`} />}
      </Form>
    </Modal>
  </Card>;
}
