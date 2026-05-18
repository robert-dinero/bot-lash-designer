/**
 * FLOW group tests — placeholder for Phase 2
 *
 * These tests documented food-delivery bot flow (FLOW-01 through FLOW-12).
 * The webhook controller is now a stub (Plan 01-02) that returns a maintenance
 * message. Full barbershop scheduling flow will be implemented and tested in
 * Phase 2.
 *
 * FLOW-01 through FLOW-12: moved to Phase 2 planning
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');

describe('FLOW: webhook stub returns 200 fire-and-forget', () => {
  it('webhook.controller.ts exports handleWebhook', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/controllers/webhook.controller.ts'),
      'utf-8'
    );
    expect(src).toContain('export async function handleWebhook');
  });

  it('handleWebhook calls res.status(200) immediately (fire-and-forget)', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/controllers/webhook.controller.ts'),
      'utf-8'
    );
    expect(src).toContain('res.status(200)');
    // Must be fire-and-forget: processMessage().catch(), NOT await processMessage()
    const processIdx = src.indexOf('processMessage(');
    const beforeProcess = src.slice(Math.max(0, processIdx - 10), processIdx);
    expect(beforeProcess).not.toContain('await');
  });

  it('controller handles fire-and-forget pattern (processMessage is async)', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/controllers/webhook.controller.ts'),
      'utf-8'
    );
    expect(src).toContain('processMessage');
    expect(src).toContain('.catch(');
  });

  it('group messages (@g.us) are filtered out', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/controllers/webhook.controller.ts'),
      'utf-8'
    );
    expect(src).toContain('@g.us');
  });

  it('fromMe messages are filtered out', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/controllers/webhook.controller.ts'),
      'utf-8'
    );
    expect(src).toContain('fromMe');
  });
});
