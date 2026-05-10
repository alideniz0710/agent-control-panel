// PM2 ecosystem config for the agent-control-panel.
//
// Why this exists:
//   PM2 was previously started with `pm2 start npm --name agent-control-panel -- run start`.
//   That works for a manual start, but on a Mac reboot the .next/ directory
//   may be missing (cleaned by Next.js, deleted, or never built since last
//   pull). When PM2 auto-restarts after launchd resurrects it, `npm run start`
//   = `next start` immediately crashes with "Could not find a production
//   build". PM2 retries forever → crash loop, panel offline.
//
//   This config adds a pre-start hook that ensures Prisma + Next.js are
//   fully ready BEFORE serving requests. Adds ~30s to boot time but means
//   Mac power-cycle = panel just works.
//
// Apply on Mac (one-time):
//   cd ~/agent-control-panel
//   pm2 delete agent-control-panel   # remove the old npm-style process
//   pm2 start ecosystem.config.js    # start under the new config
//   pm2 save                         # persist for boot
//
// To reload after code changes:
//   pm2 reload ecosystem.config.js --update-env

module.exports = {
  apps: [
    {
      name: "agent-control-panel",
      // Use a small wrapper script so the pre-start logic is captured in
      // git rather than baked into PM2's saved process list.
      script: "scripts/pm2-start.sh",
      interpreter: "bash",
      cwd: ".", // resolved relative to where pm2 is invoked
      // Restart policy
      autorestart: true,
      max_restarts: 20,           // give up if it crashes 20 times in min_uptime
      min_uptime: "30s",
      restart_delay: 3000,        // wait 3s between restart attempts
      kill_timeout: 10_000,       // 10s graceful shutdown window
      exp_backoff_restart_delay: 5000,
      // Logs
      out_file: "/Users/alidenizaslan/.pm2/logs/agent-control-panel-out.log",
      error_file: "/Users/alidenizaslan/.pm2/logs/agent-control-panel-error.log",
      merge_logs: true,
      time: true,
      // Memory
      max_memory_restart: "1G",   // restart if RSS exceeds 1GB (catches leaks)
      // Env: PM2 inherits process env. Mac Mini uses ~/.zshrc-set vars
      // (ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, etc.) which are present
      // when pm2 is reloaded with --update-env after a manual login.
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
    },
  ],
};
