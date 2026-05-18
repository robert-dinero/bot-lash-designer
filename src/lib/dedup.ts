import { getDb } from '../db';
import { log, maskPhone } from '../utils/logger';

// In-memory cache for the last 60 seconds of processed IDs and content fingerprints
const recentIds = new Set<string>();
const recentFingerprints = new Set<string>();

// Atomic check-and-mark: returns true if this messageId was already processed.
// Uses INSERT OR IGNORE so concurrent deliveries of the same ID are safe —
// only one insert wins, the other gets rowsAffected=0 and is treated as duplicate.
export async function isDuplicateAndMark(messageId: string, phone?: string, body?: string): Promise<boolean> {
  // Fast path: in-memory check by ID (covers WAHA's same-process double-delivery)
  if (recentIds.has(messageId)) {
    log.info('-', 'DEDUP', `Duplicate (memory): ${messageId}`);
    return true;
  }

  // Secondary check: same phone+body within 5 seconds (WAHA re-delivers with different IDs)
  if (phone && body) {
    const fingerprint = `${phone}:${body.slice(0, 100)}`;
    if (recentFingerprints.has(fingerprint)) {
      log.info(maskPhone(phone), 'DEDUP', `Duplicate (fingerprint): "${body.slice(0, 40)}"`);
      return true;
    }
    recentFingerprints.add(fingerprint);
    setTimeout(() => recentFingerprints.delete(fingerprint), 5_000);
  }

  recentIds.add(messageId);
  setTimeout(() => recentIds.delete(messageId), 60_000);

  try {
    const db = getDb();
    const result = await db.raw(
      'INSERT OR IGNORE INTO processed_messages (message_id, processed_at) VALUES (?, ?)',
      [messageId, new Date().toISOString()]
    );
    // knex raw on sqlite3: result[0] is the RunResult with `changes`
    const changes = result[0]?.changes ?? result?.changes ?? 1;
    if (changes === 0) {
      log.info('-', 'DEDUP', `Duplicate (db): ${messageId}`);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Keep old exports for backward compatibility — delegating to atomic version
export async function isDuplicate(messageId: string): Promise<boolean> {
  return isDuplicateAndMark(messageId);
}

export async function markProcessed(_messageId: string): Promise<void> {
  // No-op: isDuplicate now marks atomically
}
