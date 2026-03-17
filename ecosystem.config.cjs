module.exports = {
  apps: [
    {
      name: 'clawd-bot',
      script: 'dist/index.js',
      args: 'start --bot=clawd',
      exp_backoff_restart_delay: 1000,
      max_restarts: 20,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'gremlin-bot',
      script: 'dist/index.js',
      args: 'start --bot=gremlin',
      exp_backoff_restart_delay: 1000,
      max_restarts: 20,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
