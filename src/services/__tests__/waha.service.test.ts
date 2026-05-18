import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizePhone, resolveLid, toChatId } from '../waha.service';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizePhone', () => {
  it('strips @c.us suffix', () => {
    expect(normalizePhone('5521999999999@c.us')).toBe('5521999999999');
  });

  it('strips @s.whatsapp.net suffix', () => {
    expect(normalizePhone('5521999999999@s.whatsapp.net')).toBe('5521999999999');
  });

  it('strips @lid suffix', () => {
    expect(normalizePhone('123456789@lid')).toBe('123456789');
  });

  it('returns plain number unchanged', () => {
    expect(normalizePhone('5521999999999')).toBe('5521999999999');
  });

  it('is case-insensitive for suffix', () => {
    expect(normalizePhone('5521999999999@C.US')).toBe('5521999999999');
  });
});

describe('toChatId', () => {
  it('appends @c.us to plain number', () => {
    expect(toChatId('5521999999999')).toBe('5521999999999@c.us');
  });

  it('normalizes existing @c.us before re-appending', () => {
    expect(toChatId('5521999999999@c.us')).toBe('5521999999999@c.us');
  });

  it('converts @s.whatsapp.net to @c.us', () => {
    expect(toChatId('5521999999999@s.whatsapp.net')).toBe('5521999999999@c.us');
  });
});

describe('resolveLid', () => {
  it('falls back to /api/default/lids when contact lookup does not resolve phone', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '79422635901143@lid' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { lid: '79422635901143@lid', pn: '5521981611800@c.us' },
      ]), { status: 200 }));

    await expect(resolveLid('79422635901143@lid')).resolves.toBe('5521981611800');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
