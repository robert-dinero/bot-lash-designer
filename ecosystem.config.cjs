module.exports = {
  apps: [
    {
      name: 'bot-lash-designer',
      script: './dist/server.js',
      cwd: '/home/jota_azure/bot-lash-designer',
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: 3003,
      },
    },
  ],
};
