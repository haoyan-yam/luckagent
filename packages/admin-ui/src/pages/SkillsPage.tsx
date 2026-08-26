import { useState } from 'react';
import { Alert, Card, Collapse, Drawer, Empty, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import { MarkdownView } from '../md';

interface SkillInfo {
  name: string;
  description: string;
  kind: 'dir' | 'symlink' | 'git';
  updatedAt: string | null;
}
interface SkillsPayload {
  globalDir: string;
  global: SkillInfo[];
  bots: Array<{ name: string; workdir: string; skills: SkillInfo[] }>;
}
interface SkillDetail {
  name: string;
  skillMd: string;
  files: string[];
  truncated: boolean;
}

const KIND_TAG: Record<SkillInfo['kind'], { color: string; label: string }> = {
  dir: { color: 'default', label: '目录' },
  symlink: { color: 'blue', label: '符号链接' },
  git: { color: 'green', label: 'git 检出' },
};

export default function SkillsPage() {
  const { data, error } = usePoll<SkillsPayload>(() => api.get('/admin/api/skills'), 30000);
  const [detail, setDetail] = useState<{ title: string; loading: boolean; data?: SkillDetail } | null>(null);

  const openDetail = async (scope: 'global' | 'bot', skill: string, bot?: string) => {
    const title = bot ? `${bot} / ${skill}` : skill;
    setDetail({ title, loading: true });
    try {
      const qs = scope === 'bot' ? `scope=bot&bot=${encodeURIComponent(bot!)}&skill=${encodeURIComponent(skill)}` : `scope=global&skill=${encodeURIComponent(skill)}`;
      const d = await api.get<SkillDetail>(`/admin/api/skills/detail?${qs}`);
      setDetail({ title, loading: false, data: d });
    } catch {
      setDetail({ title, loading: false });
    }
  };

  const columns = (scope: 'global' | 'bot', bot?: string) => [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (v: string) => (
        <Typography.Link onClick={() => openDetail(scope, v, bot)}>
          <strong>{v}</strong>
        </Typography.Link>
      ),
    },
    { title: '描述', dataIndex: 'description', key: 'desc', ellipsis: true },
    {
      title: '来源',
      dataIndex: 'kind',
      key: 'kind',
      width: 100,
      render: (k: SkillInfo['kind']) => <Tag color={KIND_TAG[k].color}>{KIND_TAG[k].label}</Tag>,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'at',
      width: 120,
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD') : '—'),
    },
  ];

  const globalSkills = data?.global || [];
  const larkSkills = globalSkills.filter((s) => s.name.startsWith('lark-'));
  const mainSkills = globalSkills.filter((s) => !s.name.startsWith('lark-'));

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {error && <Alert type="error" banner message={`加载失败：${error}`} />}

      <Card title={<span>全局技能 <Typography.Text type="secondary" style={{ fontSize: 12 }}>{data?.globalDir}（对所有 bot 生效）</Typography.Text></span>}>
        <Table rowKey="name" dataSource={mainSkills} columns={columns('global')} pagination={false} size="small" loading={!data && !error} />
        {larkSkills.length > 0 && (
          <Collapse
            ghost
            style={{ marginTop: 8 }}
            items={[{
              key: 'lark',
              label: `lark-* 飞书技能（${larkSkills.length} 个，随 lark-cli 安装）`,
              children: <Table rowKey="name" dataSource={larkSkills} columns={columns('global')} pagination={false} size="small" />,
            }]}
          />
        )}
      </Card>

      <Card title="项目级技能（各 bot 工作目录的定制技能；与全局同名时项目级优先）">
        {data && data.bots.length === 0 && <Empty description="尚无机器人" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {data?.bots.map((b) => (
            <div key={b.name}>
              <Typography.Text strong>{b.name}</Typography.Text>{' '}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{b.workdir}/.claude/skills</Typography.Text>
              {b.skills.length === 0 ? (
                <div><Typography.Text type="secondary">无定制技能（共享技能在全局层，无需复制）</Typography.Text></div>
              ) : (
                <Table rowKey="name" dataSource={b.skills} columns={columns('bot', b.name)} pagination={false} size="small" style={{ marginTop: 8 }} />
              )}
            </div>
          ))}
        </Space>
      </Card>

      <Drawer
        title={detail?.title}
        open={!!detail}
        onClose={() => setDetail(null)}
        width={720}
      >
        {detail?.loading && <Typography.Text type="secondary">加载中…</Typography.Text>}
        {detail && !detail.loading && !detail.data && <Alert type="warning" message="读取失败" />}
        {detail?.data && (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            {detail.data.skillMd ? (
              <MarkdownView text={detail.data.skillMd} />
            ) : (
              <Alert type="info" message="该技能没有 SKILL.md" />
            )}
            <Card size="small" title={`文件清单（${detail.data.files.length}${detail.data.truncated ? '+，已截断' : ''}）`}>
              <pre style={{ margin: 0, maxHeight: 260, overflow: 'auto', fontSize: 12 }}>{detail.data.files.join('\n')}</pre>
            </Card>
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
