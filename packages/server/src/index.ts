import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { startServer } from './server.js';

function makeLogger() {
  const level = process.env.LOG_LEVEL || 'info';
  // In production-like envs (no TTY, or LOG_FORMAT=json) emit JSON.
  if (process.env.LOG_FORMAT === 'json' || !process.stdout.isTTY) {
    return pino({ level });
  }
  return pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    },
  });
}

async function main() {
  const port = parseInt(process.env.LUCKAGENT_CORE_PORT || '9200', 10);
  const host = process.env.LUCKAGENT_CORE_HOST || '127.0.0.1';
  const dataDir =
    process.env.LUCKAGENT_CORE_DATA_DIR ||
    path.join(os.homedir(), '.luckagent-core', 'data');
  const instanceName = process.env.LUCKAGENT_CORE_INSTANCE_NAME;
  const logger = makeLogger();

  const handle = startServer({
    port,
    host,
    dataDir,
    instanceName,
    logger,
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await handle.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown error');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('luckagent-core server failed to start:', err);
  process.exit(1);
});
