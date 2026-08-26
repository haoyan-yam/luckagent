import { useState } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Space,
  Steps,
  Typography,
  message,
} from 'antd';
import { api } from '../api/client';

const { Paragraph, Text, Link } = Typography;

import permissionScopes from '../../../../docs/feishu-permissions.json';

/** 批量导入 JSON（默认必备权限全集，与 docs/feishu-permissions.json 同源） */
const PERMISSIONS_JSON = JSON.stringify(permissionScopes, null, 2);
const TENANT_COUNT = permissionScopes.scopes.tenant.length;
const USER_COUNT = permissionScopes.scopes.user.length;
/** 手动最小集：只想先跑通消息收发时逐个开通这四项 */
const MINIMAL_PERMISSIONS = ['im:message', 'im:message:readonly', 'im:resource', 'im:chat:readonly'];

/**
 * 飞书接入向导：七步引导从开放平台建应用到落库为 bots.json 条目。
 */
export default function FeishuWizard({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState(0);
  const [form] = Form.useForm();
  const [testing, setTesting] = useState(false);
  const [testPassed, setTestPassed] = useState(false);
  const [creating, setCreating] = useState(false);

  const reset = () => {
    setStep(0);
    setTestPassed(false);
    form.resetFields();
  };

  const doTest = async () => {
    const { appId, appSecret } = await form.validateFields(['appId', 'appSecret']);
    setTesting(true);
    try {
      const r = await api.post<{ ok: boolean; msg: string; feishuCode: number | null }>(
        '/admin/api/feishu/test-connection',
        { appId, appSecret },
      );
      if (r.ok) {
        setTestPassed(true);
        message.success('凭证有效 ✓ 可以继续下一步');
      } else {
        setTestPassed(false);
        message.error(`验证失败：${r.msg}（code ${r.feishuCode ?? 'n/a'}）`);
      }
    } catch (err: any) {
      setTestPassed(false);
      message.error(err?.message || '测试请求失败，请确认桥接在运行');
    } finally {
      setTesting(false);
    }
  };

  const doCreate = async () => {
    // Steps render one at a time, so validateFields() only covers the fields
    // mounted on THIS step — earlier steps' values (appId/appSecret) must be
    // read from the form store with getFieldsValue(true) or they're dropped.
    await form.validateFields();
    const values = form.getFieldsValue(true) as Record<string, string | undefined>;
    if (!values.appId || !values.appSecret) {
      message.error('缺少飞书凭证——回到「填写凭证」步骤补齐 App ID / App Secret');
      setStep(1);
      return;
    }
    setCreating(true);
    try {
      const r = await api.post<{ skillsWarning?: string }>('/api/bots', {
        platform: 'feishu',
        name: values.name,
        description: values.description || undefined,
        feishuAppId: values.appId,
        feishuAppSecret: values.appSecret,
        installSkills: true,
      });
      if (r.skillsWarning) message.warning(r.skillsWarning, 8);
      message.success('机器人已保存到 bots.json，重启桥接后生效');
      onCreated();
      reset();
      onClose();
    } catch (err: any) {
      message.error(err?.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const steps = [
    {
      title: '创建应用',
      content: (
        <>
          <Paragraph>
            打开 <Link href="https://open.feishu.cn/app" target="_blank">飞书开放平台 →</Link>{' '}
            登录后点击「创建企业自建应用」，填写应用名称（即机器人名字）和描述。
          </Paragraph>
          <Alert type="info" showIcon message="需要企业管理员权限或申请开发者权限。个人版飞书也可以在「个人开发者」下创建。" />
        </>
      ),
    },
    {
      title: '填写凭证',
      content: (
        <>
          <Paragraph>
            进入应用详情 → <Text strong>凭证与基础信息</Text>，复制 <Text code>App ID</Text> 和{' '}
            <Text code>App Secret</Text> 填入下方，并点「测试连接」验证：
          </Paragraph>
          <Form.Item name="appId" label="App ID" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="cli_xxxxxxxxxxxxxxxx" />
          </Form.Item>
          <Form.Item name="appSecret" label="App Secret" rules={[{ required: true, message: '必填' }]}>
            <Input.Password />
          </Form.Item>
          <Space>
            <Button onClick={doTest} loading={testing} type={testPassed ? 'default' : 'primary'}>
              测试连接
            </Button>
            {testPassed && <Text type="success">✓ 凭证有效</Text>}
          </Space>
        </>
      ),
    },
    {
      title: '开启机器人',
      content: (
        <Paragraph>
          左侧菜单 → <Text strong>添加应用能力</Text> → 找到「机器人」→ 点击「添加」。
          这一步让应用可以在群聊/私聊中收发消息。
        </Paragraph>
      ),
    },
    {
      title: '权限配置',
      content: (
        <>
          <Paragraph>
            左侧菜单 → <Text strong>权限管理</Text> → 点击 <Text strong>批量导入</Text>
            （部分版本入口叫「导入权限配置」/「批量开通」），把下面的 JSON 整段粘贴进去提交：
          </Paragraph>
          <Paragraph copyable={{ text: PERMISSIONS_JSON, tooltips: ['复制权限 JSON', '已复制'] }}>
            <Text strong>复制默认权限 JSON</Text>（应用身份 {TENANT_COUNT} 项 + 用户身份 {USER_COUNT} 项，
            覆盖消息、文档、表格、多维表格、日历、任务、知识库等全部内置能力）
          </Paragraph>
          <Paragraph type="secondary">
            用户身份（user）权限供 lark-cli 以 <Text code>--as user</Text> 操作日历/云文档等场景使用，
            走用户授权，首次使用时飞书会引导授权。部分权限（如通讯录）提交后可能需要管理员在
            后台审批开通。
          </Paragraph>
          <Paragraph type="secondary">
            只想先跑通消息收发？也可以手动只开这四项最小集：
            {MINIMAL_PERMISSIONS.map((p) => (
              <Text code key={p} style={{ marginRight: 8 }}>
                {p}
              </Text>
            ))}
          </Paragraph>
        </>
      ),
    },
    {
      title: '事件订阅',
      content: (
        <>
          <Paragraph>
            左侧菜单 → <Text strong>事件与回调</Text> → 订阅方式选择{' '}
            <Text strong>「使用长连接接收事件」</Text>（无需公网回调地址）。
          </Paragraph>
          <Paragraph>
            然后在「事件配置」中添加事件：<Text code copyable>im.message.receive_v1</Text>
          </Paragraph>
          <Alert
            type="warning"
            showIcon
            message="保存长连接配置时，飞书要求至少有一个客户端在线。若保存报错，可先完成向导并重启桥接，再回来保存这一步。"
          />
        </>
      ),
    },
    {
      title: '发布版本',
      content: (
        <Paragraph>
          左侧菜单 → <Text strong>版本管理与发布</Text> → 创建版本 → 填写版本号（如 1.0.0）→
          申请发布。企业自建应用一般管理员审核后立即生效。
        </Paragraph>
      ),
    },
    {
      title: '保存机器人',
      content: (
        <>
          <Paragraph>最后给机器人起个名字、指定工作目录，保存到本机配置：</Paragraph>
          <Form.Item
            name="name"
            label="机器人名称"
            rules={[{ required: true, message: '必填' }, { pattern: /^[\w-]+$/, message: '仅限字母/数字/下划线/连字符' }]}
          >
            <Input placeholder="my-bot" />
          </Form.Item>
          <Form.Item name="description" label="描述（可选）">
            <Input />
          </Form.Item>
          <Form.Item label="工作目录">
            <Typography.Text type="secondary">
              自动创建 ~/projects/机器人名称（含 inputs/ 附件目录与说明模板；技能走全局层）；引擎用安装时选定的全局默认
            </Typography.Text>
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="保存时会自动：创建工作目录与 inputs/ 附件目录、部署说明模板、为 lark-cli 追加该应用的 profile（以机器人名命名）；共享技能走全局层无需复制。之后重启桥接生效，把机器人拉进群 @它说话即可测试。"
          />
        </>
      ),
    },
  ];

  const canNext = step !== 1 || testPassed;

  return (
    <Modal
      title="飞书接入向导"
      open={open}
      onCancel={() => {
        reset();
        onClose();
      }}
      width={680}
      footer={
        <Space>
          {step > 0 && <Button onClick={() => setStep(step - 1)}>上一步</Button>}
          {step < steps.length - 1 && (
            <Button type="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
              下一步
            </Button>
          )}
          {step === steps.length - 1 && (
            <Button type="primary" onClick={doCreate} loading={creating}>
              保存机器人
            </Button>
          )}
        </Space>
      }
    >
      <Steps current={step} size="small" items={steps.map((s) => ({ title: s.title }))} style={{ marginBottom: 24 }} />
      <Form form={form} layout="vertical">
        <div style={{ minHeight: 220 }}>{steps[step].content}</div>
      </Form>
    </Modal>
  );
}
