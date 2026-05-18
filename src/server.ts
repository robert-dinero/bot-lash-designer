import { env } from './config/env';
import { businessConfig } from './config/business';
import { initSchema } from './db';
import { app } from './app';
import { log } from './utils/logger';
import { initReminders, stopReminders } from './jobs/reminder-scheduler';

async function start(): Promise<void> {
  // 1. Env validated at import time (Zod crashes on missing vars)

  // 2. Business config loaded (crashes if config.json missing/invalid)
  log.info('-', 'STARTUP', `Business: ${businessConfig.businessName}`);

  // 3. Initialize database schema
  await initSchema();

  // 4. Initialize reminder scheduler (skip in test environment)
  if (process.env.NODE_ENV !== 'test') {
    try {
      await initReminders();
    } catch (err) {
      log.error(
        '-', 'STARTUP',
        `Warning: Reminder scheduler failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
      // Don't crash server if scheduler fails to start
    }
  }

  // 5. Start HTTP server
  app.listen(env.PORT, () => {
    log.info('-', 'STARTUP', `Server running on port ${env.PORT}`);
    log.info('-', 'STARTUP', 'Ready to receive WhatsApp messages');
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  log.info('-', 'STARTUP', 'SIGTERM received, shutting down...');
  await stopReminders();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('-', 'STARTUP', 'SIGINT received, shutting down...');
  await stopReminders();
  process.exit(0);
});

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
