import { Cron } from 'croner';
import { subDays } from 'date-fns';
import {
  findDueReminders,
  sendReminder,
  isWithinBusinessHours,
} from '../services/reminder.service';
import { log, maskPhone } from '../utils/logger';
import { getDb } from '../db';
import { PROCESSED_MESSAGES_TTL_DAYS } from '../config/constants';

let reminderCron: Cron | null = null;

/**
 * Initialize the reminder scheduler Croner job.
 * Runs every 5 minutes to find and send due reminders.
 */
export async function initReminders(): Promise<void> {
  try {
    reminderCron = new Cron('*/5 * * * *', async () => {
      try {
        await processAllDueReminders();
        await cleanupProcessedMessages();
      } catch (err) {
        log.error('-', 'SCHEDULER', `Reminder job failed: ${err instanceof Error ? err.message : String(err)}`, err);
      }
    }, {
      protect: true, // Prevent overlapping runs
    });

    log.info('-', 'SCHEDULER', 'Reminder scheduler initialized (runs every 5 minutes)');
  } catch (err) {
    log.error('-', 'SCHEDULER', `Failed to initialize reminder scheduler: ${err instanceof Error ? err.message : String(err)}`, err);
    throw err;
  }
}

/**
 * Stop the reminder scheduler gracefully.
 */
export async function stopReminders(): Promise<void> {
  if (reminderCron) {
    reminderCron.stop();
    log.info('-', 'SCHEDULER', 'Reminder scheduler stopped');
  }
}

/**
 * Delete processed_messages rows older than PROCESSED_MESSAGES_TTL_DAYS.
 * Runs inside the existing 5-min cron. NEVER touches the `messages` table (D-07).
 * Exported for direct testing.
 */
export async function cleanupProcessedMessages(): Promise<void> {
  const db = getDb();
  const tableExists = await db.schema.hasTable('processed_messages');
  if (!tableExists) return;
  const cutoff = subDays(new Date(), PROCESSED_MESSAGES_TTL_DAYS).toISOString();
  const deleted = await db('processed_messages')
    .where('processed_at', '<', cutoff)
    .delete();
  if (deleted > 0) {
    log.info('-', 'SCHEDULER', `Cleaned ${deleted} processed_messages older than ${PROCESSED_MESSAGES_TTL_DAYS} days`);
  }
}

/**
 * Process all due reminders: find, filter by business hours, send, mark.
 * Exported for direct testing (avoids Croner fake-timer issues in test environment).
 */
export async function processAllDueReminders(): Promise<void> {
  const reminders = await findDueReminders();

  for (const reminder of reminders) {
    if (reminder.shouldSendNow) {
      try {
        await sendReminder(reminder, reminder.clientPhone);
        log.info(maskPhone(reminder.clientPhone), 'REMINDER', `sent ${reminder.reminderType} reminder for appointment id=${reminder.appointmentId}`);
      } catch (err) {
        log.error(maskPhone(reminder.clientPhone), 'REMINDER', `failed to send reminder id=${reminder.appointmentId}: ${err instanceof Error ? err.message : String(err)}`, err);
      }
    } else if (reminder.nextSendAt) {
      log.info(maskPhone(reminder.clientPhone), 'REMINDER', `reminder id=${reminder.appointmentId} deferred until ${reminder.nextSendAt} (outside business hours)`);
    }
  }
}
