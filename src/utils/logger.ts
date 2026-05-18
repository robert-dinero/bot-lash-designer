// src/utils/logger.ts
// Level-gated structured logger. Format: [DD/MM HH:mm:ss] [LEVEL] [****XXXX] [STEP] mensagem
// Reads LOG_LEVEL from process.env directly (not from env.ts) to avoid circular import at startup.
// PM2 captures stdout/stderr automatically — no file transport needed (D-01).

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const rawLevel = process.env.LOG_LEVEL ?? 'info';
const currentLevel: LogLevel = (rawLevel as LogLevel) in LEVEL_ORDER
  ? (rawLevel as LogLevel)
  : 'info';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function timestamp(): string {
  return new Date()
    .toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false })
    .replace(',', '');
}

function line(level: string, masked: string, step: string, msg: string): string {
  return `[${timestamp()}] [${level}] [${masked}] [${step}] ${msg}`;
}

/**
 * Mask a phone number for logging. Shows only the last 4 digits.
 * D-05: maskPhone('5511999991234') → '****1234'
 * Use '-' as masked placeholder for system-level events with no phone context.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 4) return `****${digits.slice(-4)}`;
  return '****';
}

export const log = {
  info(masked: string, step: string, msg: string): void {
    if (shouldLog('info')) console.log(line('INFO', masked, step, msg));
  },

  warn(masked: string, step: string, msg: string): void {
    if (shouldLog('warn')) console.warn(line('WARN', masked, step, msg));
  },

  error(masked: string, step: string, msg: string, err?: unknown): void {
    if (shouldLog('error')) {
      console.error(line('ERROR', masked, step, msg));
      if (err) console.error(err);
    }
  },

  /**
   * Debug-level log. Only emits output when LOG_LEVEL=debug.
   * Used for raw AI output before parsing (D-04, D-07).
   * Note: LOG_LEVEL=debug is off by default in production — raw output may contain PII.
   */
  debug(masked: string, step: string, msg: string): void {
    if (shouldLog('debug')) console.log(line('DEBUG', masked, step, msg));
  },
};
