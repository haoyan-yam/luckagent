import { Alert, Button, Card, Descriptions, Space, Table, Tag, Typography } from 'antd';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { EffectiveConfig, Pm2Proc } from '../api/types';

function SecretHint({ v }: { v?: { set: boolean; tail?: string } }) {
  if (!v?.set) return <Tag>未配置</Tag>;
  return <Tag color="green">已配置（••••{v.tail}）</Tag>;
}

function ClaudeAuthHint({ a }: { a?: EffectiveConfig['claudeAuth'] }) {
  if (!a) return <Tag>—</Tag>;
  if (!a.cliInstalled && !a.loggedIn) return <Tag>未装 CLI（API key 或 DeepSeek 路线则无需）</Tag>;
  if (!a.loggedIn) return <Tag color="orange">已装 CLI 未登录——终端跑一次 claude</Tag>;
  const tier = a.seatTier || a.billingType || a.rateLimitTier;
  const fetched = a.profileFetchedAt ? new Date(a.profileFetchedAt).toLocaleDateString() : null;
  return (
    <span>
      <Tag color="green">已登录</Tag>
      {a.email && <Typography.Text type="secondary">{a.email}</Typography.Text>}
      {tier && <Tag style={{ marginLeft: 6 }}>{tier}</Tag>}
      {a.hasAvailableSubscription === true && <Tag color="green">订阅可用</Tag>}
      {a.hasAvailableSubscription === false && <Tag color="red">订阅不可用</Tag>}
      {a.trialEndsAt && <Tag color="orange">试用至 {new Date(a.trialEndsAt).toLocaleDateString()}</Tag>}
      {fetched && (
        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
          （CLI 缓存 · {fetched} 刷新）
        </Typography.Text>
      )}
    </span>
  );
}

function fmtUptime(ms: number | null): string {
  if (!ms) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时`;
  return `${Math.floor(sec / 86400)} 天`;
}

export default function ConfigPage({ onRestart }: { onRestart: () => void }) {
  const { data: cfg } = usePoll<EffectiveConfig>(() => api.get('/admin/api/config'), 30000);
  const { data: pm2 } = usePoll<{ available: boolean; apps?: Pm2Proc[] }>(
    () => api.get('/admin/api/pm2'),
    15000,
  );

  const pm2Columns = [
    { title: '进程', dataIndex: 'name', key: 'name' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => (v === 'online' ? <Tag color="green">online</Tag> : <Tag color="red">{v}</Tag>),
    },
    { title: 'PID', dataIndex: 'pid', key: 'pid', render: (v: number | null) => v ?? '—' },
    { title: '重启次数', dataIndex: 'restarts', key: 'restarts' },
    { title: '运行时长', dataIndex: 'uptimeMs', key: 'uptime', render: fmtUptime },
    { title: '内存', dataIndex: 'memoryMb', key: 'mem', render: (v: number | null) => (v ? `${v} MB` : '—') },
    { title: 'CPU', dataIndex: 'cpu', key: 'cpu', render: (v: number | null) => (v != null ? `${v}%` : '—') },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title="有效配置（只读）">
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="配置从 .env 与环境变量读取，此处只读；修改请编辑安装目录下的 .env 后点顶栏「重启桥接」。"
        />
        <Descriptions column={2} bordered size="small">
          <Descriptions.Item label="API 端口">{cfg?.ports.apiPort ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="绑定地址">
            {cfg?.ports.apiHost ?? '—'}{' '}
            {cfg?.ports.apiHost && cfg.ports.apiHost !== '127.0.0.1' && (
              <Tag color="orange">对外监听 —— 建议配合防火墙</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="core 地址">{cfg?.ports.coreUrl ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="安装目录">{cfg?.paths.home ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="bots.json">{cfg?.paths.botsConfig ?? '未设置'}</Descriptions.Item>
          <Descriptions.Item label="状态目录">{cfg?.paths.stateDir ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="日志目录">{cfg?.paths.logsDir ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="发送暂存目录">{cfg?.paths.outputsBaseDir ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Claude 模型">{cfg?.engineDefaults.claudeModel ?? '默认'}</Descriptions.Item>
          <Descriptions.Item label="Claude 后端">{cfg?.engineDefaults.claudeBackend ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="调度时区">{cfg?.engineDefaults.scheduleTimezone ?? '系统默认'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="密钥状态">
        <Descriptions column={3} bordered size="small">
          <Descriptions.Item label="API_SECRET">
            <SecretHint v={cfg?.credentials.apiSecret} />
          </Descriptions.Item>
          <Descriptions.Item label="ANTHROPIC_API_KEY">
            <SecretHint v={cfg?.credentials.anthropicApiKey} />
          </Descriptions.Item>
          <Descriptions.Item label="Claude 订阅登录">
            <ClaudeAuthHint a={cfg?.claudeAuth} />
          </Descriptions.Item>
          <Descriptions.Item label="OPENAI_API_KEY">
            <SecretHint v={cfg?.credentials.openaiApiKey} />
          </Descriptions.Item>
          <Descriptions.Item label="生图 OPENAI_IMAGE_API_KEY">
            <SecretHint v={cfg?.credentials.openaiImageApiKey} />
          </Descriptions.Item>
          <Descriptions.Item label="core Token">
            <SecretHint v={cfg?.credentials.coreToken} />
          </Descriptions.Item>
          <Descriptions.Item label="火山 TTS">
            <SecretHint v={cfg?.credentials.volcengineTts} />
          </Descriptions.Item>
          <Descriptions.Item label="ElevenLabs">
            <SecretHint v={cfg?.credentials.elevenlabs} />
          </Descriptions.Item>
          <Descriptions.Item label="DEEPSEEK_API_KEY">
            <SecretHint v={cfg?.credentials.deepseekApiKey} />
          </Descriptions.Item>
          <Descriptions.Item label="MINIMAX_API_KEY">
            <SecretHint v={cfg?.credentials.minimaxApiKey} />
          </Descriptions.Item>
          <Descriptions.Item label="火山 ARK_API_KEY">
            <SecretHint v={cfg?.credentials.arkApiKey} />
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        title="PM2 进程"
        extra={
          <Button danger onClick={onRestart}>
            重启桥接
          </Button>
        }
      >
        {pm2?.available === false ? (
          <Alert type="warning" showIcon message="pm2 不可用（未安装或查询超时）。用终端 pm2 ls 查看。" />
        ) : (
          <Table rowKey="name" dataSource={pm2?.apps || []} columns={pm2Columns} pagination={false} size="small" />
        )}
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          「重启桥接」通过进程自退出 + PM2 autorestart 完成；core 进程如需重启请在终端执行{' '}
          <Typography.Text code>luckagent restart --core</Typography.Text>。
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}
