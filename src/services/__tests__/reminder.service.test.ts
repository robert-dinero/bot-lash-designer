import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findDueReminders,
  sendReminder,
  markReminderSent,
  isWithinBusinessHours,
  isWithinSendingWindow,
} from '../reminder.service';
import * as waha from '../waha.service';
import { getDb } from '../../db';

// Mock waha.service
vi.mock('../waha.service', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
}));

describe('reminder.service', () => {
  let db: any;

  beforeEach(() => {
    vi.useFakeTimers();
    db = getDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('isWithinBusinessHours', () => {
    it('should return true for time between 8am and 9pm PT-BR', () => {
      // 14:00 (2pm) is always within business hours
      vi.setSystemTime(new Date('2026-05-12T14:00:00Z'));
      expect(isWithinBusinessHours(new Date())).toBe(true);
    });

    it('should return false before 8am PT-BR', () => {
      // Set to UTC time that corresponds to before 8am PT-BR
      // PT-BR is UTC-3, so 10:00 UTC = 07:00 PT-BR
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));
      expect(isWithinBusinessHours(new Date())).toBe(false);
    });

    it('should return false after 9pm PT-BR', () => {
      // PT-BR is UTC-3, so 00:30 UTC = 21:30 PT-BR
      vi.setSystemTime(new Date('2026-05-13T00:30:00Z'));
      expect(isWithinBusinessHours(new Date())).toBe(false);
    });

    it('should return false for early morning', () => {
      // 05:30 UTC = 02:30 PT-BR
      vi.setSystemTime(new Date('2026-05-12T05:30:00Z'));
      expect(isWithinBusinessHours(new Date())).toBe(false);
    });

    it('should return false for late night', () => {
      // 23:00 UTC = 20:00 PT-BR (actually within hours), 02:00 UTC = 23:00 PT-BR
      vi.setSystemTime(new Date('2026-05-12T02:00:00Z'));
      expect(isWithinBusinessHours(new Date())).toBe(false);
    });
  });

  describe('findDueReminders', () => {
    it('should return 24h reminders when due', async () => {
      // Setup: Create appointment starting 24.04 hours from now
      const appointmentTime = new Date();
      appointmentTime.setHours(appointmentTime.getHours() + 24.04);

      await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: appointmentTime.toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminders = await findDueReminders();

      // Filter for 24h reminders
      const reminder24h = reminders.find((r) => r.reminderType === '24h');
      expect(reminder24h).toBeDefined();
      expect(reminder24h?.clientPhone).toBe('5511999999999');
    });

    it('should exclude cancelled appointments', async () => {
      // Setup: Create cancelled appointment
      const appointmentTime = new Date();
      appointmentTime.setHours(appointmentTime.getHours() + 24.04);

      await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: appointmentTime.toISOString(),
        duration_minutes: 30,
        status: 'cancelled',
      });

      const reminders = await findDueReminders();

      // Should not find any reminders for cancelled appointment
      const appointmentReminders = reminders.filter(
        (r) => r.clientPhone === '5511999999999'
      );
      expect(appointmentReminders.length).toBe(0);
    });

    it('should exclude already-sent reminders', async () => {
      // Setup: Create appointment with reminder already sent
      const appointmentTime = new Date();
      appointmentTime.setHours(appointmentTime.getHours() + 24.04);

      await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999998',
        service_id: 1,
        starts_at: appointmentTime.toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
        reminder_24h_sent_at: new Date().toISOString(),
      });

      const reminders = await findDueReminders();

      // Filter for 24h reminders for this phone
      const reminder24h = reminders.find(
        (r) => r.reminderType === '24h' && r.clientPhone === '5511999999998'
      );
      expect(reminder24h).toBeUndefined();
    });

    it('should set shouldSendNow correctly based on business hours', async () => {
      // Setup time within business hours (14:00 UTC = 11:00 PT-BR)
      vi.setSystemTime(new Date('2026-05-12T14:00:00Z'));

      const appointmentTime = new Date();
      appointmentTime.setHours(appointmentTime.getHours() + 24.04);

      await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999997',
        service_id: 1,
        starts_at: appointmentTime.toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminders = await findDueReminders();
      const reminder24h = reminders.find(
        (r) =>
          r.reminderType === '24h' && r.clientPhone === '5511999999997'
      );

      expect(reminder24h?.shouldSendNow).toBe(true);
    });
  });

  describe('markReminderSent', () => {
    it('should update reminder_24h_sent_at for 24h type', async () => {
      // Setup: Create appointment
      const [appointmentId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999996',
        service_id: 1,
        starts_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      // Set a known time
      vi.setSystemTime(new Date('2026-05-12T15:00:00Z'));

      // Mark as sent
      await markReminderSent(appointmentId, '24h');

      // Verify
      const appt = await db('appointments').where('id', appointmentId).first();
      expect(appt.reminder_24h_sent_at).not.toBeNull();
    });

    it('should update reminder_12h_sent_at for 12h type', async () => {
      // Setup: Create appointment
      const [appointmentId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999995',
        service_id: 1,
        starts_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      // Mark as sent
      await markReminderSent(appointmentId, '12h');

      // Verify
      const appt = await db('appointments').where('id', appointmentId).first();
      expect(appt.reminder_12h_sent_at).not.toBeNull();
    });

    it('should update reminder_2h_sent_at for 2h type', async () => {
      // Setup: Create appointment
      const [appointmentId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999994',
        service_id: 1,
        starts_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      // Mark as sent
      await markReminderSent(appointmentId, '2h');

      // Verify
      const appt = await db('appointments').where('id', appointmentId).first();
      expect(appt.reminder_2h_sent_at).not.toBeNull();
    });
  });

  describe('sendReminder', () => {
    it('should call sendText with formatted message', async () => {
      const mockSendText = vi.spyOn(waha, 'sendText');

      const [apptId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999993',
        service_id: 1,
        starts_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminder = {
        appointmentId: apptId,
        clientPhone: '5511999999993',
        appointmentTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        reminderType: '24h' as const,
        shouldSendNow: true,
      };

      await sendReminder(reminder, reminder.clientPhone);

      expect(mockSendText).toHaveBeenCalledWith(
        '5511999999993',
        expect.stringContaining('corte')
      );
    });

    it('should mark reminder sent after successful send', async () => {
      const [apptId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999992',
        service_id: 1,
        starts_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminder = {
        appointmentId: apptId,
        clientPhone: '5511999999992',
        appointmentTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        reminderType: '24h' as const,
        shouldSendNow: true,
      };

      await sendReminder(reminder, reminder.clientPhone);

      const appt = await db('appointments').where('id', apptId).first();
      expect(appt.reminder_24h_sent_at).not.toBeNull();
    });

    it('should not mark reminder sent if send fails', async () => {
      const mockSendText = vi.spyOn(waha, 'sendText');
      mockSendText.mockRejectedValueOnce(new Error('Send failed'));

      const [apptId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999991',
        service_id: 1,
        starts_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminder = {
        appointmentId: apptId,
        clientPhone: '5511999999991',
        appointmentTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        reminderType: '24h' as const,
        shouldSendNow: true,
      };

      await sendReminder(reminder, reminder.clientPhone);

      const appt = await db('appointments').where('id', apptId).first();
      expect(appt.reminder_24h_sent_at).toBeNull();
    });

    it('should format 12h message correctly', async () => {
      const mockSendText = vi.spyOn(waha, 'sendText');

      const [apptId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999990',
        service_id: 1,
        starts_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminder = {
        appointmentId: apptId,
        clientPhone: '5511999999990',
        appointmentTime: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        reminderType: '12h' as const,
        shouldSendNow: true,
      };

      await sendReminder(reminder, reminder.clientPhone);

      const lastCall = mockSendText.mock.calls[mockSendText.mock.calls.length - 1];
      expect(lastCall[1]).toContain('12 horas');
    });

    it('should format 2h message correctly', async () => {
      const mockSendText = vi.spyOn(waha, 'sendText');

      const [apptId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999989',
        service_id: 1,
        starts_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminder = {
        appointmentId: apptId,
        clientPhone: '5511999999989',
        appointmentTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        reminderType: '2h' as const,
        shouldSendNow: true,
      };

      await sendReminder(reminder, reminder.clientPhone);

      const lastCall = mockSendText.mock.calls[mockSendText.mock.calls.length - 1];
      expect(lastCall[1]).toContain('2 horas');
    });

    it('should format morning message correctly', async () => {
      const mockSendText = vi.spyOn(waha, 'sendText');

      const [apptId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999988',
        service_id: 1,
        starts_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminder = {
        appointmentId: apptId,
        clientPhone: '5511999999988',
        appointmentTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        reminderType: 'morning' as const,
        shouldSendNow: true,
      };

      await sendReminder(reminder, reminder.clientPhone);

      const lastCall = mockSendText.mock.calls[mockSendText.mock.calls.length - 1];
      expect(lastCall[1]).toContain('hoje');
    });

    it('should update reminder_morning_sent_at for morning type', async () => {
      const [apptId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999987',
        service_id: 1,
        starts_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
      });

      await markReminderSent(apptId, 'morning');

      const appt = await db('appointments').where('id', apptId).first();
      expect(appt.reminder_morning_sent_at).not.toBeNull();
    });
  });

  describe('isWithinSendingWindow', () => {
    it('should return false after 21h PT-BR', async () => {
      // 00:30 UTC = 21:30 PT-BR (UTC-3)
      vi.setSystemTime(new Date('2026-05-13T00:30:00Z'));
      expect(await isWithinSendingWindow(new Date())).toBe(false);
    });

    it('should return false before establishment opens (before open_time - 30min)', async () => {
      // Working hours seeded: Mon–Sat 09:00. Window starts 08:30.
      // 11:00 UTC = 08:00 PT-BR — before 08:30 (30 min before 09:00)
      // 2026-05-12 is Tuesday (day_of_week=2), open 09:00
      vi.setSystemTime(new Date('2026-05-12T11:00:00Z'));
      expect(await isWithinSendingWindow(new Date())).toBe(false);
    });

    it('should return true at 30 min before opening (08:30 PT-BR for 09:00 open)', async () => {
      // 11:30 UTC = 08:30 PT-BR — exactly at window start
      vi.setSystemTime(new Date('2026-05-12T11:30:00Z'));
      expect(await isWithinSendingWindow(new Date())).toBe(true);
    });

    it('should return true during business hours', async () => {
      // 14:00 UTC = 11:00 PT-BR — well within window
      vi.setSystemTime(new Date('2026-05-12T14:00:00Z'));
      expect(await isWithinSendingWindow(new Date())).toBe(true);
    });
  });

  describe('morning reminder detection', () => {
    it('should detect morning reminder 30 min before opening on appointment day', async () => {
      // 2026-05-12 is Tuesday, open 09:00. Window: 08:30–09:00 PT-BR = 11:30–12:00 UTC
      vi.setSystemTime(new Date('2026-05-12T11:35:00Z')); // 08:35 PT-BR

      // Appointment later today (say 14:00 PT-BR = 17:00 UTC)
      const [apptId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999986',
        service_id: 1,
        starts_at: '2026-05-12T17:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminders = await findDueReminders();
      const morning = reminders.find(r => r.reminderType === 'morning' && r.clientPhone === '5511999999986');
      expect(morning).toBeDefined();
      expect(morning?.shouldSendNow).toBe(true);
    });

    it('should not send morning reminder outside the 30-min window (too early)', async () => {
      // 11:00 UTC = 08:00 PT-BR — before 08:30 window start
      vi.setSystemTime(new Date('2026-05-12T11:00:00Z'));

      await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999985',
        service_id: 1,
        starts_at: '2026-05-12T17:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminders = await findDueReminders();
      const morning = reminders.find(r => r.reminderType === 'morning' && r.clientPhone === '5511999999985');
      expect(morning).toBeUndefined();
    });

    it('should not send morning reminder after opening time', async () => {
      // 12:30 UTC = 09:30 PT-BR — after 09:00 opening, window already passed
      vi.setSystemTime(new Date('2026-05-12T12:30:00Z'));

      await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999984',
        service_id: 1,
        starts_at: '2026-05-12T17:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminders = await findDueReminders();
      const morning = reminders.find(r => r.reminderType === 'morning' && r.clientPhone === '5511999999984');
      expect(morning).toBeUndefined();
    });

    it('should not send morning reminder for appointment on a different day', async () => {
      // 11:35 UTC = 08:35 PT-BR on 2026-05-12 (Tuesday)
      vi.setSystemTime(new Date('2026-05-12T11:35:00Z'));

      // Appointment tomorrow
      await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999983',
        service_id: 1,
        starts_at: '2026-05-13T17:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
      });

      const reminders = await findDueReminders();
      const morning = reminders.find(r => r.reminderType === 'morning' && r.clientPhone === '5511999999983');
      expect(morning).toBeUndefined();
    });

    it('should not resend morning reminder if already sent', async () => {
      vi.setSystemTime(new Date('2026-05-12T11:35:00Z'));

      await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999982',
        service_id: 1,
        starts_at: '2026-05-12T17:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
        reminder_morning_sent_at: new Date().toISOString(),
      });

      const reminders = await findDueReminders();
      const morning = reminders.find(r => r.reminderType === 'morning' && r.clientPhone === '5511999999982');
      expect(morning).toBeUndefined();
    });
  });
});
