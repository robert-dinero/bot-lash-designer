import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cancelAppointment,
  escalateCancellation,
  decideCancellation,
} from '../services/cancellation.service';
import { getDb } from '../db';

describe('Concurrent Cancellation E2E Tests', () => {
  let db: any;

  beforeEach(() => {
    vi.useFakeTimers();
    db = getDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should handle two concurrent cancellation requests idempotently', async () => {
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

    // Create appointment
    const [appointmentId] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511999999999',
      service_id: 1,
      starts_at: '2026-05-12T18:00:00Z', // 8 hours away
      duration_minutes: 30,
      status: 'confirmed',
    });

    // Fire both cancel requests concurrently
    const results = await Promise.all([
      cancelAppointment(appointmentId),
      cancelAppointment(appointmentId),
    ]);

    // Both should complete without error
    expect(results).toHaveLength(2);

    // Verify single canonical state
    const final = await db('appointments').where('id', appointmentId).first();
    expect(final.status).toBe('cancelled');
    expect(final.cancelled_at).not.toBeNull();
  });

  it('should handle decision and cancel in rapid succession', async () => {
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

    // Create appointment
    const [appointmentId] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511999999999',
      service_id: 1,
      starts_at: '2026-05-12T18:00:00Z', // 8 hours away
      duration_minutes: 30,
      status: 'confirmed',
    });

    // Decide and cancel in quick succession
    const decision = await decideCancellation(appointmentId, '5511999999999');
    expect(decision.allowed).toBe(true);

    await cancelAppointment(appointmentId);

    const final = await db('appointments').where('id', appointmentId).first();
    expect(final.status).toBe('cancelled');
  });

  it('should prevent concurrent escalation and cancel race condition', async () => {
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

    // Create appointment 3 hours in future (should escalate)
    const [appointmentId] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511999999999',
      service_id: 1,
      starts_at: '2026-05-12T13:00:00Z', // 3 hours away
      duration_minutes: 30,
      status: 'confirmed',
    });

    // Escalate and simultaneously cancel (both should succeed independently)
    const [escalateResult, cancelResult] = await Promise.allSettled([
      escalateCancellation(appointmentId, '5511999999999'),
      cancelAppointment(appointmentId),
    ]);

    // Both should complete (escalate might no-op due to race, but cancel should work)
    expect(escalateResult.status).toBe('fulfilled');
    expect(cancelResult.status).toBe('fulfilled');

    // Final state should be consistent
    const final = await db('appointments').where('id', appointmentId).first();
    // Either cancelled or pending escalation, not corrupt
    expect(['cancelled', 'confirmed']).toContain(final.status);
    if (final.status === 'confirmed') {
      expect(final.escalation_status).toBe('pending');
    }
  });

  it('should handle rapid decide-decide-cancel sequence', async () => {
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

    // Create appointment
    const [appointmentId] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511999999999',
      service_id: 1,
      starts_at: '2026-05-12T18:00:00Z', // 8 hours away
      duration_minutes: 30,
      status: 'confirmed',
    });

    // Decide twice, then cancel
    const decision1 = await decideCancellation(appointmentId, '5511999999999');
    const decision2 = await decideCancellation(appointmentId, '5511999999999');
    await cancelAppointment(appointmentId);

    // Both decisions should be consistent
    expect(decision1.allowed).toBe(decision2.allowed);
    expect(decision1.hoursUntilAppointment).toBe(decision2.hoursUntilAppointment);

    // Final state should be cancelled
    const final = await db('appointments').where('id', appointmentId).first();
    expect(final.status).toBe('cancelled');
  });

  it('should handle three concurrent cancellations', async () => {
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

    // Create appointment
    const [appointmentId] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511999999999',
      service_id: 1,
      starts_at: '2026-05-12T18:00:00Z',
      duration_minutes: 30,
      status: 'confirmed',
    });

    // Three concurrent cancellations
    const results = await Promise.all([
      cancelAppointment(appointmentId),
      cancelAppointment(appointmentId),
      cancelAppointment(appointmentId),
    ]);

    expect(results).toHaveLength(3);

    const final = await db('appointments').where('id', appointmentId).first();
    expect(final.status).toBe('cancelled');
    expect(final.cancelled_at).not.toBeNull();
  });

  it('should maintain transaction isolation with concurrent escalations', async () => {
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

    // Create appointment
    const [appointmentId] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511999999999',
      service_id: 1,
      starts_at: '2026-05-12T13:00:00Z', // 3 hours away
      duration_minutes: 30,
      status: 'confirmed',
    });

    // Two concurrent escalations (both should succeed or second should no-op)
    const results = await Promise.all([
      escalateCancellation(appointmentId, '5511999999999'),
      escalateCancellation(appointmentId, '5511999999999'),
    ]);

    expect(results).toHaveLength(2);

    const final = await db('appointments').where('id', appointmentId).first();
    expect(final.escalation_status).toBe('pending');
    expect(final.status).toBe('confirmed'); // Not changed to cancelled
  });

  it('should handle different phone numbers in concurrent cancel attempts', async () => {
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));

    // Create two appointments
    const [apptId1] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511999999999',
      service_id: 1,
      starts_at: '2026-05-12T18:00:00Z',
      duration_minutes: 30,
      status: 'confirmed',
    });

    const [apptId2] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511888888888',
      service_id: 1,
      starts_at: '2026-05-12T18:00:00Z',
      duration_minutes: 30,
      status: 'confirmed',
    });

    // Cancel both concurrently
    const results = await Promise.all([
      cancelAppointment(apptId1),
      cancelAppointment(apptId2),
    ]);

    expect(results).toHaveLength(2);

    // Both should be cancelled independently
    const final1 = await db('appointments').where('id', apptId1).first();
    const final2 = await db('appointments').where('id', apptId2).first();

    expect(final1.status).toBe('cancelled');
    expect(final2.status).toBe('cancelled');
  });
});
