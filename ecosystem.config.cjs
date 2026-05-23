module.exports = {
  apps: [
    {
      name: "example-vcp",
      cwd: "/opt/VCPWeChatBot",
      script: "pnpm",
      args: "--filter example-vcp run start",
      interpreter: "bash",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};