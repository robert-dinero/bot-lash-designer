import { describe, it, expect, beforeEach } from 'vitest';
import { getAvailableSlots, validateAppointmentTime, createAppointment, deriveStep, rescheduleAppointment } from '../appointment.service';
import type { AppointmentState } from '../../types';
import { getDb } from '../../db';

describe('appointment.service', () => {
  let db: any;

  beforeEach(async () => {
    db = getDb();
    // Clear tables before each test
    await db('appointments').del();
    await db('availability_blocks').del();
  });

  describe('getAvailableSlots', () => {
    it('should return 30-min slots for Monday 09:00-19:00 with no conflicts', async () => {
      // Use noon UTC so local day matches UTC day across any timezone offset (±12h)
      const monday = new Date('2026-05-18T12:00:00Z'); // Monday in any timezone

      const slots = await getAvailableSlots(1, monday, 30);

      // 09:00–19:00 = 20 slots de 30 min; sem almoço = 20 slots disponíveis
      expect(slots.length).toBeGreaterThan(0);
      expect(slots.length).toBeLessThanOrEqual(20);
    });

    it('should return empty array for Sunday (closed)', async () => {
      const sunday = new Date('2026-05-17T12:00:00Z'); // Sunday in any timezone

      const slots = await getAvailableSlots(1, sunday, 30);

      expect(slots).toEqual([]);
    });

    it('should skip booked slots', async () => {
      const monday = new Date('2026-05-18T12:00:00Z');

      // Insert an appointment at 10:00 local time (same calendar day)
      const apptStart = new Date(monday);
      apptStart.setHours(10, 0, 0, 0);

      await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999999',
        client_name: null,
        service_id: 1,
        starts_at: apptStart.toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const slots = await getAvailableSlots(1, monday, 30);

      // 10:00 slot should not be in the available slots
      const tenOclock = slots.find(s => s.getHours() === 10 && s.getMinutes() === 0);
      expect(tenOclock).toBeUndefined();

      // 09:00, 09:30, 11:00 should be available
      expect(slots.some(s => s.getHours() === 9 && s.getMinutes() === 0)).toBe(true);
      expect(slots.some(s => s.getHours() === 9 && s.getMinutes() === 30)).toBe(true);
      expect(slots.some(s => s.getHours() === 11 && s.getMinutes() === 0)).toBe(true);
    });

    it('should skip availability blocks (lunch)', async () => {
      const monday = new Date('2026-05-18T12:00:00Z');

      // Insert availability block 14:00-15:00 (lunch) using local hours
      const blockStart = new Date(monday);
      blockStart.setHours(14, 0, 0, 0);
      const blockEnd = new Date(monday);
      blockEnd.setHours(15, 0, 0, 0);

      await db('availability_blocks').insert({
        chair_id: 1,
        starts_at: blockStart.toISOString(),
        ends_at: blockEnd.toISOString(),
        reason: 'Lunch break',
      });

      const slots = await getAvailableSlots(1, monday, 30);

      // 14:00 and 14:30 should be skipped (blocked)
      expect(slots.some(s => s.getHours() === 14 && s.getMinutes() === 0)).toBe(false);
      expect(slots.some(s => s.getHours() === 14 && s.getMinutes() === 30)).toBe(false);

      // First slot (09:00) and second slot (09:30) should be in the returned 8-slot window
      expect(slots.some(s => s.getHours() === 9 && s.getMinutes() === 0)).toBe(true);
      expect(slots.some(s => s.getHours() === 9 && s.getMinutes() === 30)).toBe(true);
    });

    it('should throw error for non-existent chair', async () => {
      const monday = new Date('2026-05-18T12:00:00Z');

      await expect(getAvailableSlots(999, monday, 30)).rejects.toThrow('Chair not found');
    });
  });

  describe('validateAppointmentTime', () => {
    it('should return true for available slot', async () => {
      const slotTime = new Date('2026-05-18T12:00:00Z'); // Monday noon UTC
      slotTime.setHours(10, 0, 0, 0); // 10:00 local time (within working hours)

      const valid = await validateAppointmentTime(1, slotTime, 30);

      expect(valid).toBe(true);
    });

    it('should return false for booked slot', async () => {
      const bookedTime = new Date('2026-05-18T12:00:00Z');
      bookedTime.setHours(10, 0, 0, 0);

      // Insert conflicting appointment
      await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511999999999',
        client_name: null,
        service_id: 1,
        starts_at: bookedTime.toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const valid = await validateAppointmentTime(1, bookedTime, 30);

      expect(valid).toBe(false);
    });

    it('should return false for time outside working hours', async () => {
      const earlyTime = new Date('2026-05-18T12:00:00Z');
      earlyTime.setHours(7, 0, 0, 0); // 07:00 local — before 09:00 open

      const valid = await validateAppointmentTime(1, earlyTime, 30);

      expect(valid).toBe(false);
    });

    it('should return false for closed day (Sunday)', async () => {
      const slotTime = new Date('2026-05-17T12:00:00Z'); // Sunday noon UTC
      slotTime.setHours(10, 0, 0, 0);

      const valid = await validateAppointmentTime(1, slotTime, 30);

      expect(valid).toBe(false);
    });
  });

  describe('createAppointment', () => {
    it('should create appointment with valid time', async () => {
      const slotTime = new Date('2026-05-18T12:00:00Z');
      slotTime.setHours(10, 0, 0, 0);

      const appt = await createAppointment(1, '5511999999999', 1, slotTime, 30);

      expect(appt.id).toBeDefined();
      expect(appt.chair_id).toBe(1);
      expect(appt.client_phone).toBe('5511999999999');
      expect(appt.service_id).toBe(1);
      expect(appt.duration_minutes).toBe(30);
      expect(appt.status).toBe('confirmed');
    });

    it('should throw error for conflicting time', async () => {
      const slotTime = new Date('2026-05-18T12:00:00Z');
      slotTime.setHours(10, 0, 0, 0);

      // Insert conflicting appointment
      await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511888888888',
        client_name: null,
        service_id: 1,
        starts_at: slotTime.toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      await expect(
        createAppointment(1, '5511999999999', 1, slotTime, 30)
      ).rejects.toThrow('Time slot not available');
    });
  });

  describe('deriveStep', () => {
    it('should return AGUARDANDO_SERVICO when nothing is set', () => {
      const state: AppointmentState = { confirmed: false };
      expect(deriveStep(state)).toBe('AGUARDANDO_SERVICO');
    });

    it('should return AGUARDANDO_DATA_HORA when service is set', () => {
      const state: AppointmentState = {
        service: 'Corte',
        confirmed: false,
      };
      expect(deriveStep(state)).toBe('AGUARDANDO_DATA_HORA');
    });

    it('should return AGUARDANDO_CONFIRMACAO_HORARIO when requestedDateTime is set', () => {
      const state: AppointmentState = {
        service: 'Corte',
        requestedDateTime: 'amanhã às 10h',
        confirmed: false,
      };
      expect(deriveStep(state)).toBe('AGUARDANDO_CONFIRMACAO_HORARIO');
    });

    it('should return AGUARDANDO_CONFIRMACAO when confirmedDateTime is set (name collected by system gate)', () => {
      const state: AppointmentState = {
        service: 'Corte',
        requestedDateTime: 'amanhã às 10h',
        confirmedDateTime: '2026-05-19T10:00:00Z',
        confirmed: false,
      };
      expect(deriveStep(state)).toBe('AGUARDANDO_CONFIRMACAO');
    });

    it('should return AGUARDANDO_CONFIRMACAO when confirmedDateTime and clientName are set', () => {
      const state: AppointmentState = {
        service: 'Corte',
        clientName: 'João',
        requestedDateTime: 'amanhã às 10h',
        confirmedDateTime: '2026-05-19T10:00:00Z',
        confirmed: false,
      };
      expect(deriveStep(state)).toBe('AGUARDANDO_CONFIRMACAO');
    });

    it('should return CONFIRMADO when confirmed is true', () => {
      const state: AppointmentState = {
        service: 'Corte',
        clientName: 'João',
        confirmedDateTime: '2026-05-19T10:00:00Z',
        confirmed: true,
      };
      expect(deriveStep(state)).toBe('CONFIRMADO');
    });
  });

  describe('rescheduleAppointment', () => {
    it('should mark old appointment as rescheduled and return a new confirmed appointment', async () => {
      // Create original appointment at 10:00 on a Monday
      const monday = new Date('2026-05-18T12:00:00Z');
      const oldStart = new Date(monday);
      oldStart.setHours(10, 0, 0, 0);

      const [oldId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511111111111',
        client_name: 'João',
        service_id: 1,
        starts_at: oldStart.toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Reschedule to 11:00 on the same day
      const newStart = new Date(monday);
      newStart.setHours(11, 0, 0, 0);

      const newAppt = await rescheduleAppointment(oldId, '5511111111111', 1, 1, newStart, 30, 'João');

      // Old appointment should be rescheduled
      const old = await db('appointments').where('id', oldId).first();
      expect(old.status).toBe('rescheduled');

      // New appointment should be confirmed
      expect(newAppt.status).toBe('confirmed');
      expect(newAppt.client_phone).toBe('5511111111111');
      expect(newAppt.id).not.toBe(oldId);
    });

    it('should throw an error if old appointment does not belong to the given phone', async () => {
      const monday = new Date('2026-05-18T12:00:00Z');
      const oldStart = new Date(monday);
      oldStart.setHours(10, 0, 0, 0);

      const [oldId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511111111111',
        client_name: 'João',
        service_id: 1,
        starts_at: oldStart.toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const newStart = new Date(monday);
      newStart.setHours(11, 0, 0, 0);

      await expect(
        rescheduleAppointment(oldId, '5599999999999', 1, 1, newStart, 30)
      ).rejects.toThrow();
    });

    it('should throw an error if old appointment is not confirmed', async () => {
      const monday = new Date('2026-05-18T12:00:00Z');
      const oldStart = new Date(monday);
      oldStart.setHours(10, 0, 0, 0);

      const [oldId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511222222222',
        client_name: 'Maria',
        service_id: 1,
        starts_at: oldStart.toISOString(),
        duration_minutes: 30,
        status: 'cancelled',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const newStart = new Date(monday);
      newStart.setHours(11, 0, 0, 0);

      await expect(
        rescheduleAppointment(oldId, '5511222222222', 1, 1, newStart, 30)
      ).rejects.toThrow();
    });
  });

  describe('getAvailableSlots with excludeAppointmentId', () => {
    it('should exclude the given appointment slot when excludeAppointmentId is provided', async () => {
      const monday = new Date('2026-05-18T12:00:00Z');
      const bookedStart = new Date(monday);
      bookedStart.setHours(10, 0, 0, 0);

      const [apptId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511333333333',
        client_name: null,
        service_id: 1,
        starts_at: bookedStart.toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Without exclude: 10:00 should be blocked
      const slotsWithout = await getAvailableSlots(1, monday, 30);
      expect(slotsWithout.some(s => s.getHours() === 10 && s.getMinutes() === 0)).toBe(false);

      // With exclude: 10:00 should be available again
      const slotsWith = await getAvailableSlots(1, monday, 30, apptId);
      expect(slotsWith.some(s => s.getHours() === 10 && s.getMinutes() === 0)).toBe(true);
    });
  });

  describe('validateAppointmentTime with excludeAppointmentId', () => {
    it('should return true for a slot occupied only by the excluded appointment', async () => {
      const monday = new Date('2026-05-18T12:00:00Z');
      const bookedStart = new Date(monday);
      bookedStart.setHours(10, 0, 0, 0);

      const [apptId] = await db('appointments').insert({
        chair_id: 1,
        client_phone: '5511444444444',
        client_name: null,
        service_id: 1,
        starts_at: bookedStart.toISOString(),
        duration_minutes: 30,
        status: 'confirmed',
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Without exclude: slot is taken
      const validWithout = await validateAppointmentTime(1, bookedStart, 30);
      expect(validWithout).toBe(false);

      // With exclude: slot appears free
      const validWith = await validateAppointmentTime(1, bookedStart, 30, apptId);
      expect(validWith).toBe(true);
    });
  });
});
