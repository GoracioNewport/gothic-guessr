/**
 * PUBLIC_CONTACT (server/config.ts) and GET /api/config (server/routes/config.ts): the optional contact shown in the
 * legal notice. No default address.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, MAX_CONTACT_LENGTH, parseContact } from '../../server/config';
import { harness } from './helpers';
import type { Harness } from './helpers';

const secrets = { ADMIN_PASSWORD: 'admin-password-123', SERVER_SECRET: 'server-secret-0123456789' };

describe('PUBLIC_CONTACT', () => {
  it('is null when unset or blank', () => {
    expect(parseContact(undefined)).toBeNull();
    expect(parseContact('   ')).toBeNull();
    expect(loadConfig(secrets, '/tmp').publicContact).toBeNull();
  });

  it('is trimmed and kept as given', () => {
    expect(parseContact('  fans@example.org ')).toBe('fans@example.org');
    expect(loadConfig({ ...secrets, PUBLIC_CONTACT: 'https://example.org/contact' }, '/tmp').publicContact).toBe('https://example.org/contact');
  });

  it('refuses control characters and over-long values', () => {
    expect(() => parseContact('a\nb')).toThrow(/control/);
    expect(() => parseContact('x'.repeat(MAX_CONTACT_LENGTH + 1))).toThrow(/longer/);
  });
});

describe('GET /api/config', () => {
  let h: Harness | null = null;
  afterEach(() => h?.close());

  it('returns contact null without configuration, no auth needed', async () => {
    h = harness();
    const res = await h.app.request('/api/config');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ contact: null });
  });

  it('returns the configured contact', async () => {
    h = harness({ config: { publicContact: 'fans@example.org' } });
    expect(await (await h.app.request('/api/config')).json()).toEqual({ contact: 'fans@example.org' });
  });
});
