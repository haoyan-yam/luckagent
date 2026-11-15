import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Layout, Menu, Modal, Checkbox, Space, Typography, message } from 'antd';
import {
  DashboardOutlined,
  RobotOutlined,
  FieldTimeOutlined,
  FileTextOutlined,
  SettingOutlined,
  ReloadOutlined,
  LogoutOutlined,
  CommentOutlined,
  AppstoreOutlined,
  BookOutlined,
  ClearOutlined,
} from '@ant-design/icons';
import { api } from './api/client';
import type { RestartStatus } from './api/types';
import { usePoll } from './hooks/usePoll';
import { getToken, clearToken } from './auth';
import { RestartGuard } from './components/RestartGuard';
import LoginPage from './pages/LoginPage';
import OverviewPage from './pages/OverviewPage';
import BotsPage from './pages/BotsPage';
import SchedulePage from './pages/SchedulePage';
import GroupSummaryPage from './pages/GroupSummaryPage';
import LogsPage from './pages/LogsPage';
import SkillsPage from './pages/SkillsPage';
import MemoryPage from './pages/MemoryPage';
import ConfigPage from './pages/ConfigPage';
import HousekeepingPage from './pages/HousekeepingPage';

const { Sider, Header, Content } = Layout;

const MENU = [
  { key: '/overview', icon: <DashboardOutlined />, label: '系统总览' },
  { key: '/bots', icon: <RobotOutlined />, label: '机器人管理' },
  { key: '/schedule', icon: <FieldTimeOutlined />, label: '定时任务' },
  { key: '/summary', icon: <CommentOutlined />, label: '群日报' },
  { key: '/skills', icon: <AppstoreOutlined />, label: '技能' },
  { key: '/memory', icon: <BookOutlined />, label: '记忆' },
  { key: '/housekeeping', icon: <ClearOutlined />, label: '清理归档' },
  { key: '/logs', icon: <FileTextOutlined />, label: '运行日志' },
  { key: '/config', icon: <SettingOutlined />, label: '系统配置' },
];

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [restarting, setRestarting] = useState(false);
  const [restartBootId, setRestartBootId] = useState('');
  const [review, setReview] = useState<RestartStatus | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [forceAcknowledged, setForceAcknowledged] = useState(false);
  const [restartSubmitting, setRestartSubmitting] = useState(false);

  const authed = !!getToken();
  const { data: restartState, error: restartError, refresh: refreshRestartState } = usePoll<RestartStatus | null>(
    () => getToken() ? api.get('/admin/api/restart-status') : Promise.resolve(null), 10000, [authed],
  );
  const configDirty = restartState?.configDirty ?? false;
  const loadReview = useCallback(async () => {
    setReviewLoading(true);
    try { setReview(await api.get<RestartStatus>('/admin/api/restart-status')); setReviewError(''); }
    catch (err) { setReviewError((err as Error).message); }
    finally { setReviewLoading(false); }
  }, []);
  useEffect(() => {
    if (!reviewOpen) return;
    void loadReview();
    const timer = window.setInterval(() => void loadReview(), 5000);
    return () => window.clearInterval(timer);
  }, [reviewOpen, loadReview]);
  useEffect(() => { setForceAcknowledged(false); }, [review?.activeTasks, review?.queuedTasks]);

  useEffect(() => {
    if (!authed && location.pathname !== '/login') {
      navigate('/login', { replace: true });
    }
  }, [authed, location.pathname, navigate]);

  const doRestart = useCallback(async () => {
    setRestartSubmitting(true);
    try {
      const result = await api.post<{ bootId: string }>('/admin/api/restart', { force: !!(review && (review.activeTasks || review.queuedTasks) && forceAcknowledged) });
      setRestartBootId(result.bootId);
      setReviewOpen(false);
      setRestarting(true);
    } catch (err: any) {
      message.error(err?.message || '重启请求失败');
      void loadReview();
    } finally { setRestartSubmitting(false); }
  }, [review, forceAcknowledged, loadReview]);

  const onRecovered = useCallback(() => {
    setRestarting(false);
    message.success('桥接已重启');
    // Force every page to refetch.
    window.location.reload();
  }, []);
  const onRestartCancelled = useCallback(() => {
    setRestarting(false);
    message.warning('检测到新任务或配置异常，重启已取消');
    void refreshRestartState();
  }, [refreshRestartState]);

  if (location.pathname === '/login') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={200}>
        <div
          style={{ color: '#fff', fontSize: 18, fontWeight: 700, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <img src={`${import.meta.env.BASE_URL}logo-dark.svg`} alt="" width={30} height={30} />
          Luckagent
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={MENU}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Typography.Text strong>
            {MENU.find((m) => m.key === location.pathname)?.label || '控制台'}
          </Typography.Text>
          <Space>
            <Button icon={<ReloadOutlined />} type={configDirty ? 'primary' : 'default'}
              disabled={restarting} onClick={() => { setReview(null); setReviewError(''); setForceAcknowledged(false); setReviewOpen(true); }}>
              {configDirty ? '重启桥接 · 有待生效配置' : '重启桥接'}
            </Button>
            <Button
              icon={<LogoutOutlined />}
              onClick={() => {
                clearToken();
                navigate('/login');
              }}
            >
              退出登录
            </Button>
          </Space>
        </Header>
        {configDirty && (
          <Alert
            banner
            type="warning"
            message={`已保存，待重启生效：${restartState?.pendingChanges.join("、")}。请使用顶部统一重启入口。`}

          />
        )}
        {restartError && <Alert banner type="warning" message="无法获取最新运行与配置状态，重启前将重新检查。" />}
        {!!restartState?.configErrors.length && <Alert banner type="error" message={restartState.configErrors.join('；')} />}
        <Content style={{ padding: 24, overflow: 'auto' }}>
          <Routes>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/bots" element={<BotsPage onChanged={() => void refreshRestartState()} />} />
            <Route path="/schedule" element={<SchedulePage />} />
            <Route path="/summary" element={<GroupSummaryPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="/housekeeping" element={<HousekeepingPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/config" element={<ConfigPage onChanged={() => void refreshRestartState()} />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </Content>
      </Layout>
      <Modal title="重启桥接" open={reviewOpen} onCancel={() => setReviewOpen(false)}
        confirmLoading={restartSubmitting}
        okText={forceAcknowledged ? '确认中断任务并重启' : '确认重启'} cancelText="暂不重启"
        okButtonProps={{ danger: forceAcknowledged, disabled: reviewLoading || !!reviewError || !review || !!review.configErrors.length || !!((review.activeTasks || review.queuedTasks) && !forceAcknowledged) }}
        onOk={() => void doRestart()}>
        <Space direction="vertical" style={{ width: '100%' }}>
          {reviewError && <Alert type="error" message={reviewError} />}
          {!review && !reviewError && <Typography.Text>正在检查任务与配置…</Typography.Text>}
          {review && <>
            <Typography.Text>待生效配置：{review.pendingChanges.join('、') || '无；此次将仅重启服务'}</Typography.Text>
            {!!review.configErrors.length && <Alert type="error" message={review.configErrors.join('；')} />}
            <Typography.Text>正在执行或准备：{review.activeTasks}；排队或待处理：{review.queuedTasks}</Typography.Text>
            {!!review.busyBots.length && <Typography.Text>涉及 bot：{review.busyBots.map(b => b.name).join('、')}</Typography.Text>}
            {(review.activeTasks > 0 || review.queuedTasks > 0) ? <>
              <Alert type="warning" message="当前有任务，默认不允许重启。建议等待任务结束。" />
              <Checkbox checked={forceAcknowledged} onChange={e => setForceAcknowledged(e.target.checked)}>我确认中断当前任务并丢弃待处理任务</Checkbox>
            </> : <Typography.Text type="secondary">当前空闲。提交时及退出前会再次检查，如有新任务则取消重启。</Typography.Text>}
          </>}
        </Space>
      </Modal>
      <RestartGuard open={restarting} beforeBootId={restartBootId} onRecovered={onRecovered}
        onCancelled={onRestartCancelled} />
    </Layout>
  );
}
