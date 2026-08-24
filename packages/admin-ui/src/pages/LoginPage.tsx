import { useState } from 'react';
import { Button, Card, Form, Input, Typography, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { setToken } from '../auth';

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const onFinish = async ({ secret }: { secret: string }) => {
    setLoading(true);
    try {
      const resp = await fetch('/api/status', {
        headers: { Authorization: `Bearer ${secret.trim()}` },
      });
      if (resp.status === 401) {
        message.error('密钥不正确');
        return;
      }
      if (resp.status === 429) {
        message.error('尝试过于频繁，已被暂时限流，请稍后再试');
        return;
      }
      if (!resp.ok) {
        message.error(`连接失败（HTTP ${resp.status}）`);
        return;
      }
      setToken(secret.trim());
      navigate('/overview', { replace: true });
    } catch {
      message.error('无法连接桥接服务，请确认它已启动');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card style={{ width: 400 }}>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>
          🍀 Luckagent 控制台
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          输入 API 密钥登录（安装时生成的 <code>API_SECRET</code>，见 <code>.env</code>）
        </Typography.Paragraph>
        <Form onFinish={onFinish} layout="vertical">
          <Form.Item name="secret" rules={[{ required: true, message: '请输入 API 密钥' }]}>
            <Input.Password placeholder="API_SECRET" autoFocus />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
