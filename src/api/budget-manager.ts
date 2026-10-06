import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Logger } from '../utils/logger.js';
import { localDay } from '../utils/local-day.js';

interface BudgetRecord {
  date: string;  // YYYY-MM-DD
  costUsd: number;
  taskCount: number;
}

interface BotBudget {
  botName: string;
  dailyLimitUsd: number;
  /** Local day (YYYY-MM-DD) that todaySpent/todayTasks belong to. Absent in pre-fix files. */
  day: string;
  todaySpent: number;
  todayTasks: number;
  history: BudgetRecord[];
  paused: boolean;
}

export class BudgetManager {
  private budgets = new Map<string, BotBudget>();
  private logger: Logger;
  private dataPath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(logger: Logger, opts: { dataPath?: string } = {}) {
    this.logger = logger.child({ module: 'budget' });
    this.dataPath = opts.dataPath ?? path.join(os.homedir(), '.luckagent', 'budgets.json');
    this.load();
  }

  /** Set daily budget limit for a bot. 0 = unlimited. */
  setLimit(botName: string, dailyLimitUsd: number): void {
    const budget = this.getOrCreate(botName);
    budget.dailyLimitUsd = dailyLimitUsd;
    this.scheduleSave();
  }

  /** Check if bot can accept a new task (within budget). */
  canAcceptTask(botName: string): { allowed: boolean; reason?: string } {
    const budget = this.budgets.get(botName);
    if (!budget || budget.dailyLimitUsd <= 0) return { allowed: true };
    if (budget.paused) return { allowed: false, reason: 'Bot paused due to budget override' };

    this.rolloverIfNeeded(budget);

    if (budget.todaySpent >= budget.dailyLimitUsd) {
      return { allowed: false, reason: `Daily budget exhausted: $${budget.todaySpent.toFixed(2)} / $${budget.dailyLimitUsd.toFixed(2)}` };
    }
    if (budget.todaySpent >= budget.dailyLimitUsd * 0.8) {
      this.logger.warn({ botName, spent: budget.todaySpent, limit: budget.dailyLimitUsd }, 'Budget 80% threshold');
    }
    return { allowed: true };
  }

  /** Record cost for a completed task. */
  recordCost(botName: string, costUsd: number): void {
    const budget = this.getOrCreate(botName);
    this.rolloverIfNeeded(budget);
    budget.todaySpent += costUsd;
    budget.todayTasks++;
    this.scheduleSave();
  }

  /** Record a bridge activity event — every finished task (completed or failed) counts. */
  recordTaskEvent(event: { type: string; botName: string; costUsd?: number }): void {
    if (event.type !== 'task_completed' && event.type !== 'task_failed') return;
    this.recordCost(event.botName, event.costUsd ?? 0);
  }

  /** Get budget info for a bot. */
  getBudget(botName: string): BotBudget | undefined {
    const budget = this.budgets.get(botName);
    if (budget) this.rolloverIfNeeded(budget);
    return budget;
  }

  /** Get all budgets. */
  getAllBudgets(): BotBudget[] {
    return Array.from(this.budgets.values()).map(b => {
      this.rolloverIfNeeded(b);
      return { ...b };
    });
  }

  /** Pause/unpause a bot. */
  setPaused(botName: string, paused: boolean): void {
    const budget = this.getOrCreate(botName);
    budget.paused = paused;
    this.scheduleSave();
  }

  /** Get cost report. */
  getReport(period: 'daily' | 'weekly' | 'monthly' = 'daily'): Record<string, { spent: number; tasks: number; limit: number }> {
    const report: Record<string, { spent: number; tasks: number; limit: number }> = {};

    for (const [name, budget] of this.budgets) {
      this.rolloverIfNeeded(budget);
      let spent = budget.todaySpent;
      let tasks = budget.todayTasks;

      if (period !== 'daily' && budget.history.length > 0) {
        // Last N local days including today (today's spend is already in `spent`).
        const days = period === 'weekly' ? 7 : 30;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - (days - 1));
        const cutoffStr = localDay(cutoff.getTime());

        for (const record of budget.history) {
          if (record.date >= cutoffStr) {
            spent += record.costUsd;
            tasks += record.taskCount;
          }
        }
      }

      report[name] = { spent, tasks, limit: budget.dailyLimitUsd };
    }
    return report;
  }

  private getOrCreate(botName: string): BotBudget {
    let budget = this.budgets.get(botName);
    if (!budget) {
      budget = {
        botName,
        dailyLimitUsd: 0,
        day: localDay(Date.now()),
        todaySpent: 0,
        todayTasks: 0,
        history: [],
        paused: false,
      };
      this.budgets.set(botName, budget);
    }
    return budget;
  }

  private rolloverIfNeeded(budget: BotBudget): void {
    const today = localDay(Date.now());
    if (budget.day === today) return;

    // Archive the finished day's spend under the day it actually happened
    if (budget.todaySpent > 0 || budget.todayTasks > 0) {
      budget.history.push({
        date: budget.day,
        costUsd: budget.todaySpent,
        taskCount: budget.todayTasks,
      });
      // Keep last 90 days
      if (budget.history.length > 90) {
        budget.history = budget.history.slice(-90);
      }
    }

    budget.day = today;
    budget.todaySpent = 0;
    budget.todayTasks = 0;
    this.scheduleSave();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
        // Pre-`day` files: the pending counters were last touched when the file was last written.
        const legacyDay = localDay(fs.statSync(this.dataPath).mtimeMs);
        for (const b of data.budgets || []) {
          if (typeof b.day !== 'string') b.day = legacyDay;
          if (!Array.isArray(b.history)) b.history = [];
          this.budgets.set(b.botName, b);
        }
        this.logger.info({ count: this.budgets.size }, 'Budgets loaded');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load budgets');
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
  }

  private save(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify({ budgets: Array.from(this.budgets.values()) }, null, 2));
    } catch (err) {
      this.logger.warn({ err }, 'Failed to save budgets');
    }
  }

  destroy(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.save();
    }
  }
}
