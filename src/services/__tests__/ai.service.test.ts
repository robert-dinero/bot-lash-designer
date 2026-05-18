import { describe, it, expect } from 'vitest';
import {
  buildSchedulingPrompt,
  extractAppointmentUpdate,
  getAIResponse,
  detectRescheduleKeyword,
  type ServiceRecord,
} from '../ai.service';
import { deriveStep } from '../appointment.service';
import type { AppointmentState, Message } from '../../types';

describe('ai.service - appointment scheduling', () => {
  describe('buildSchedulingPrompt', () => {
    it('should include greeting instruction in AGUARDANDO_SERVICO step', () => {
      const state: AppointmentState = { confirmed: false };
      const slots: Date[] = [];
      const now = new Date();

      const prompt = buildSchedulingPrompt(state, slots, now, []);

      expect(prompt).toContain('AGUARDANDO_SERVICO');
    });

    it('should include available slots in readable format', () => {
      const state: AppointmentState = { service: 'Corte', confirmed: false };
      const slot1 = new Date('2026-05-18T10:00:00');
      const slot2 = new Date('2026-05-18T10:30:00');
      const slots = [slot1, slot2];
      const now = new Date();

      const prompt = buildSchedulingPrompt(state, slots, now, []);

      expect(prompt).toContain('10:00');
      expect(prompt).toContain('10:30');
      expect(prompt).toContain('horários disponíveis');
    });

    it('should inject current step in prompt', () => {
      const state: AppointmentState = {
        service: 'Corte',
        requestedDateTime: 'amanhã',
        confirmed: false,
      };
      const slots: Date[] = [];
      const now = new Date();

      const prompt = buildSchedulingPrompt(state, slots, now, []);
      const step = deriveStep(state);

      expect(prompt).toContain(step);
    });

    it('should show "nenhum horário disponível" when no slots', () => {
      const state: AppointmentState = { service: 'Corte', confirmed: false };
      const slots: Date[] = [];
      const now = new Date();

      const prompt = buildSchedulingPrompt(state, slots, now, []);

      expect(prompt).toContain('nenhum horário disponível');
    });

    it('should format services list as id=name pairs from services array', () => {
      const state: AppointmentState = { confirmed: false };
      const slots: Date[] = [];
      const now = new Date();
      const services: ServiceRecord[] = [
        { id: 1, name: 'Corte', duration_minutes: 30 },
        { id: 2, name: 'Barba', duration_minutes: 20 },
      ];

      const prompt = buildSchedulingPrompt(state, slots, now, services);

      expect(prompt).toContain('1=Corte');
      expect(prompt).toContain('2=Barba');
    });

    it('should show "nenhum serviço cadastrado" when services array is empty', () => {
      const state: AppointmentState = { confirmed: false };
      const slots: Date[] = [];
      const now = new Date();

      const prompt = buildSchedulingPrompt(state, slots, now, []);

      expect(prompt).toContain('nenhum serviço cadastrado');
    });
  });

  describe('extractAppointmentUpdate', () => {
    it('should extract valid JSON block with all fields', () => {
      const text = `Perfeito! Aqui está seu agendamento.
\`\`\`json
{
  "service": "Corte",
  "requestedDateTime": "amanhã às 10h",
  "confirmedDateTime": "2026-05-19T10:00:00Z",
  "confirmed": true
}
\`\`\`
Agradecemos!`;

      const { clean, patch } = extractAppointmentUpdate(text);

      expect(clean).toContain('Perfeito!');
      expect(patch).toBeDefined();
      expect(patch?.service).toBe('Corte');
      expect(patch?.confirmed).toBe(true);
    });

    it('should extract partial JSON (only changed fields)', () => {
      const text = `Você escolheu Corte.
\`\`\`json
{
  "service": "Corte"
}
\`\`\``;

      const { clean, patch } = extractAppointmentUpdate(text);

      expect(clean).toContain('Você escolheu');
      expect(patch?.service).toBe('Corte');
    });

    it('should return null patch if no JSON block', () => {
      const text = 'Qual serviço você quer? Temos Corte, Barba e Corte + Barba.';

      const { clean, patch } = extractAppointmentUpdate(text);

      expect(clean).toBe(text);
      expect(patch).toBeNull();
    });

    it('should handle malformed JSON gracefully', () => {
      const text = `Resposta do bot.
\`\`\`json
{ invalid json here }
\`\`\``;

      const { clean, patch } = extractAppointmentUpdate(text);

      expect(clean).toContain('Resposta do bot.');
      expect(patch).toBeNull();
    });

    it('should return null patch for invalid confirmedTime format', () => {
      const text = `Agendamento confirmado.
\`\`\`json
{
  "confirmedTime": "not-a-time"
}
\`\`\``;

      const { clean, patch } = extractAppointmentUpdate(text);

      // confirmedTime inválido é ignorado — patch fica vazio (sem campos úteis)
      expect(patch?.confirmedTime).toBeUndefined();
    });

    it('should handle special characters in service name', () => {
      const text = `Você escolheu Corte + Barba.
\`\`\`json
{
  "service": "Corte + Barba"
}
\`\`\``;

      const { clean, patch } = extractAppointmentUpdate(text);

      expect(patch?.service).toBe('Corte + Barba');
    });

    it('should strip JSON block from clean text', () => {
      const text = `Olá!
\`\`\`json
{"service":"Corte"}
\`\`\`
Até logo!`;

      const { clean } = extractAppointmentUpdate(text);

      expect(clean).not.toContain('```');
    });

    it('should extract serviceId as integer from JSON block', () => {
      const text = `Ótimo, serviço selecionado.
\`\`\`json
{"serviceId": 2}
\`\`\``;

      const { patch } = extractAppointmentUpdate(text);

      expect(patch?.serviceId).toBe(2);
    });

    it('should NOT include serviceId when value is not an integer', () => {
      const text = `Serviço registrado.
\`\`\`json
{"serviceId": "abc"}
\`\`\``;

      const { patch } = extractAppointmentUpdate(text);

      expect(patch?.serviceId).toBeUndefined();
    });
  });

  describe('detectRescheduleKeyword', () => {
    it('should return true for message containing "remarcar"', () => {
      expect(detectRescheduleKeyword('quero REMARCAR')).toBe(true);
    });

    it('should return false for message without reschedule keyword', () => {
      expect(detectRescheduleKeyword('oi')).toBe(false);
    });
  });

  describe('State machine integration', () => {
    it('should correctly guide through appointment flow', () => {
      let state: AppointmentState = { confirmed: false };

      expect(deriveStep(state)).toBe('AGUARDANDO_SERVICO');

      state = { ...state, service: 'Corte' };
      expect(deriveStep(state)).toBe('AGUARDANDO_DATA_HORA');

      state = { ...state, requestedDateTime: 'amanhã' };
      expect(deriveStep(state)).toBe('AGUARDANDO_CONFIRMACAO_HORARIO');

      state = { ...state, confirmedDateTime: '2026-05-19T10:00:00Z' };
      expect(deriveStep(state)).toBe('AGUARDANDO_CONFIRMACAO');

      state = { ...state, confirmed: true };
      expect(deriveStep(state)).toBe('CONFIRMADO');
    });
  });
});
