import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Layout, Menu, Popconfirm, Space, Typography, message } from 'antd';
import {
  DashboardOutlined,
  RobotOutlined,
  FieldTimeOutlined,
  FileTextOutlined,
  SettingOutlined,
  ReloadOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { api } from './api/client';
import { getToken, clearToken } from './auth';
import { RestartGuard } from './components/RestartGuard';
import LoginPage from './pages/LoginPage';
import OverviewPage from './pages/OverviewPage';
import BotsPage from './pages/BotsPage';
import SchedulePage from './pages/SchedulePage';
import LogsPage from './pages/LogsPage';
import ConfigPage from './pages/ConfigPage';

const { Sider, Header, Content } = Layout;

const MENU = [
  { key: '/overview', icon: <DashboardOutlined />, label: '系统总览' },
  { key: '/bots', icon: <RobotOutlined />, label: '机器人管理' },
  { key: '/schedule', icon: <FieldTimeOutlined />, label: '定时任务' },
  { key: '/logs', icon: <FileTextOutlined />, label: '运行日志' },
  { key: '/config', icon: <SettingOutlined />, label: '系统配置' },
];

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [restarting, setRestarting] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);

  const authed = !!getToken();

  useEffect(() => {
    if (!authed && location.pathname !== '/login') {
      navigate('/login', { replace: true });
    }
  }, [authed, location.pathname, navigate]);

  const doRestart = useCallback(async () => {
    try {
      await api.post('/admin/api/restart');
      setRestarting(true);
    } catch (err: any) {
      message.error(err?.message || '重启请求失败');
    }
  }, []);

  const onRecovered = useCallback(() => {
    setRestarting(false);
    setConfigDirty(false);
    message.success('桥接已重启');
    // Force every page to refetch.
    window.location.reload();
  }, []);

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
        <div style={{ color: '#fff', fontSize: 18, fontWeight: 700, padding: '16px 24px' }}>
          🍀 Luckagent
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
            <Popconfirm
              title="确认重启桥接进程？"
              description="所有进行中的会话回合会被打断；配置改动将在重启后生效。"
              onConfirm={doRestart}
              okText="重启"
              cancelText="取消"
            >
              <Button icon={<ReloadOutlined />} danger>
                重启桥接
              </Button>
            </Popconfirm>
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
            message="配置已修改，需要重启桥接进程才能生效。"
            action={
              <Button size="small" type="primary" onClick={doRestart}>
                立即重启
              </Button>
            }
          />
        )}
        <Content style={{ padding: 24, overflow: 'auto' }}>
          <Routes>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<OverviewPage onConfigDirty={setConfigDirty} onRestart={doRestart} />} />
            <Route path="/bots" element={<BotsPage onChanged={() => setConfigDirty(true)} />} />
            <Route path="/schedule" element={<SchedulePage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/config" element={<ConfigPage onRestart={doRestart} />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </Content>
      </Layout>
      <RestartGuard open={restarting} onRecovered={onRecovered} />
    </Layout>
  );
}
