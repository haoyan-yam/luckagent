export interface BotOverview {
  name: string;
  engine: string;
  workDir: string | null;
  running: boolean;
  executors: { total: number; active: number };
  today: { tasks: number; failed: number; costUsd: number };
  sinceStart: { totalTasks: number; totalCostUsd: number };
  lastActivityAt: number | null;
}

export interface Overview {
  bridge: { version: string; uptime: number; memory: { rssMb: number; heapUsedMb: number } };
  core: { up: boolean; uptime?: number; version?: string };
  bots: BotOverview[];
  configDirty: boolean;
  configError?: string | null;
  schedule: {
    oneTime: number;
    recurring: number;
    upcoming: Array<{ id: string; botName: string; label: string | null; nextExecuteAt: string }>;
  };
  today: { tasks: number; failed: number; costUsd: number };
  recentFailures: Array<{ botName: string; chatId: string; errorMessage: string | null; timestamp: number }>;
}

export interface BotEntry {
  name: string;
  description?: string;
  engine?: 'claude' | 'deepseek';
  feishuAppId?: string;
  feishuAppSecret?: string;
  defaultWorkingDirectory?: string;
  downloadsDir?: string;
  outputsBaseDir?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxConcurrentTasks?: number;
  budgetLimitDaily?: number;
  groupOnly?: boolean;
  groupOnlyAllowUsers?: string[];
  groupNoMention?: boolean;
  ttsVoice?: string;
  deepseek?: { apiKey?: string; model?: string; baseUrl?: string };
  [key: string]: unknown;
}

export interface ScheduleTask {
  id: string;
  type: 'one-time' | 'recurring';
  botName: string;
  chatId: string;
  prompt: string;
  executeAt?: string;
  cronExpr?: string;
  timezone?: string;
  nextExecuteAt?: string;
  lastExecutedAt?: string | null;
  label?: string;
  status: string;
  createdAt: string;
}

export interface Pm2Proc {
  name: string;
  pid: number | null;
  status: string;
  restarts: number;
  uptimeMs: number | null;
  memoryMb: number | null;
  cpu: number | null;
}

export interface EffectiveConfig {
  ports: { apiPort: number; apiHost: string; coreUrl: string };
  paths: Record<string, string | null>;
  engineDefaults: Record<string, string | null>;
  credentials: Record<string, { set: boolean; tail?: string }>;
}
