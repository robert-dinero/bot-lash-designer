import { Router, type Request, type Response, type NextFunction } from 'express';
import { handleWebhook } from '../controllers/webhook.controller';
import { env } from '../config/env';
import { log } from '../utils/logger';

const router = Router();

// API key middleware
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'];
  if (key !== env.WEBHOOK_API_KEY) {
    log.warn('-', 'ENTRY', 'Rejected webhook request — invalid API key');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// WAHA does not support custom webhook headers — restrict to loopback/Docker internal IPs only
function requireLocalOrigin(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  const allowed = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.', '192.168.', '::ffff:10.', '::ffff:172.'];
  if (!allowed.some(prefix => ip.startsWith(prefix))) {
    log.warn('-', 'ENTRY', `Rejected webhook from external IP: ${ip}`);
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

router.post('/waha', requireLocalOrigin, handleWebhook);

export { router as webhookRouter };
