import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

/* ── Stateless token: base64(timestamp + "." + hmac) ─────────────
   Survives server restarts — no in-memory state needed.
   ─────────────────────────────────────────────────────────────── */

const TTL_MS = 24 * 60 * 60 * 1000;

function makeToken(): string {
  const ts = Date.now().toString();
  const mac = crypto.createHmac('sha256', env.ADMIN_SECRET).update(ts).digest('hex');
  return Buffer.from(`${ts}.${mac}`).toString('base64');
}

function checkToken(raw: string): boolean {
  try {
    const decoded = Buffer.from(raw, 'base64').toString();
    const dot = decoded.indexOf('.');
    if (dot === -1) return false;
    const ts = decoded.slice(0, dot);
    const mac = decoded.slice(dot + 1);
    const expected = crypto.createHmac('sha256', env.ADMIN_SECRET).update(ts).digest('hex');
    const macBuf = Buffer.from(mac, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (macBuf.length !== expBuf.length) return false;
    const valid = crypto.timingSafeEqual(macBuf, expBuf);
    const age = Date.now() - parseInt(ts, 10);
    return valid && age >= 0 && age < TTL_MS;
  } catch {
    return false;
  }
}

/* ── Handlers ────────────────────────────────────────────────── */

export function adminLogin(req: Request, res: Response): void {
  if (!env.ADMIN_SECRET) {
    res.status(503).json({ error: 'Dashboard disabled: set ADMIN_SECRET in .env' });
    return;
  }
  const { password } = req.body as { password?: string };
  if (!password || password !== env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  res.json({ token: makeToken() });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!env.ADMIN_SECRET) {
    res.status(503).json({ error: 'Dashboard disabled: set ADMIN_SECRET in .env' });
    return;
  }
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!checkToken(auth.slice(7))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
