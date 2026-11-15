import { useEffect, useState } from 'react';
import { Button, Modal, Spin, Typography } from 'antd';
import { api } from '../api/client';
import type { RestartStatus } from '../api/types';

/**
 * Confirm a different bridge instance, rather than accepting the old process's
 * health response during the restart grace window. Detect cancelled restarts.
 */
export function RestartGuard({ open, beforeBootId, onRecovered, onCancelled }: { open: boolean; beforeBootId: string; onRecovered: () => void; onCancelled: () => void }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!open) return;
    setElapsed(0);
    let stopped = false;
    const started = Date.now();
    const timer = setInterval(async () => {
      setElapsed(Math.round((Date.now() - started) / 1000));
      try {
        const state = await api.get<RestartStatus>('/admin/api/restart-status');
        if (!stopped && state.bootId !== beforeBootId) {
          clearInterval(timer);
          onRecovered();
        } else if (!stopped && state.restartCancelled) {
          clearInterval(timer);
          onCancelled();
        }
      } catch {
        /* still down */
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [open, beforeBootId, onRecovered, onCancelled]);

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
