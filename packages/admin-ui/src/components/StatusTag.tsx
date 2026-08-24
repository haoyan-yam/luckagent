import { Tag } from 'antd';

export function RunStatusTag({ running }: { running: boolean }) {
  return running ? <Tag color="green">运行中</Tag> : <Tag color="red">未运行/启动失败</Tag>;
}

export function UpDownTag({ up }: { up: boolean }) {
  return up ? <Tag color="green">在线</Tag> : <Tag color="red">离线</Tag>;
}
