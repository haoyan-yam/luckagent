const path = require('path');

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
        CLAUDE_MAX_TURNS: '',  // unlimited turns (override any inherited shell env)
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
      },
    },
  ],
};
