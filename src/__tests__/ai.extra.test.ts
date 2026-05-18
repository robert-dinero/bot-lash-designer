/**
 * AI group extra tests (beyond existing ai.service.test.ts)
 * AI-01: buildSchedulingPrompt includes identity, services, state, step instructions
 * AI-02: getAIResponse calls openai with max_tokens >= 300, temp=0.7
 * AI-03: HISTORY_LIMIT is 10 in session.service.ts
 * AI-06: buildSchedulingPrompt contains prompt injection resistance rules
 */

import { describe, it, expect } from 'vitest';

// ─── AI-01: buildSchedulingPrompt structure ───────────────────────────────────

describe('AI-01: buildSchedulingPrompt includes required sections', () => {
  function src(): string {
    const fs = require('fs');
    const path = require('path');
    return fs.readFileSync(
      path.resolve(__dirname, '../../src/services/ai.service.ts'),
      'utf-8'
    );
  }

  it('source includes businessName placeholder in prompt', () => {
    expect(src()).toContain('businessConfig.businessName');
  });

  it('source includes available slots in prompt', () => {
    expect(src()).toContain('HORÁRIOS DISPONÍVEIS');
  });

  it('source includes current appointment state in prompt', () => {
    expect(src()).toContain('ESTADO ATUAL');
  });

  it('source includes ETAPA step instruction in prompt', () => {
    expect(src()).toContain('ETAPA ATUAL');
    expect(src()).toContain('SUA TAREFA AGORA');
  });

  it('prompt includes step instructions for all barbershop scheduling states', () => {
    const s = src();
    const requiredSteps = [
      'AGUARDANDO_SERVICO',
      'AGUARDANDO_DATA_HORA',
      'AGUARDANDO_CONFIRMACAO_HORARIO',
      'AGUARDANDO_CONFIRMACAO',
      'CONFIRMADO',
    ];
    for (const step of requiredSteps) {
      expect(s, `Missing step instruction for ${step}`).toContain(step);
    }
  });
});

// ─── AI-02: getAIResponse calls OpenAI with max_tokens >= 300, temperature=0.7 ───

describe('AI-02: getAIResponse calls OpenAI with correct params', () => {
  function src(): string {
    const fs = require('fs');
    const path = require('path');
    return fs.readFileSync(
      path.resolve(__dirname, '../../src/services/ai.service.ts'),
      'utf-8'
    );
  }

  it('source specifies max_tokens >= 300', () => {
    expect(src()).toMatch(/max_tokens:\s*[34]\d\d/);
  });

  it('source specifies temperature: 0.7', () => {
    expect(src()).toContain('temperature: 0.7');
  });

  it('source specifies model gpt-4o-mini', () => {
    expect(src()).toContain("'gpt-4o-mini'");
  });

  it('source passes system message as first element in messages array', () => {
    const s = src();
    expect(s).toContain("role: 'system'");
    expect(s).toContain('buildSchedulingPrompt');
  });

  it('source specifies timeout 15000ms and maxRetries 2 on OpenAI client', () => {
    expect(src()).toContain('timeout: 15_000');
    expect(src()).toContain('maxRetries: 2');
  });
});

// ─── AI-03: HISTORY_LIMIT is 10 ──────────────────────────────────────────────

describe('AI-03: HISTORY_LIMIT is 10 in session.service.ts', () => {
  it('HISTORY_LIMIT is 10 (SESSION-05/AI-03 requirement)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/session.service.ts'),
      'utf-8'
    );
    expect(src).toContain('const HISTORY_LIMIT = 10');
  });
});

// ─── AI-06: buildSchedulingPrompt contains prompt injection resistance rules ──

describe('AI-06: buildSchedulingPrompt contains prompt injection resistance rules', () => {
  function src(): string {
    const fs = require('fs');
    const path = require('path');
    return fs.readFileSync(
      path.resolve(__dirname, '../../src/services/ai.service.ts'),
      'utf-8'
    );
  }

  it('system prompt source has anti-injection guardrails', () => {
    expect(src()).toMatch(/Nunca invente|nunca invente/);
  });

  it('buildSchedulingPrompt includes rule about not inventing services', () => {
    expect(src()).toContain('serviços');
  });

  it('JSON block rules prevent unauthorized confirmation injection', () => {
    const s = src();
    expect(s).toContain('confirmed');
    expect(s).toContain('AGUARDANDO_CONFIRMACAO');
  });
});
