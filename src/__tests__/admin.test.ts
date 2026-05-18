/**
 * ADMIN group tests (smoke)
 * ADMIN-01: admin controller exports all required handler functions
 * ADMIN-02: admin route file exports adminRouter with all 13 endpoints
 * ADMIN-03: public/admin/index.html exists on disk
 * ADMIN-05: app.ts wires admin routes
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');

// ─── ADMIN-01: Controller source inspection ───────────────────────────────────
describe('ADMIN-01: admin controller exports required functions', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/controllers/admin.controller.ts'),
    'utf-8'
  );
  // requireAdmin lives in auth.ts (middleware), not the controller
  const authSrc = fs.readFileSync(
    path.join(ROOT, 'src/middleware/auth.ts'),
    'utf-8'
  );

  it('exports requireAdmin middleware', () => {
    expect(authSrc).toContain('export function requireAdmin');
  });

  it('exports getAppointments handler', () => {
    expect(src).toContain('export async function getAppointments');
  });

  it('exports deleteAppointment handler', () => {
    expect(src).toContain('export async function deleteAppointment');
  });

  it('exports getServices handler', () => {
    expect(src).toContain('export async function getServices');
  });

  it('exports clearCustomerData handler', () => {
    expect(src).toContain('export async function clearCustomerData');
  });

  it('exports createService handler', () => {
    expect(src).toContain('export async function createService');
  });

  it('exports updateService handler', () => {
    expect(src).toContain('export async function updateService');
  });

  it('exports deleteService handler', () => {
    expect(src).toContain('export async function deleteService');
  });

  it('exports getWorkingHours handler', () => {
    expect(src).toContain('export async function getWorkingHours');
  });

  it('exports updateWorkingHours handler', () => {
    expect(src).toContain('export async function updateWorkingHours');
  });

  it('exports getAvailabilityBlocks handler', () => {
    expect(src).toContain('export async function getAvailabilityBlocks');
  });

  it('exports createAvailabilityBlock handler', () => {
    expect(src).toContain('export async function createAvailabilityBlock');
  });

  it('exports deleteAvailabilityBlock handler', () => {
    expect(src).toContain('export async function deleteAvailabilityBlock');
  });

  it('exports getEscalations handler', () => {
    expect(src).toContain('export async function getEscalations');
  });

  it('exports updateEscalation handler', () => {
    expect(src).toContain('export async function updateEscalation');
  });

  it('returns 401 when secret does not match', () => {
    expect(authSrc).toContain('res.status(401)');
  });
});

// ─── ADMIN-02: Route file inspection ─────────────────────────────────────────
describe('ADMIN-02: admin route file registers correct endpoints', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/routes/admin.ts'),
    'utf-8'
  );

  it('exports adminRouter', () => {
    expect(src).toContain('adminRouter');
  });

  it('registers GET /appointments', () => {
    expect(src).toContain("'/appointments'");
  });

  it('registers GET /services', () => {
    expect(src).toContain("'/services'");
  });

  it('registers DELETE /customer-data', () => {
    expect(src).toContain("'/customer-data'");
  });

  it('registers GET /working-hours', () => {
    expect(src).toContain("'/working-hours'");
  });

  it('registers GET /blocks (availability blocks)', () => {
    expect(src).toContain("'/blocks'");
  });

  it('registers GET /escalations', () => {
    expect(src).toContain("'/escalations'");
  });

  it('applies requireAdmin middleware', () => {
    expect(src).toContain('requireAdmin');
  });
});

// ─── ADMIN-03: Static files exist on disk ────────────────────────────────────
describe('ADMIN-03: public/admin static files exist', () => {
  it('public/admin/index.html exists', () => {
    expect(fs.existsSync(path.join(ROOT, 'public/admin/index.html'))).toBe(true);
  });

  it('public/admin/style.css exists', () => {
    expect(fs.existsSync(path.join(ROOT, 'public/admin/style.css'))).toBe(true);
  });

  it('public/admin/app.js exists', () => {
    expect(fs.existsSync(path.join(ROOT, 'public/admin/app.js'))).toBe(true);
  });

  it('index.html references style.css and app.js', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/admin/index.html'), 'utf-8');
    expect(html).toContain('style.css');
    expect(html).toContain('app.js');
  });
});

// ─── ADMIN-05: app.ts wires admin routes ─────────────────────────────────────
describe('ADMIN-05: app.ts registers admin router', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/app.ts'),
    'utf-8'
  );

  it('imports adminRouter', () => {
    expect(src).toContain('adminRouter');
  });

  it('mounts admin router at /admin', () => {
    expect(src).toContain("'/admin'");
  });

  it('serves public/ as static files', () => {
    expect(src).toContain('express.static');
    expect(src).toContain("'public/admin'");
  });
});
