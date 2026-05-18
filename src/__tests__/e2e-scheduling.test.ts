/**
 * E2E Scheduling Flow — testes complementares ao flow-simulation.test.ts
 * Usa o DB injetado pelo setup.ts global.
 * O fluxo completo está coberto em flow-simulation.test.ts com mock de IA determinístico.
 * Aqui testamos: persistência de sessão, criação de appointment via appointment.controller,
 * e bloqueio de slot já ocupado.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { getDb } from '../db';

// Mock WAHA service
vi.mock('../services/waha.service', () => ({
  normalizePhone: (from: string) => from.replace(/@.*$/, ''),
  sendText: vi.fn().mockResolvedValue(undefined),
  resolveLid: vi.fn(() => Promise.resolve(null)),
  toChatId: (phone: string) => `${phone}@c.us`,
  notifyOwner: vi.fn().mockResolvedValue(undefined),
}));

// Mock dedup — sempre processa
vi.mock('../lib/dedup', () => ({
  isDuplicateAndMark: vi.fn(() => Promise.resolve(false)),
}));

describe('E2E Scheduling Flow', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should complete full scheduling flow: message → slots → choice → appointment → confirmation', async () => {
    // Este fluxo E2E é coberto detalhadamente em flow-simulation.test.ts (FLUXO-01).
    // Aqui verificamos que o appointment.controller retorna agendamentos criados via DB.
    const db = getDb();
    const { getAppointments } = await import('../controllers/appointment.controller');

    const phone = '5511300000001';
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const slotTime = new Date(tomorrow);
    slotTime.setHours(10, 0, 0, 0);

    // Insere agendamento diretamente (simula resultado do fluxo de agendamento)
    await db('appointments').insert({
      chair_id: 1,
      client_phone: phone,
      client_name: 'João',
      service_id: 1,
      starts_at: slotTime.toISOString(),
      duration_minutes: 30,
      status: 'confirmed',
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const jsonFn = vi.fn();
    const req = { params: { phone } } as unknown as Request;
    const res = { json: jsonFn, status: vi.fn().mockReturnThis() } as unknown as Response;

    await getAppointments(req, res);

    expect(jsonFn).toHaveBeenCalled();
    const result = jsonFn.mock.calls[0][0];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].client_phone).toBe(phone);
    expect(result[0].service_name).toBe('Volume Brasileiro');
    expect(result[0].status).toBe('confirmed');
  });

  it('should save appointment state to session cart_json throughout flow', async () => {
    // Verifica que saveAppointmentState persiste corretamente o estado na sessão
    const db = getDb();
    const { saveAppointmentState, getOrCreateSession } = await import('../services/session.service');

    const phone = '5511300000002';

    // Cria usuário e sessão
    await getOrCreateSession(phone);

    // Persiste estado parcial (serviço selecionado)
    await saveAppointmentState(phone, { service: 'Corte', confirmed: false });

    let session = await db('sessions').where({ phone }).first();
    expect(session).toBeDefined();
    let state = JSON.parse(session.cart_json);
    expect(state.service).toBe('Corte');
    expect(state.confirmed).toBeFalsy();

    // Persiste estado com horário confirmado
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(14, 0, 0, 0);

    await saveAppointmentState(phone, {
      service: 'Corte',
      confirmedDateTime: tomorrow.toISOString(),
      confirmed: true,
    });

    session = await db('sessions').where({ phone }).first();
    state = JSON.parse(session.cart_json);
    expect(state.service).toBe('Corte');
    expect(state.confirmedDateTime).toBeTruthy();
    expect(state.confirmed).toBe(true);
  });

  it('should validate appointment before creating it', async () => {
    // Verifica que validateAppointmentTime rejeita slot já ocupado
    const db = getDb();
    const { validateAppointmentTime, createAppointment } = await import('../services/appointment.service');

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const slotTime = new Date(tomorrow);
    slotTime.setHours(14, 0, 0, 0);

    // Pré-reserva o slot
    await db('appointments').insert({
      chair_id: 1,
      client_phone: '5511300000099',
      client_name: null,
      service_id: 1,
      starts_at: slotTime.toISOString(),
      duration_minutes: 30,
      status: 'confirmed',
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Valida que o slot está indisponível
    const available = await validateAppointmentTime(1, slotTime, 30);
    expect(available).toBe(false);

    // Tenta criar agendamento no slot ocupado — deve lançar erro
    await expect(
      createAppointment(1, '5511300000003', 1, slotTime, 30)
    ).rejects.toThrow('Time slot not available');
  });
});
