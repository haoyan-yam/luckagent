import { Space, Tag, Typography } from 'antd';
import type { EffectiveConfig } from '../api/types';
import { fmt } from '../lib/time';

export default function ClaudeAuthStatus({ a }: { a?: EffectiveConfig['claudeAuth'] }) {
  if (!a) return <Tag>状态未获取</Tag>;
  if (a.error) return <Tag color="orange">{a.error}</Tag>;
  if (!a.cliInstalled) return <Tag>未安装 CLI</Tag>;
  if (a.loggedIn === undefined) return <Tag>状态未获取</Tag>;
  const tier = a.subscriptionType;
  return (
    <Space size={[4, 8]} wrap>
      <Tag color={a.loggedIn ? 'green' : undefined}>{a.loggedIn ? '已登录' : '未登录'}</Tag>
      {a.email && <Typography.Text type="secondary">{a.email}</Typography.Text>}
      {tier && <Tag>{tier.toLowerCase() === 'max' ? 'Max 订阅' : tier.toLowerCase() === 'pro' ? 'Pro 订阅' : tier}</Tag>}
      {a.authMethod && <Tag>{a.authMethod === 'claude.ai' ? 'Claude 官方账号' : a.authMethod}</Tag>}
      {a.checkedAt && <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        CLI 查询 · {fmt(a.checkedAt, 'YYYY-MM-DD HH:mm:ss')}
      </Typography.Text>}
    </Space>
  );
}
