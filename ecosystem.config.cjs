module.exports = {
  apps: [{
    name: 'tech-world-bot',
    script: 'dist/index.js',
    args: 'start',
    exp_backoff_restart_delay: 1000,
    max_restarts: 20,
    autorestart: true,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
