import { useEffect, useState } from 'react';
import { Button, Modal, Spin, Typography } from 'antd';

/**
 * Full-screen overlay shown after POST /admin/api/restart. Probes the
 * unauthenticated GET /api/health every 2s until the bridge is back, then
 * reloads data by calling onRecovered.
 */
export function RestartGuard({ open, onRecovered }: { open: boolean; onRecovered: () => void }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!open) return;
    setElapsed(0);
    let stopped = false;
    const started = Date.now();
    const timer = setInterval(async () => {
      setElapsed(Math.round((Date.now() - started) / 1000));
      try {
        const resp = await fetch('/api/health');
        if (resp.ok && !stopped) {
          // The new process is up. Small grace period for bot startup.
          clearInterval(timer);
          setTimeout(() => onRecovered(), 1000);
        }
      } catch {
        /* still down */
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [open, onRecovered]);

  const stalled = elapsed >= 60;
  return (
    <Modal open={open} footer={null} closable={false} centered>
      <div style={{ textAlign: 'center', padding: 24 }}>
        <Spin size="large" />
        <Typography.Title level={4} style={{ marginTop: 16 }}>
          正在重启桥接进程…
        </Typography.Title>
        <Typography.Text type="secondary">
          PM2 将自动拉起新进程（约 5–10 秒），已等待 {elapsed}s
        </Typography.Text>
        {stalled && (
          <div style={{ marginTop: 16 }}>
            <Typography.Paragraph type="warning">
              等待超过 60 秒——若桥接不是由 PM2 托管（前台运行），重启后不会自动拉起，
              请在终端手动启动后刷新本页。
            </Typography.Paragraph>
            <Button onClick={() => window.location.reload()}>刷新页面</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
