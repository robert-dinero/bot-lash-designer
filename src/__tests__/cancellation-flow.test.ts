import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleWebhook } from '../controllers/webhook.controller';
import { getDb } from '../db';
import * as waha from '../services/waha.service';
import type { Request, Response } from 'express';

// Mock waha.service
vi.mock('../services/waha.service', () => ({
  normalizePhone: vi.fn((phone: string) => phone.replace(/@.*/, '')),
  sendText: vi.fn().mockResolvedValue(undefined),
  notifyOwner: vi.fn().mockResolvedValue(undefined),
  resolveLid: vi.fn().mockResolvedValue(null),
  toChatId: vi.fn((phone: string) => `${phone}@c.us`),
}));

// Mock dedup so every message is processed (not deduplicated)
vi.mock('../lib/dedup', () => ({
  isDuplicateAndMark: vi.fn().mockResolvedValue(false),
}));

// Helper: flush microtask queue + one macrotask so fire-and-forget async completes
async function flushAsync() {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

function makeReq(phone: string, body: string, msgId: string): Request {
  return {
    body: {
      payload: {
        from: `${phone}@c.us`,
        body,
        id: msgId,
        type: 'chat',
        fromMe: false,
      },
    },
  } as unknown as Request;
}

function makeRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
}

describe('Cancellation Flow Integration', () => {
  let db: any;

  beforeEach(async () => {
    db = getDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should cancel appointment with > 6h notice', async () => {
    // Appointment 8 hours from now
    const starts_at = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

    const [appointmentId] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511000000001',
      client_name: null,
      service_id: 1,
      starts_at,
      duration_minutes: 30,
      status: 'confirmed',
    });

    const sendTextSpy = vi.spyOn(waha, 'sendText').mockResolvedValue(undefined);

    await handleWebhook(makeReq('5511000000001', 'Cancelar', 'cf-msg-1'), makeRes());
    await flushAsync();

    const updated = await db('appointments').where('id', appointmentId).first();
    expect(updated.status).toBe('cancelled');
    expect(updated.cancelled_at).not.toBeNull();

    expect(sendTextSpy).toHaveBeenCalledWith(
      '5511000000001',
      expect.stringContaining('✅')
    );
  });

  it('should escalate cancellation with < 6h notice', async () => {
    // Appointment 3 hours from now
    const starts_at = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

    const [appointmentId] = await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511000000002',
      client_name: null,
      service_id: 1,
      starts_at,
      duration_minutes: 30,
      status: 'confirmed',
    });

    const sendTextSpy = vi.spyOn(waha, 'sendText').mockResolvedValue(undefined);
    const notifyOwnerSpy = vi.spyOn(waha, 'notifyOwner').mockResolvedValue(undefined);

    await handleWebhook(makeReq('5511000000002', 'Cancelar', 'cf-msg-2'), makeRes());
    await flushAsync();

    const updated = await db('appointments').where('id', appointmentId).first();
    expect(updated.escalation_status).toBe('pending');
    expect(updated.status).toBe('confirmed');

    expect(sendTextSpy).toHaveBeenCalledWith(
      '5511000000002',
      expect.stringContaining('prazo')
    );

    expect(notifyOwnerSpy).toHaveBeenCalledWith(
      expect.stringContaining('Pedido de cancelamento')
    );
  });

  it('should handle cancellation when no appointment exists', async () => {
    const sendTextSpy = vi.spyOn(waha, 'sendText').mockResolvedValue(undefined);

    await handleWebhook(makeReq('5511000000003', 'Cancelar', 'cf-msg-3'), makeRes());
    await flushAsync();

    expect(sendTextSpy).toHaveBeenCalledWith(
      '5511000000003',
      expect.stringContaining('nenhum agendamento')
    );
  });

  it('should detect "Cancelar" case-insensitively', async () => {
    const starts_at = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

    for (const [i, body] of ['cancelar', 'Cancelar', 'CANCELAR', 'quero cancelar'].entries()) {
      vi.clearAllMocks();
      const phone = `551100000010${i}`;

      await db('appointments').insert({
        chair_id: 1,
        client_phone: phone,
        client_name: null,
        service_id: 1,
        starts_at,
        duration_minutes: 30,
        status: 'confirmed',
      });

      const sendTextSpy = vi.spyOn(waha, 'sendText').mockResolvedValue(undefined);

      await handleWebhook(makeReq(phone, body, `cf-case-${i}`), makeRes());
      await flushAsync();

      expect(sendTextSpy).toHaveBeenCalled();
    }
  });

  it('should be idempotent when client sends "CANCELAR" twice', async () => {
    const starts_at = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const phone = '5511000000020';

    const [appointmentId] = await db('appointments').insert({
      chair_id: 1,
      client_phone: phone,
      client_name: null,
      service_id: 1,
      starts_at,
      duration_minutes: 30,
      status: 'confirmed',
    });

    const sendTextSpy = vi.spyOn(waha, 'sendText').mockResolvedValue(undefined);

    // Primeira vez
    await handleWebhook(makeReq(phone, 'Cancelar', 'cf-idem-1'), makeRes());
    await flushAsync();

    const updated = await db('appointments').where('id', appointmentId).first();
    expect(updated.status).toBe('cancelled');

    // Segunda vez
    vi.clearAllMocks();
    const sendTextSpy2 = vi.spyOn(waha, 'sendText').mockResolvedValue(undefined);

    await handleWebhook(makeReq(phone, 'Cancelar', 'cf-idem-2'), makeRes());
    await flushAsync();

    expect(sendTextSpy2).toHaveBeenCalledWith(
      phone,
      expect.stringContaining('nenhum agendamento')
    );
  });

  it('should reset session after successful cancellation', async () => {
    const starts_at = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const phone = '5511000000030';

    await db('appointments').insert({
      chair_id: 1,
      client_phone: phone,
      client_name: null,
      service_id: 1,
      starts_at,
      duration_minutes: 30,
      status: 'confirmed',
    });

    // Garantir que a sessão existe
    await db('users').insert({ phone, created_at: new Date().toISOString() }).onConflict('phone').ignore();
    await db('sessions')
      .insert({
        phone,
        cart_json: JSON.stringify({ service: 'Corte', confirmed: true }),
        misunderstanding_count: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .onConflict('phone')
      .merge();

    vi.spyOn(waha, 'sendText').mockResolvedValue(undefined);

    await handleWebhook(makeReq(phone, 'Cancelar', 'cf-reset-1'), makeRes());
    await flushAsync();

    const session = await db('sessions').where('phone', phone).first();
    const state = JSON.parse(session.cart_json);
    expect(state.confirmed).toBe(false);
    expect(state.service).toBeUndefined();
    expect(state.confirmedDateTime).toBeUndefined();
  });
});
