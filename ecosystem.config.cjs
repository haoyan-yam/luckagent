const path = require('path');
const os = require('os');

// install.sh 建的 Python venv（python-pptx / openpyxl / Pillow …）。前置到 PATH，
// bridge 派生的 bot 会话里 `python3` 就解析到它，而不是系统自带的 Python。
const venvBin = path.join(os.homedir(), '.luckagent', 'venv', 'bin');
const PATH = [venvBin, process.env.PATH || ''].filter(Boolean).join(path.delimiter);

// 全局时区：LUCKAGENT_TIMEZONE > SCHEDULE_TIMEZONE > Asia/Shanghai（见 .env）。
// 本机可能在别的时区（如美国服务器），两个进程都钉到同一时区，bot 子进程随之继承。
function readDotenv(file) {
  try { return require('dotenv').parse(require('fs').readFileSync(file)); } catch { return {}; }
}
const dotenvVals = readDotenv(path.join(__dirname, '.env'));
const APP_TZ = process.env.LUCKAGENT_TIMEZONE || dotenvVals.LUCKAGENT_TIMEZONE
  || process.env.SCHEDULE_TIMEZONE || dotenvVals.SCHEDULE_TIMEZONE || 'Asia/Shanghai';

module.exports = {
  apps: [
    {
      name: 'luckagent-bridge',
      script: 'src/index.ts',
      // Use `node --import tsx` instead of the tsx wrapper script.
      // The wrapper in node_modules/.bin/tsx is a POSIX shell script with no
      // .cmd shim, so PM2's child_process.spawn can't exec it on Windows
      // (EINVAL). `node --import tsx` is tsx 4.x's documented cross-platform
      // entrypoint and works identically on Linux/macOS/Windows.
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,

      // Watch disabled — use `luckagent restart` to apply code changes manually
      watch: false,

      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,

      // Logs
      error_file: path.join(__dirname, 'logs', 'error.log'),
      out_file: path.join(__dirname, 'logs', 'out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Environment
      env: {
        NODE_ENV: 'production',
        PATH,
        CLAUDE_MAX_TURNS: '',  // unlimited turns (override any inherited shell env)
        TZ: APP_TZ,
        LUCKAGENT_TIMEZONE: APP_TZ,
      },
    },
    {
      name: 'luckagent-core',
      script: 'packages/server/dist/index.js',
      interpreter: 'node',
      cwd: __dirname,

      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,

      error_file: path.join(__dirname, 'logs', 'core-error.log'),
      out_file: path.join(__dirname, 'logs', 'core-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      env: {
        NODE_ENV: 'production',
        // Loopback-only by default; the port matches the CLI/bridge default.
        LUCKAGENT_CORE_HOST: '127.0.0.1',
        LUCKAGENT_CORE_PORT: '9200',
        TZ: APP_TZ,
        LUCKAGENT_TIMEZONE: APP_TZ,
      },
    },
  ],
};
