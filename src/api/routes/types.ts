import type * as http from 'node:http';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../../utils/logger.js';
import type { BotRegistry } from '../bot-registry.js';
import type { TaskScheduler } from '../../scheduler/task-scheduler.js';
import type { DocSync } from '../../sync/doc-sync.js';
import type { PeerManager } from '../peer-manager.js';

import type { AsyncTaskStore } from '../async-task-store.js';
import type { IntentRouter } from '../intent-router.js';
import type { CircuitBreaker } from '../circuit-breaker.js';
import type { BudgetManager } from '../budget-manager.js';
import type { TeamManager } from '../team-manager.js';
import type { SessionRegistry } from '../../session/session-registry.js';
import type { ActivityStore } from '../activity-store.js';
import type { AgentTeamStore } from '../../agent-teams/team-store.js';
import type { AgentTeamSupervisor } from '../../agent-teams/team-supervisor.js';

export interface RouteContext {
  registry: BotRegistry;
  scheduler: TaskScheduler;
  logger: Logger;
  botsConfigPath?: string;
  docSync?: DocSync;
  feishuServiceClient?: lark.Client;
  peerManager?: PeerManager;
  asyncTaskStore: AsyncTaskStore;
  intentRouter: IntentRouter;
  circuitBreaker: CircuitBreaker;
  budgetManager: BudgetManager;
  teamManager: TeamManager;
  sessionRegistry?: SessionRegistry;
  activityStore?: ActivityStore;
  agentTeamStore?: AgentTeamStore;
  agentTeamSupervisor?: AgentTeamSupervisor;
}

/**
 * A route handler function. Returns true if it handled the request, false otherwise.
 */
export type RouteHandler = (
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
) => Promise<boolean>;
