import { Alert, Card, Collapse, Descriptions, Space, Table, Tag, Typography } from 'antd';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { EffectiveConfig, Pm2Proc } from '../api/types';
import DefaultsCard from './DefaultsCard';
import ModelConnectionsCard from './ModelConnectionsCard';

function SecretHint({ v }: { v?: { set: boolean; tail?: string; pending?: boolean; botLevel?: number } }) {
  if (!v) return <Tag>状态未获取</Tag>;
  return <Space size={4} wrap>
    <Tag color={v.pending ? 'orange' : v.set ? 'green' : undefined}>
      {v.pending ? '已保存，待重启生效' : v.set ? '已配置' : '未配置'}{v.tail ? `（••••${v.tail}）` : ''}
    </Tag>
    {!!v.botLevel && <Typography.Text type="secondary">另有 {v.botLevel} 个 bot 保存了独立凭证</Typography.Text>}
  </Space>;
}

function fmtUptime(ms: number | null): string {
  if (ms === null) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时`;
  return `${Math.floor(sec / 86400)} 天`;
}

export default function ConfigPage({ onChanged }: { onChanged: () => void }) {
  const { data: cfg, error: configError } = usePoll<EffectiveConfig>(() => api.get('/admin/api/config'), 30000);
  const { data: pm2, error: pm2Error } = usePoll<{ available: boolean; apps?: Pm2Proc[] }>(() => api.get('/admin/api/pm2'), 15000);
  const pm2Columns = [
    { title: '进程', dataIndex: 'name', key: 'name' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (v: string) => <Tag color={v === 'online' ? 'green' : 'orange'}>{v === 'online' ? '在线' : v}</Tag> },
    { title: 'PID', dataIndex: 'pid', key: 'pid', render: (v: number | null) => v ?? '—' },
    { title: '重启次数', dataIndex: 'restarts', key: 'restarts' },
    { title: '运行时长', dataIndex: 'uptimeMs', key: 'uptime', render: fmtUptime },
    { title: '内存', dataIndex: 'memoryMb', key: 'mem', render: (v: number | null) => v != null ? `${v} MB` : '—' },
    { title: 'CPU', dataIndex: 'cpu', key: 'cpu', render: (v: number | null) => v != null ? `${v}%` : '—' },
  ];

  return <Space direction="vertical" size="large" style={{ width: '100%' }}>
    <ModelConnectionsCard onChanged={onChanged} />
    <DefaultsCard onChanged={onChanged} />
    {configError && <Alert type="error" message="运行环境与凭证状态更新失败" description="下方可能保留上次数据，请等待重新连接。" />}
    <Card title="其他服务凭证" loading={!cfg && !configError}>
      <Typography.Paragraph type="secondary">这里只显示配置状态，不代表服务已通过调用测试。聊天模型、生图与视频凭证在各自区域管理。</Typography.Paragraph>
      <Descriptions column={2} bordered size="small">
        <Descriptions.Item label="后台访问凭证"><SecretHint v={cfg?.credentials.apiSecret} /></Descriptions.Item>
        <Descriptions.Item label="core 服务凭证"><SecretHint v={cfg?.credentials.coreToken} /></Descriptions.Item>
        <Descriptions.Item label="OpenAI API"><SecretHint v={cfg?.credentials.openaiApiKey} /></Descriptions.Item>
        <Descriptions.Item label="火山语音"><SecretHint v={cfg?.credentials.volcengineTts} /></Descriptions.Item>
        <Descriptions.Item label="ElevenLabs 语音"><SecretHint v={cfg?.credentials.elevenlabs} /></Descriptions.Item>
      </Descriptions>
    </Card>
    <Collapse items={[{ key: 'advanced', label: '高级信息：运行环境、旧配置与进程', children: <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title="运行环境（只读）" size="small">
        <Descriptions column={2} bordered size="small">
          <Descriptions.Item label="API 端口">{cfg?.ports.apiPort ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="绑定地址">{cfg?.ports.apiHost ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="core 地址">{cfg?.ports.coreUrl ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="安装目录">{cfg?.paths.home ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="bots.json">{cfg?.paths.botsConfig ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Bot 工作区根目录">{cfg?.paths.projectsRoot ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="状态目录">{cfg?.paths.stateDir ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="日志目录">{cfg?.paths.logsDir ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="发送暂存目录">{cfg?.paths.outputsBaseDir ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="调度时区">{cfg?.engineDefaults.scheduleTimezone ?? '系统默认'}</Descriptions.Item>
        </Descriptions>
      </Card>
      <Card title="旧环境默认值与凭证" size="small">
        <Typography.Paragraph type="secondary">仅供排查兼容配置。这里的模型和后端是环境默认值，机器人或模型连接可覆盖它们；当前接入请查看上方「模型接入」。</Typography.Paragraph>
        <Descriptions column={2} bordered size="small">
          <Descriptions.Item label="旧 Claude 默认模型">{cfg?.engineDefaults.claudeModel ?? '由 Claude 选择'}</Descriptions.Item>
          <Descriptions.Item label="旧 Claude 默认后端">{cfg?.engineDefaults.claudeBackend ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="旧 ANTHROPIC_API_KEY"><SecretHint v={cfg?.credentials.anthropicApiKey} /></Descriptions.Item>
          <Descriptions.Item label="旧 DEEPSEEK_API_KEY"><SecretHint v={cfg?.credentials.deepseekApiKey} /></Descriptions.Item>
          <Descriptions.Item label="旧 MINIMAX_API_KEY"><SecretHint v={cfg?.credentials.minimaxApiKey} /></Descriptions.Item>
        </Descriptions>
      </Card>
      <Card title="进程状态（PM2）" size="small">
        {pm2Error || pm2?.available === false ? <Alert type="warning" message="进程状态查询失败，可在终端使用 pm2 ls 查看。" />
          : <Table loading={!pm2} rowKey="name" dataSource={pm2?.apps || []} columns={pm2Columns} pagination={false} size="small" scroll={{ x: 700 }} />}
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>桥接重启统一使用页面顶部入口；core 服务需在终端单独管理。</Typography.Paragraph>
      </Card>
    </Space> }]} />
  </Space>;
}
