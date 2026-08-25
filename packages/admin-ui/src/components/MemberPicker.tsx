import { useEffect, useMemo, useState } from 'react';
import { Select, Space, Typography, message } from 'antd';
import { api } from '../api/client';

interface Chat {
  chatId: string;
  name: string;
}
interface Member {
  openId: string;
  name: string;
}

/**
 * open_id 多选器：从某个群的成员列表里按姓名勾选，也允许直接粘贴 ou_ 字符串。
 * 受控组件——value 为 open_id 数组（antd Form.Item 直接托管）。
 *
 * botName 为空（新建 bot，尚未运行）时退化为纯手输 tags 模式。
 */
export default function MemberPicker({
  botName,
  value,
  onChange,
}: {
  botName: string | null;
  value?: string[];
  onChange?: (v: string[]) => void;
}) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  // open_id → 姓名 的累积映射（跨群保留，用于 tag 展示）
  const [nameMap, setNameMap] = useState<Record<string, string>>({});

  useEffect(() => {
    setChats([]);
    setChatId(null);
    setMembers([]);
    if (!botName) return;
    setLoadingChats(true);
    api
      .get<{ chats: Chat[] }>(`/admin/api/feishu/chats?bot=${encodeURIComponent(botName)}`)
      .then((r) => setChats(r.chats))
      .catch(() => {
        /* bot 未运行或凭证问题——退化为手输，不打扰 */
      })
      .finally(() => setLoadingChats(false));
  }, [botName]);

  useEffect(() => {
    setMembers([]);
    if (!botName || !chatId) return;
    setLoadingMembers(true);
    api
      .get<{ members: Member[] }>(
        `/admin/api/feishu/chat-members?bot=${encodeURIComponent(botName)}&chatId=${encodeURIComponent(chatId)}`,
      )
      .then((r) => {
        setMembers(r.members);
        setNameMap((m) => ({ ...m, ...Object.fromEntries(r.members.map((x) => [x.openId, x.name])) }));
      })
      .catch((err: any) => message.warning(err?.message || '拉取群成员失败'))
      .finally(() => setLoadingMembers(false));
  }, [botName, chatId]);

  const options = useMemo(() => {
    const fromGroup = members.map((m) => ({ value: m.openId, label: `${m.name}（${m.openId.slice(0, 10)}…）` }));
    // 已选但不在当前群成员里的值也要有可读 label
    const extras = (value || [])
      .filter((v) => !members.some((m) => m.openId === v))
      .map((v) => ({ value: v, label: nameMap[v] ? `${nameMap[v]}（${v.slice(0, 10)}…）` : v }));
    return [...fromGroup, ...extras];
  }, [members, value, nameMap]);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={4}>
      {chats.length > 0 && (
        <Select
          size="small"
          placeholder="从群加载成员（选一个群）"
          style={{ width: '100%' }}
          loading={loadingChats}
          value={chatId}
          onChange={setChatId}
          showSearch
          optionFilterProp="label"
          options={chats.map((c) => ({ value: c.chatId, label: c.name }))}
        />
      )}
      <Select
        mode="tags"
        style={{ width: '100%' }}
        placeholder={chats.length ? '按姓名勾选，或直接粘贴 ou_ 开头的 open_id' : '直接粘贴 ou_ 开头的 open_id（bot 运行后可按姓名选）'}
        loading={loadingMembers}
        value={value || []}
        onChange={(v) => onChange?.(v as string[])}
        options={options}
        optionFilterProp="label"
        tokenSeparators={[',', ' ']}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        白名单里的人在「仅群聊模式」下仍可私聊本 bot；清空即恢复「无人可私聊」。
      </Typography.Text>
    </Space>
  );
}
