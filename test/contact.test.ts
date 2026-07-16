import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';

describe('contact endpoint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects invalid payloads', async () => {
    const response = await SELF.fetch('https://worker.test/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid contact payload.' });
  });

  it('sends valid contact payloads through Resend', async () => {
    const resendFetch = vi.fn(async () => new Response(JSON.stringify({ id: 'email-id' }), { status: 200 }));
    vi.stubGlobal('fetch', resendFetch);

    const response = await app.request(
      '/contact',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:4200',
        },
        body: JSON.stringify({
          firstName: 'Codex',
          lastName: 'Test',
          email: 'codex-test@example.com',
          company: 'Ludus Sales Test',
          teamSize: '1',
        }),
      },
      {
        RESEND_API_KEY: 'test-key',
        CONTACT_TO_EMAIL: 'juanma@ludusales.com',
        RESEND_FROM_EMAIL: 'Ludus Sales <contact@ludusales.com>',
        FRONTEND_ORIGINS: 'http://localhost:4200',
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(resendFetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });
});
