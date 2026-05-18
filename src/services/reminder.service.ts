import { getDb } from '../db';
import type { DueReminder, ReminderType, WorkingHours } from '../types';
import { sendText } from './waha.service';
import { log, maskPhone } from '../utils/logger';
import { DEFAULT_CHAIR_ID } from '../config';

const PT_BR_TZ_OFFSET = -3; // UTC-3 (ignores daylight saving — PT-BR observance is inconsistent)

// ─── Business hours guard ─────────────────────────────────────────────────────

/**
 * Return PT-BR hour (0–23) for a given UTC Date.
 */
function ptbrHour(date: Date): number {
  return (date.getUTCHours() + PT_BR_TZ_OFFSET + 24) % 24;
}

/**
 * Return PT-BR minute (0–59) for a given UTC Date.
 */
function ptbrMinute(date: Date): number {
  return date.getUTCMinutes();
}

/**
 * Check if a given UTC Date is within the allowed sending window:
 * from (establishment open_time - 30 min) until 21:00 PT-BR.
 * open_time is read from working_hours for today's day-of-week.
 * Falls back to 08:00 if no working_hours row found.
 */
export async function isWithinSendingWindow(date: Date): Promise<boolean> {
  const db = getDb();
  const hour = ptbrHour(date);
  const minute = ptbrMinute(date);
  const totalMinutes = hour * 60 + minute;

  // Upper bound: 21:00 PT-BR
  if (totalMinutes >= 21 * 60) return false;

  // Lower bound: open_time - 30 min for today's day of week
  // day_of_week in PT-BR local time
  const ptbrDayOfWeek = new Date(
    date.getTime() + PT_BR_TZ_OFFSET * 60 * 60 * 1000
  ).getUTCDay();

  const wh = await db('working_hours')
    .where({ chair_id: DEFAULT_CHAIR_ID, day_of_week: ptbrDayOfWeek })
    .first() as WorkingHours | undefined;

  let openMinutes = 8 * 60; // fallback: 08:00
  if (wh && !wh.is_closed && wh.open_time) {
    const [oh, om] = wh.open_time.split(':').map(Number);
    openMinutes = oh * 60 + (om ?? 0);
  }

  const windowStart = openMinutes - 30; // 30 min before opening
  return totalMinutes >= windowStart;
}

/**
 * Get the next allowed send time: (open_time - 30 min) for the next open day.
 * Used to populate nextSendAt when a reminder falls outside the window.
 */
async function getNextWindowStart(date: Date): Promise<Date> {
  const db = getDb();

  // Walk forward up to 7 days to find the next open day
  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const candidate = new Date(date.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    const ptbrDayOfWeek = new Date(
      candidate.getTime() + PT_BR_TZ_OFFSET * 60 * 60 * 1000
    ).getUTCDay();

    const wh = await db('working_hours')
      .where({ chair_id: DEFAULT_CHAIR_ID, day_of_week: ptbrDayOfWeek })
      .first() as WorkingHours | undefined;

    if (!wh || wh.is_closed) continue;

    const [oh, om] = wh.open_time.split(':').map(Number);
    const openMinutes = oh * 60 + (om ?? 0);
    const windowStartMinutes = openMinutes - 30;
    const windowStartHour = Math.floor(windowStartMinutes / 60);
    const windowStartMin = windowStartMinutes % 60;

    // Build the candidate send time in UTC
    // Start from midnight UTC of candidate's PT-BR date
    const ptbrMidnight = new Date(candidate);
    ptbrMidnight.setUTCHours(-PT_BR_TZ_OFFSET, 0, 0, 0); // midnight PT-BR = UTC+3
    const sendTime = new Date(
      ptbrMidnight.getTime() + (windowStartHour * 60 + windowStartMin) * 60 * 1000
    );

    // Only return a future time
    if (sendTime > date) return sendTime;
  }

  // Fallback: 8am PT-BR tomorrow
  const tomorrow = new Date(date);
  tomorrow.setUTCHours(tomorrow.getUTCHours() + (24 - ptbrHour(date)) + 8 - PT_BR_TZ_OFFSET);
  tomorrow.setUTCMinutes(0);
  tomorrow.setUTCSeconds(0);
  tomorrow.setUTCMilliseconds(0);
  return tomorrow;
}

// ─── Due reminder detection ───────────────────────────────────────────────────

/**
 * Query appointments for confirmed appointments with due reminders.
 * Returns reminders that haven't been sent yet and whether to send now or defer.
 */
export async function findDueReminders(): Promise<DueReminder[]> {
  const db = getDb();
  const now = new Date();

  const appointments = await db('appointments')
    .select(
      'appointments.id',
      'appointments.client_phone',
      'appointments.starts_at',
      'appointments.service_id',
      'appointments.reminder_24h_sent_at',
      'appointments.reminder_12h_sent_at',
      'appointments.reminder_2h_sent_at',
      'appointments.reminder_morning_sent_at',
      'services.name as service_name'
    )
    .join('services', 'appointments.service_id', 'services.id')
    .where('appointments.status', 'confirmed');

  const reminders: DueReminder[] = [];

  for (const appt of appointments) {
    const apptTime = new Date(appt.starts_at);
    const hoursUntilAppt = (apptTime.getTime() - now.getTime()) / (1000 * 60 * 60);

    // 24h reminder: window 27h–23h before appointment
    if (hoursUntilAppt <= 27 && hoursUntilAppt > 23 && !appt.reminder_24h_sent_at) {
      const shouldSend = await isWithinSendingWindow(now);
      reminders.push({
        appointmentId: appt.id,
        clientPhone: appt.client_phone,
        appointmentTime: appt.starts_at,
        reminderType: '24h',
        shouldSendNow: shouldSend,
        nextSendAt: !shouldSend ? (await getNextWindowStart(now)).toISOString() : undefined,
      });
    }

    // 12h reminder: window 15h–11h before appointment
    if (hoursUntilAppt <= 15 && hoursUntilAppt > 11 && !appt.reminder_12h_sent_at) {
      const shouldSend = await isWithinSendingWindow(now);
      reminders.push({
        appointmentId: appt.id,
        clientPhone: appt.client_phone,
        appointmentTime: appt.starts_at,
        reminderType: '12h',
        shouldSendNow: shouldSend,
        nextSendAt: !shouldSend ? (await getNextWindowStart(now)).toISOString() : undefined,
      });
    }

    // 2h reminder: window 5h–1h before appointment
    if (hoursUntilAppt <= 5 && hoursUntilAppt > 1 && !appt.reminder_2h_sent_at) {
      const shouldSend = await isWithinSendingWindow(now);
      reminders.push({
        appointmentId: appt.id,
        clientPhone: appt.client_phone,
        appointmentTime: appt.starts_at,
        reminderType: '2h',
        shouldSendNow: shouldSend,
        nextSendAt: !shouldSend ? (await getNextWindowStart(now)).toISOString() : undefined,
      });
    }

    // Morning reminder: 30 min before opening, on the day of the appointment
    // Window: appointment is today (PT-BR) and reminder not yet sent
    if (!appt.reminder_morning_sent_at) {
      const apptPtbrDay = new Date(
        apptTime.getTime() + PT_BR_TZ_OFFSET * 60 * 60 * 1000
      ).toISOString().slice(0, 10);
      const nowPtbrDay = new Date(
        now.getTime() + PT_BR_TZ_OFFSET * 60 * 60 * 1000
      ).toISOString().slice(0, 10);

      if (apptPtbrDay === nowPtbrDay && hoursUntilAppt > 0) {
        // Due when current PT-BR time is between (open_time - 30 min) and open_time
        const ptbrDayOfWeek = new Date(
          now.getTime() + PT_BR_TZ_OFFSET * 60 * 60 * 1000
        ).getUTCDay();

        const wh = await db('working_hours')
          .where({ chair_id: DEFAULT_CHAIR_ID, day_of_week: ptbrDayOfWeek })
          .first() as WorkingHours | undefined;

        if (wh && !wh.is_closed && wh.open_time) {
          const [oh, om] = wh.open_time.split(':').map(Number);
          const openMinutes = oh * 60 + (om ?? 0);
          const nowMinutes = ptbrHour(now) * 60 + ptbrMinute(now);
          const windowStart = openMinutes - 30;

          if (nowMinutes >= windowStart && nowMinutes < openMinutes) {
            reminders.push({
              appointmentId: appt.id,
              clientPhone: appt.client_phone,
              appointmentTime: appt.starts_at,
              reminderType: 'morning',
              shouldSendNow: true,
            });
          }
        }
      }
    }
  }

  return reminders;
}

// ─── Send & mark ─────────────────────────────────────────────────────────────

/**
 * Send a reminder message via WAHA and mark the flag in the database.
 */
export async function sendReminder(
  reminder: DueReminder,
  phone: string
): Promise<void> {
  const message = formatReminderMessage(reminder);

  try {
    await sendText(phone, message);
    await markReminderSent(reminder.appointmentId, reminder.reminderType);
  } catch (err) {
    log.error(
      maskPhone(phone), 'REMINDER',
      `Failed to send ${reminder.reminderType} reminder for appointment ${reminder.appointmentId}: ${err instanceof Error ? err.message : String(err)}`
    );
    // Do NOT mark as sent on failure — will retry on next run
  }
}

/**
 * Update the reminder flag in the database after successful send.
 */
export async function markReminderSent(
  appointmentId: number,
  reminderType: ReminderType
): Promise<void> {
  const db = getDb();
  const columnMap: Record<ReminderType, string> = {
    '24h': 'reminder_24h_sent_at',
    '12h': 'reminder_12h_sent_at',
    '2h': 'reminder_2h_sent_at',
    'morning': 'reminder_morning_sent_at',
  };

  await db('appointments')
    .where('id', appointmentId)
    .update({ [columnMap[reminderType]]: new Date().toISOString() });
}

// ─── Message formatting ───────────────────────────────────────────────────────

function formatReminderMessage(reminder: DueReminder): string {
  const apptTime = new Date(reminder.appointmentTime);
  const timeStr = apptTime.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });

  if (reminder.reminderType === '24h') {
    return `✂️ Ei! Não esquece do seu corte amanhã às ${timeStr} 😊`;
  }

  if (reminder.reminderType === '12h') {
    return `⏰ Seu corte é em 12 horas (${timeStr}). Até já!`;
  }

  if (reminder.reminderType === 'morning') {
    return `☀️ Bom dia! Lembrete: você tem um corte hoje às ${timeStr}. A gente te espera!`;
  }

  // 2h reminder
  return `🔔 Falta só 2 horas pro seu corte (${timeStr}). A gente te espera!`;
}

// ─── Legacy sync export (kept for backward compat with existing tests) ────────

/**
 * @deprecated Use isWithinSendingWindow (async, reads open_time from DB).
 * This sync version uses a hardcoded 08:00 lower bound.
 */
export function isWithinBusinessHours(date: Date): boolean {
  const hour = ptbrHour(date);
  return hour >= 8 && hour < 21;
}
