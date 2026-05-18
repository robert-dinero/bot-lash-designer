import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  decideCancellation,
  cancelAppointment,
  escalateCancellation,
} from '../cancellation.service';
import { getDb } from '../../db';
import type { Appointment } from '../../types';

describe('cancellation.service', () => {
  let db: any;

  beforeEach(() => {
    vi.useFakeTimers();
    db = getDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('decideCancellation', () => {
    it('should allow cancellation if > 6 hours before appointment', async () => {
      // Set current time
      vi.setSystemTime(new Date('2026-05-12T09:00:00Z'));

      // Create appointment 8 hours in future
      await db('appointments').insert({
        id: 1,
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: '2026-05-12T17:00:00Z', // 8 hours away
        duration_minutes: 30,
        status: 'confirmed',
      });

      const decision = await decideCancellation(1, '5511999999999');

      expect(decision.allowed).toBe(true);
      expect(decision.hoursUntilAppointment).toBeGreaterThan(6);
      expect(decision.shouldNotifyOwner).toBe(false);
      expect(decision.clientMessage).toContain('✅');
    });

    it('should deny cancellation if <= 6 hours before appointment', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      // Create appointment 5 hours in future
      await db('appointments').insert({
        id: 2,
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: '2026-05-12T15:00:00Z', // 5 hours away
        duration_minutes: 30,
        status: 'confirmed',
      });

      const decision = await decideCancellation(2, '5511999999999');

      expect(decision.allowed).toBe(false);
      expect(decision.hoursUntilAppointment).toBeLessThanOrEqual(6);
      expect(decision.deadlineHour).toBe(9); // 15:00 - 6h = 09:00
      expect(decision.shouldNotifyOwner).toBe(true);
      expect(decision.clientMessage).toContain('09');
    });

    it('should return not found if appointment does not exist', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      const decision = await decideCancellation(999, '5511999999999');

      expect(decision.allowed).toBe(false);
      expect(decision.clientMessage).toContain('Agendamento não encontrado');
      expect(decision.shouldNotifyOwner).toBe(false);
    });

    it('should return error if appointment is not confirmed', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      // Create cancelled appointment
      await db('appointments').insert({
        id: 3,
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: '2026-05-12T15:00:00Z',
        duration_minutes: 30,
        status: 'cancelled',
      });

      const decision = await decideCancellation(3, '5511999999999');

      expect(decision.allowed).toBe(false);
      expect(decision.clientMessage).toContain('já foi');
      expect(decision.shouldNotifyOwner).toBe(false);
    });

    it('should match appointment by phone', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      // Create appointment for different phone
      await db('appointments').insert({
        id: 4,
        chair_id: 1,
        client_phone: '5511888888888',
        service_id: 1,
        starts_at: '2026-05-12T17:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
      });

      const decision = await decideCancellation(4, '5511999999999');

      expect(decision.allowed).toBe(false);
      expect(decision.clientMessage).toContain('Agendamento não encontrado');
    });

    it('should handle appointment exactly at 6-hour boundary', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      // Create appointment exactly 6 hours away
      await db('appointments').insert({
        id: 5,
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: '2026-05-12T16:00:00Z', // Exactly 6 hours away
        duration_minutes: 30,
        status: 'confirmed',
      });

      const decision = await decideCancellation(5, '5511999999999');

      // At exactly 6 hours, should deny (escalate)
      expect(decision.allowed).toBe(false);
      expect(decision.shouldNotifyOwner).toBe(true);
    });

    it('should handle appointment in the past', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      // Create appointment 2 hours in the past
      await db('appointments').insert({
        id: 6,
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: '2026-05-12T08:00:00Z', // 2 hours ago
        duration_minutes: 30,
        status: 'confirmed',
      });

      const decision = await decideCancellation(6, '5511999999999');

      expect(decision.allowed).toBe(false);
      expect(decision.hoursUntilAppointment).toBeLessThan(0);
      expect(decision.shouldNotifyOwner).toBe(true);
    });
  });

  describe('cancelAppointment', () => {
    it('should update appointment status to cancelled', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      await db('appointments').insert({
        id: 10,
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: '2026-05-12T17:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
      });

      await cancelAppointment(10);

      const updated = await db('appointments').where('id', 10).first();
      expect(updated.status).toBe('cancelled');
      expect(updated.cancelled_at).not.toBeNull();
      expect(updated.escalation_status).toBeNull();
    });

    it('should be idempotent (calling twice is safe)', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      await db('appointments').insert({
        id: 11,
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: '2026-05-12T17:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
      });

      // Cancel twice
      await cancelAppointment(11);
      await cancelAppointment(11);

      const updated = await db('appointments').where('id', 11).first();
      expect(updated.status).toBe('cancelled');
    });

    it('should throw if appointment not found', async () => {
      await expect(() => cancelAppointment(999)).rejects.toThrow('Appointment 999 not found');
    });
  });

  describe('escalateCancellation', () => {
    it('should set escalation_status to pending', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      await db('appointments').insert({
        id: 20,
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: '2026-05-12T13:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
      });

      await escalateCancellation(20, '5511999999999');

      const updated = await db('appointments').where('id', 20).first();
      expect(updated.escalation_status).toBe('pending');
      expect(updated.cancelled_at).not.toBeNull();
      expect(updated.status).toBe('confirmed'); // NOT changed to cancelled
    });

    it('should be idempotent', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      await db('appointments').insert({
        id: 21,
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: '2026-05-12T13:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
      });

      // Escalate twice
      await escalateCancellation(21, '5511999999999');
      await escalateCancellation(21, '5511999999999');

      const updated = await db('appointments').where('id', 21).first();
      expect(updated.escalation_status).toBe('pending');
      expect(updated.status).toBe('confirmed');
    });

    it('should match by phone', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      await db('appointments').insert({
        id: 22,
        chair_id: 1,
        client_phone: '5511888888888',
        service_id: 1,
        starts_at: '2026-05-12T13:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
      });

      // Escalate with wrong phone — should be idempotent (no-op)
      await escalateCancellation(22, '5511999999999');

      const updated = await db('appointments').where('id', 22).first();
      expect(updated.escalation_status).toBeNull();
    });
  });

  describe('concurrent cancellation safety', () => {
    it('should handle two concurrent cancel requests idempotently', async () => {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

      await db('appointments').insert({
        id: 30,
        chair_id: 1,
        client_phone: '5511999999999',
        service_id: 1,
        starts_at: '2026-05-12T17:00:00Z',
        duration_minutes: 30,
        status: 'confirmed',
      });

      // Fire both concurrently
      const results = await Promise.all([
        cancelAppointment(30),
        cancelAppointment(30),
      ]);

      // Both should complete without error
      expect(results).toHaveLength(2);

      // Verify single canonical state
      const final = await db('appointments').where('id', 30).first();
      expect(final.status).toBe('cancelled');
      expect(final.cancelled_at).not.toBeNull();
    });
  });
});
