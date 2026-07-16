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

  it('sends valid contact payloads to the owner and the requester through Resend', async () => {
    const resendFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'email-id' }), { status: 200 }),
    );
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
    expect(resendFetch).toHaveBeenCalledTimes(2);
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
    const requestBodies = resendFetch.mock.calls.map((call) => {
      const init = call[1];

      if (!init?.body) {
        throw new Error('Expected Resend request body');
      }

      return JSON.parse(String(init.body));
    });

    expect(requestBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: ['juanma@ludusales.com'],
          reply_to: 'codex-test@example.com',
          subject: 'Nueva solicitud de llamada - Ludus Sales Test',
        }),
        expect.objectContaining({
          to: ['codex-test@example.com'],
          reply_to: 'juanma@ludusales.com',
          subject: 'Hemos recibido tu solicitud en Ludus Sales',
        }),
      ]),
    );
  });
});
