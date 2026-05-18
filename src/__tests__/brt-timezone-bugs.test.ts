/**
 * Testes para os bugs encontrados em produção no dia 14-15/05/2026:
 *
 * BUG 1 — Slots exibidos em UTC para a IA (ex: "• 09:00" UTC = "• 06:00" BRT)
 *          Causa: getAvailableSlots usava setHours() sem considerar fuso
 *          Fix: open/close times construídos como UTC-3 explicitamente
 *
 * BUG 2 — confirmedDateTime com hora errada (cliente pediu 17h, salvou 15h)
 *          Causa: IA recebia slots em UTC, confirmava horário UTC no JSON
 *          Fix: slots formatados com toLocaleTimeString America/Sao_Paulo
 *
 * BUG 3 — Slots cortados antes de 19h BRT (fechava às ~16h BRT no cliente)
 *          Causa: closeTime = setHours(19) UTC = 16h BRT no horário de verão
 *          Fix: closeTime = dayUtcMidnight + 19h*3600000 + BRT_OFFSET
 *
 * BUG 4 — Bot dizia "só atendo de segunda a sábado" quando terça foi pedida
 *          Causa: prompt hardcodado "Segunda a sábado" sem checar working_hours real
 *          Fix: linha removida do prompt — IA confia nos slots passados pelo sistema
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getAvailableSlots, validateAppointmentTime } from '../services/appointment.service';
import { buildSchedulingPrompt } from '../services/ai.service';
import type { AppointmentState } from '../types';
import { getDb } from '../db';

// Helpers para construir timestamps BRT corretos (UTC-3)
// Recebe ano, mês (1-based), dia, hora e minuto BRT → retorna Date em UTC
function brtDate(y: number, mo: number, d: number, h: number, m: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h + 3, m));
}

describe('BUG 1+3 — getAvailableSlots: horários gerados em BRT, não UTC', () => {
  let db: ReturnType<typeof getDb>;

  beforeEach(async () => {
    db = getDb();
    await db('appointments').del();
    await db('availability_blocks').del();
  });

  it('primeiro slot deve ser 09:00 BRT (= 12:00 UTC)', async () => {
    // Terça 19/05/2026 — dia_of_week=2, aberto
    const terca = new Date(Date.UTC(2026, 4, 19, 12, 0)); // meio-dia UTC = terça em BRT
    const slots = await getAvailableSlots(1, terca, 30);

    expect(slots.length).toBeGreaterThan(0);
    const first = slots[0];
    // 09:00 BRT = 12:00 UTC
    expect(first.getUTCHours()).toBe(12);
    expect(first.getUTCMinutes()).toBe(0);
  });

  it('último slot deve caber dentro de 19:00 BRT (= 22:00 UTC) — sem corte prematuro', async () => {
    const terca = new Date(Date.UTC(2026, 4, 19, 12, 0));
    const slots = await getAvailableSlots(1, terca, 30);

    // Último slot deve ser 18:30 BRT = 21:30 UTC (30 min antes do fechamento)
    const last = slots[slots.length - 1];
    expect(last.getUTCHours()).toBe(21);
    expect(last.getUTCMinutes()).toBe(30);
  });

  it('deve ter 20 slots para dia inteiro sem conflitos (09:00-19:00 = 20x30min)', async () => {
    const terca = new Date(Date.UTC(2026, 4, 19, 12, 0));
    const slots = await getAvailableSlots(1, terca, 30);

    expect(slots.length).toBe(20);
  });

  it('slot de 17:00 BRT deve estar disponível (não deve ser cortado)', async () => {
    const terca = new Date(Date.UTC(2026, 4, 19, 12, 0));
    const slots = await getAvailableSlots(1, terca, 30);

    // 17:00 BRT = 20:00 UTC
    const slot17h = slots.find(s => s.getUTCHours() === 20 && s.getUTCMinutes() === 0);
    expect(slot17h).toBeDefined();
  });

  it('slot de 18:30 BRT deve estar disponível (último antes de 19h)', async () => {
    const terca = new Date(Date.UTC(2026, 4, 19, 12, 0));
    const slots = await getAvailableSlots(1, terca, 30);

    // 18:30 BRT = 21:30 UTC
    const slot1830 = slots.find(s => s.getUTCHours() === 21 && s.getUTCMinutes() === 30);
    expect(slot1830).toBeDefined();
  });

  it('domingo deve retornar zero slots (fechado)', async () => {
    const domingo = new Date(Date.UTC(2026, 4, 17, 12, 0)); // domingo
    const slots = await getAvailableSlots(1, domingo, 30);
    expect(slots).toEqual([]);
  });
});

describe('BUG 1+3 — validateAppointmentTime: valida em BRT, não UTC', () => {
  beforeEach(async () => {
    const db = getDb();
    await db('appointments').del();
  });

  it('17:00 BRT deve ser válido (dentro do horário de funcionamento)', async () => {
    const slot17hBRT = brtDate(2026, 5, 19, 17, 0); // terça 17:00 BRT
    const valid = await validateAppointmentTime(1, slot17hBRT, 30);
    expect(valid).toBe(true);
  });

  it('18:30 BRT deve ser válido (último slot antes de 19:00)', async () => {
    const slot1830BRT = brtDate(2026, 5, 19, 18, 30);
    const valid = await validateAppointmentTime(1, slot1830BRT, 30);
    expect(valid).toBe(true);
  });

  it('19:00 BRT deve ser inválido (no fechamento — sem tempo para 30 min)', async () => {
    const slot19hBRT = brtDate(2026, 5, 19, 19, 0);
    const valid = await validateAppointmentTime(1, slot19hBRT, 30);
    expect(valid).toBe(false);
  });

  it('08:59 BRT deve ser inválido (antes da abertura às 09:00)', async () => {
    const slot8h59BRT = brtDate(2026, 5, 19, 8, 59);
    const valid = await validateAppointmentTime(1, slot8h59BRT, 30);
    expect(valid).toBe(false);
  });

  it('09:00 BRT deve ser válido (abertura exata)', async () => {
    const slot9hBRT = brtDate(2026, 5, 19, 9, 0);
    const valid = await validateAppointmentTime(1, slot9hBRT, 30);
    expect(valid).toBe(true);
  });
});

describe('BUG 2 — buildSchedulingPrompt: slots formatados em BRT para a IA', () => {
  it('slots no prompt devem aparecer em hora BRT, não UTC', () => {
    // Slot 17:00 BRT = 20:00 UTC
    const slot17hBRT = brtDate(2026, 5, 19, 17, 0);
    const state: AppointmentState = { service: 'Corte', confirmed: false };

    const prompt = buildSchedulingPrompt(state, [slot17hBRT], new Date());

    expect(prompt).toContain('17:00');
    expect(prompt).not.toContain('20:00'); // não deve aparecer hora UTC
  });

  it('slot de 09:00 BRT não deve aparecer como 06:00 UTC no prompt', () => {
    const slot9hBRT = brtDate(2026, 5, 19, 9, 0);
    const state: AppointmentState = { service: 'Corte', confirmed: false };

    const prompt = buildSchedulingPrompt(state, [slot9hBRT], new Date());

    expect(prompt).toContain('09:00');
    expect(prompt).not.toContain('06:00');
  });

  it('múltiplos slots devem aparecer em BRT, um por linha', () => {
    const slots = [
      brtDate(2026, 5, 19, 9, 0),   // 09:00 BRT
      brtDate(2026, 5, 19, 9, 30),  // 09:30 BRT
      brtDate(2026, 5, 19, 17, 0),  // 17:00 BRT
    ];
    const state: AppointmentState = { service: 'Corte', confirmed: false };

    const prompt = buildSchedulingPrompt(state, slots, new Date());

    expect(prompt).toContain('• 09:00');
    expect(prompt).toContain('• 09:30');
    expect(prompt).toContain('• 17:00');
  });
});

describe('BUG 5 - buildSchedulingPrompt: amanha respeita BRT no fim do dia', () => {
  it('AMANHA no prompt deve ser segunda 18/05 quando ainda e domingo em BRT', () => {
    const lateSundayBrt = new Date('2026-05-18T02:01:00.000Z'); // 17/05 23:01 BRT
    const state: AppointmentState = { service: 'Corte', confirmed: false };

    const prompt = buildSchedulingPrompt(state, [], lateSundayBrt);

    expect(prompt).toContain('DATA/HORA ATUAL: domingo, 17/05/2026');
    expect(prompt).toContain('AMANHÃ: segunda-feira, 18/05');
    expect(prompt).not.toContain('AMANHÃ: terça-feira, 19/05');
  });
});

describe('BUG 4 — prompt não deve conter dias de funcionamento hardcodados', () => {
  it('prompt não deve mencionar "Segunda a sábado" hardcodado', () => {
    const state: AppointmentState = { confirmed: false };
    const prompt = buildSchedulingPrompt(state, [], new Date());

    expect(prompt).not.toContain('Segunda a sábado');
    expect(prompt).not.toContain('segunda a sábado');
  });

  it('prompt não deve mencionar horário fixo de funcionamento', () => {
    const state: AppointmentState = { confirmed: false };
    const prompt = buildSchedulingPrompt(state, [], new Date());

    expect(prompt).not.toMatch(/HORÁRIOS DE FUNCIONAMENTO.*segunda/i);
  });
});
