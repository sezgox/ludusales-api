import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';

const authEnv = {
  JWT_SECRET: 'test-jwt-secret',
  PLACEHOLDER_COMPANY_ID: '101',
  PLACEHOLDER_COMPANY_PUBLIC_ID: '82b4c7b9-68d1-4cc6-9e36-41d4db4e05f0',
  PLACEHOLDER_COMPANY_NAME: 'Ludus Sales Demo',
  PLACEHOLDER_COMPANY_ACCESS_CODE: 'DEMO-ACCESS-2026',
  RESEND_API_KEY: 'test-key',
  CONTACT_TO_EMAIL: 'juan.mateo@ludusales.com',
  RESEND_FROM_EMAIL: 'Ludus Sales <contact@ludusales.com>',
  FRONTEND_ORIGINS: 'http://localhost:4200',
};

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
        ...authEnv,
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
          to: ['juan.mateo@ludusales.com'],
          reply_to: 'codex-test@example.com',
          subject: 'Nueva solicitud de llamada - Ludus Sales Test',
        }),
        expect.objectContaining({
          to: ['codex-test@example.com'],
          reply_to: 'juan.mateo@ludusales.com',
          subject: 'Hemos recibido tu solicitud en Ludus Sales',
        }),
      ]),
    );
  });
});

describe('auth endpoints', () => {
  it('creates an HttpOnly session cookie for a valid access code', async () => {
    const response = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode: 'DEMO-ACCESS-2026' }),
      },
      authEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      company: {
        public_id: '82b4c7b9-68d1-4cc6-9e36-41d4db4e05f0',
        name: 'Ludus Sales Demo',
      },
    });
    expect(response.headers.get('Set-Cookie')).toContain('ls_session=');
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(response.headers.get('Set-Cookie')).toContain('SameSite=Lax');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=28800');
  });

  it('rejects invalid access codes', async () => {
    const response = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode: 'WRONG-CODE' }),
      },
      authEnv,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid access code.' });
  });

  it('rejects /auth/me without a session cookie', async () => {
    const response = await app.request('/auth/me', undefined, authEnv);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Not authenticated.' });
  });

  it('returns the authenticated company for a valid session cookie', async () => {
    const loginResponse = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode: 'DEMO-ACCESS-2026' }),
      },
      authEnv,
    );
    const sessionCookie = loginResponse.headers.get('Set-Cookie')?.split(';')[0];

    if (!sessionCookie) {
      throw new Error('Expected session cookie');
    }

    const response = await app.request(
      '/auth/me',
      {
        headers: { Cookie: sessionCookie },
      },
      authEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      company: {
        public_id: '82b4c7b9-68d1-4cc6-9e36-41d4db4e05f0',
        name: 'Ludus Sales Demo',
      },
    });
  });

  it('clears the session cookie on logout', async () => {
    const response = await app.request(
      '/auth/logout',
      {
        method: 'POST',
      },
      authEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get('Set-Cookie')).toContain('ls_session=');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});
