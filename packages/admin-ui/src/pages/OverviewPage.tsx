import { useEffect } from 'react';
import { Alert, Button, Card, Col, Empty, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { Overview, BotOverview } from '../api/types';
import { RunStatusTag, UpDownTag } from '../components/StatusTag';

function fmtUptime(sec?: number): string {
  if (sec === undefined) return '-';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
  return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 小时`;
}

export default function OverviewPage({
  onConfigDirty,
  onRestart,
}: {
  onConfigDirty: (dirty: boolean) => void;
  onRestart: () => void;
}) {
  const { data, error, failCount } = usePoll<Overview>(() => api.get('/admin/api/overview'), 5000);

  useEffect(() => {
    if (data) onConfigDirty(data.configDirty);
  }, [data, onConfigDirty]);

  const botColumns = [
    { title: '名称', dataIndex: 'name', key: 'name', render: (v: string) => <strong>{v}</strong> },
    { title: '状态', key: 'running', render: (_: unknown, b: BotOverview) => <RunStatusTag running={b.running} /> },
    { title: '引擎', dataIndex: 'engine', key: 'engine', render: (v: string) => <Tag>{v}</Tag> },
    {
      title: '执行器',
      key: 'exec',
      render: (_: unknown, b: BotOverview) => `${b.executors.active} 活跃 / ${b.executors.total}`,
    },
    {
      title: '今日任务（失败）',
      key: 'today',
      render: (_: unknown, b: BotOverview) => (
        <span>
          {b.today.tasks}
          {b.today.failed > 0 && <Tag color="red" style={{ marginLeft: 8 }}>{b.today.failed} 失败</Tag>}
        </span>
      ),
    },
    {
      title: '今日成本',
      key: 'cost',
      render: (_: unknown, b: BotOverview) => `$${b.today.costUsd.toFixed(4)}`,
    },
    {
      title: '自启动累计',
      key: 'total',
      render: (_: unknown, b: BotOverview) =>
        `${b.sinceStart.totalTasks} 任务 / $${b.sinceStart.totalCostUsd.toFixed(2)}`,
    },
    {
      title: '最近活动',
      key: 'last',
      render: (_: unknown, b: BotOverview) =>
        b.lastActivityAt ? dayjs(b.lastActivityAt).fromNow() : '—',
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {failCount >= 2 && (
        <Alert type="error" banner message={`桥接连接中断（${error || '轮询失败'}）——若刚触发重启属正常，恢复后自动消失。`} />
      )}

      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic
              title={<span>桥接进程 {data && <Tag color="green">v{data.bridge.version}</Tag>}</span>}
              value={fmtUptime(data?.bridge.uptime)}
              suffix={data ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>内存 {data.bridge.memory.rssMb}MB</Typography.Text> : undefined}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={<span>core 服务 {data && <UpDownTag up={data.core.up} />}</span>}
              value={data?.core.up ? fmtUptime(data.core.uptime) : '不可达'}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="今日任务（全部 bot）" value={data?.today.tasks ?? '-'} suffix={data && data.today.failed > 0 ? <Tag color="red">{data.today.failed} 失败</Tag> : undefined} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="今日成本" prefix="$" value={data?.today.costUsd ?? '-'} precision={4} />
          </Card>
        </Col>
      </Row>

      <Card title="机器人" extra={<Link to="/bots">管理 →</Link>}>
        {data && data.bots.length === 0 ? (
          <Empty description={
            <span>
              尚未配置任何机器人 —— 去 <Link to="/bots">机器人管理</Link> 用「飞书接入向导」创建第一个
            </span>
          } />
        ) : (
          <Table
            rowKey="name"
            dataSource={data?.bots || []}
            columns={botColumns}
            pagination={false}
            size="small"
            loading={!data && !error}
          />
        )}
      </Card>

      <Row gutter={16}>
        <Col span={12}>
          <Card
            title={`定时任务（一次性 ${data?.schedule.oneTime ?? '-'} / 周期 ${data?.schedule.recurring ?? '-'}）`}
            extra={<Link to="/schedule">查看 →</Link>}
          >
            {data?.schedule.upcoming.length ? (
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {data.schedule.upcoming.map((t) => (
                  <li key={t.id}>
                    <Typography.Text>{t.botName}</Typography.Text>
                    {t.label && <Tag style={{ marginLeft: 6 }}>{t.label}</Tag>}
                    <Typography.Text type="secondary" style={{ marginLeft: 6 }}>
                      下次 {dayjs(t.nextExecuteAt).format('MM-DD HH:mm')}
                    </Typography.Text>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无周期任务" />
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card title="今日失败" extra={<Link to="/logs">看日志 →</Link>}>
            {data?.recentFailures.length ? (
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {data.recentFailures.map((f, i) => (
                  <li key={i}>
                    <Tag color="red">{f.botName}</Tag>
                    <Typography.Text type="secondary">
                      {dayjs(f.timestamp).format('HH:mm')} {f.errorMessage || '未知错误'}
                    </Typography.Text>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今天没有失败任务 🎉" />
            )}
          </Card>
        </Col>
      </Row>

      {data?.configDirty && (
        <Alert
          type="warning"
          showIcon
          message="bots.json 在进程启动后被修改过，改动尚未生效。"
          action={<Button size="small" type="primary" onClick={onRestart}>重启生效</Button>}
        />
      )}
    </Space>
  );
}
