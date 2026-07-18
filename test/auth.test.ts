import { describe, expect, it, vi, afterEach } from 'vitest';
import app from '../src/index';
import { FakeD1 } from './fake-d1';

const baseEnv = (db: FakeD1): Env => ({
  DB: db.asD1(),
  RESEND_API_KEY: 'resend-key',
  FRONTEND_ORIGINS: 'http://localhost:4200',
  FRONTEND_BACKOFFICE_URL: 'http://localhost:4200/backoffice',
  MICROSOFT_CLIENT_ID: 'client-id',
  MICROSOFT_CLIENT_SECRET: 'client-secret',
  MICROSOFT_REDIRECT_URI: 'https://worker.test/auth/microsoft/callback',
  MICROSOFT_TENANT: 'consumers',
  SESSION_SECRET: 'session-secret',
  TOKEN_ENCRYPTION_KEY: 'token-encryption-secret',
  OWNER_MICROSOFT_EMAIL: 'juan.mateoc@outlook.com',
  OWNER_PUBLIC_EMAIL: 'juanma@ludusales.com',
});

describe('Microsoft owner auth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows the configured owner to log in and then log out', async () => {
    const db = new FakeD1();
    stubMicrosoftFetch('juan.mateoc@outlook.com');

    const startResponse = await app.request('/auth/microsoft/start', {}, baseEnv(db));
    const stateCookie = startResponse.headers.get('set-cookie');
    const location = startResponse.headers.get('location') ?? '';
    const state = new URL(location).searchParams.get('state');

    expect(startResponse.status).toBe(302);
    expect(state).toBeTruthy();

    const callbackResponse = await app.request(
      `/auth/microsoft/callback?code=code&state=${state}`,
      { headers: { Cookie: extractCookie(stateCookie, 'ludus_ms_state') } },
      baseEnv(db),
    );
    const sessionCookie = callbackResponse.headers.get('set-cookie');

    expect(callbackResponse.status).toBe(302);
    expect(sessionCookie).toContain('ludus_session=');

    const sessionCookieValue = extractCookie(sessionCookie, 'ludus_session');
    const meResponse = await app.request('/auth/me', { headers: { Cookie: sessionCookieValue } }, baseEnv(db));
    await expect(meResponse.json()).resolves.toEqual({
      authenticated: true,
      user: {
        email: 'juan.mateoc@outlook.com',
        publicEmail: 'juanma@ludusales.com',
        role: 'owner',
        name: 'Juanma',
      },
    });

    const logoutResponse = await app.request(
      '/auth/logout',
      { method: 'POST', headers: { Cookie: sessionCookieValue } },
      baseEnv(db),
    );

    expect(logoutResponse.status).toBe(200);

    const loggedOutResponse = await app.request('/auth/me', { headers: { Cookie: sessionCookieValue } }, baseEnv(db));
    await expect(loggedOutResponse.json()).resolves.toEqual({ authenticated: false });
  });

  it('rejects a Microsoft account that is not the configured owner', async () => {
    const db = new FakeD1();
    stubMicrosoftFetch('other@example.com');

    const startResponse = await app.request('/auth/microsoft/start', {}, baseEnv(db));
    const stateCookie = startResponse.headers.get('set-cookie');
    const location = startResponse.headers.get('location') ?? '';
    const state = new URL(location).searchParams.get('state');
    const callbackResponse = await app.request(
      `/auth/microsoft/callback?code=code&state=${state}`,
      { headers: { Cookie: extractCookie(stateCookie, 'ludus_ms_state') } },
      baseEnv(db),
    );

    expect(callbackResponse.status).toBe(403);
  });
});

const stubMicrosoftFetch = (email: string): void => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          scope: 'Mail.Read',
          token_type: 'Bearer',
        }),
        { status: 200 },
      );
    }

    if (url.includes('https://graph.microsoft.com/v1.0/me')) {
      return new Response(
        JSON.stringify({
          id: 'microsoft-user-id',
          displayName: 'Juanma',
          mail: email,
          userPrincipalName: email,
          otherMails: [],
        }),
        { status: 200 },
      );
    }

    return new Response('Not found', { status: 404 });
  });

  vi.stubGlobal('fetch', fetchMock);
};

const extractCookie = (setCookie: string | null, name: string): string => {
  if (!setCookie) {
    return '';
  }

  return setCookie
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) => cookie.trim().split(';')[0])
    .find((cookie) => cookie.startsWith(`${name}=`)) ?? '';
};
