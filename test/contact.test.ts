import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';

const baseEnv = {
  JWT_SECRET: 'test-jwt-secret',
  RESEND_API_KEY: 'test-key',
  CONTACT_TO_EMAIL: 'juan.mateo@ludusales.com',
  RESEND_FROM_EMAIL: 'Ludus Sales <contact@ludusales.com>',
  FRONTEND_ORIGINS: 'http://localhost:4200',
};

const db = (): Env['DB'] => (env as Env).DB;
const authEnv = (): Env => ({
  ...baseEnv,
  DB: db(),
  MEDIA_BUCKET: (env as Env).MEDIA_BUCKET,
  ASSET_BASE_URL: 'https://assets.ludusales.com',
});

const seedAuthDb = async (): Promise<void> => {
  const statements = [
    `CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS companies_public_id_unique ON companies (public_id)',
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('company', 'superuser')),
      display_name TEXT NOT NULL,
      email TEXT,
      access_code_hash TEXT NOT NULL,
      company_id INTEGER REFERENCES companies (id),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (role = 'company' AND company_id IS NOT NULL)
        OR (role = 'superuser' AND company_id IS NULL)
      )
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS users_public_id_unique ON users (public_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS users_access_code_hash_unique ON users (access_code_hash)',
    'CREATE INDEX IF NOT EXISTS users_company_id_idx ON users (company_id)',
    'DELETE FROM users',
    'DELETE FROM companies',
    `INSERT INTO companies (public_id, name)
    VALUES
      ('82b4c7b9-68d1-4cc6-9e36-41d4db4e05f0', 'Ludus Sales Demo'),
      ('4c6f2c3d-3f73-4472-a453-4e0d6cb472d8', 'Ludus Sales Beta')`,
    `INSERT INTO users (public_id, role, display_name, email, access_code_hash, company_id)
    VALUES (
      '99999999-9999-4999-8999-999999999999',
      'superuser',
      'Owner local',
      'owner@ludusales.local',
      'CaOHpuTkYPpTsPnn2_ySLAxTL5FDgbQUKJUtI0njtdU',
      NULL
    )`,
    `INSERT INTO users (public_id, role, display_name, email, access_code_hash, company_id)
    SELECT
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'company',
      'Ludus Sales Demo',
      'demo@ludusales.local',
      'z2jjggVZ7dLgb7GtG2nIZklvToG8uRj9udau8ChlP10',
      companies.id
    FROM companies
    WHERE companies.public_id = '82b4c7b9-68d1-4cc6-9e36-41d4db4e05f0'`,
  ];

  for (const statement of statements) {
    await db().prepare(statement).run();
  }
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
      baseEnv,
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
  beforeEach(async () => {
    await seedAuthDb();
  });

  it('creates an HttpOnly session cookie for a valid company access code', async () => {
    const response = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode: 'DEMO-ACCESS-2026' }),
      },
      authEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      role: 'company',
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
      authEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid access code.' });
  });

  it('creates a superuser session from a DB user', async () => {
    const response = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode: 'OWNER-LOCAL-2026' }),
      },
      authEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      role: 'superuser',
      companies: [
        {
          public_id: '4c6f2c3d-3f73-4472-a453-4e0d6cb472d8',
          name: 'Ludus Sales Beta',
        },
        {
          public_id: '82b4c7b9-68d1-4cc6-9e36-41d4db4e05f0',
          name: 'Ludus Sales Demo',
        },
      ],
    });
    expect(response.headers.get('Set-Cookie')).toContain('ls_session=');
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
  });

  it('requires the DB binding for auth', async () => {
    const response = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode: 'DEMO-ACCESS-2026' }),
      },
      baseEnv,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Authentication service is not configured.' });
  });

  it('rejects /auth/me without a session cookie', async () => {
    const response = await app.request('/auth/me', undefined, authEnv());

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
      authEnv(),
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
      authEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      role: 'company',
      company: {
        public_id: '82b4c7b9-68d1-4cc6-9e36-41d4db4e05f0',
        name: 'Ludus Sales Demo',
      },
    });
  });

  it('returns the company catalog for a valid superuser session cookie', async () => {
    const loginResponse = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode: 'OWNER-LOCAL-2026' }),
      },
      authEnv(),
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
      authEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      role: 'superuser',
      companies: [
        {
          public_id: '4c6f2c3d-3f73-4472-a453-4e0d6cb472d8',
          name: 'Ludus Sales Beta',
        },
        {
          public_id: '82b4c7b9-68d1-4cc6-9e36-41d4db4e05f0',
          name: 'Ludus Sales Demo',
        },
      ],
    });
  });

  it('rejects company creation without a session cookie', async () => {
    const response = await app.request(
      '/superuser/companies',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: 'Ludus Sales Nueva',
          accountName: 'Cuenta nueva',
          email: 'nueva@ludusales.local',
          accessCode: 'NUEVA-ACCESS-2026',
        }),
      },
      authEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Not authenticated.' });
  });

  it('forbids company creation for company users', async () => {
    const loginResponse = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode: 'DEMO-ACCESS-2026' }),
      },
      authEnv(),
    );
    const sessionCookie = loginResponse.headers.get('Set-Cookie')?.split(';')[0];

    if (!sessionCookie) {
      throw new Error('Expected session cookie');
    }

    const response = await app.request(
      '/superuser/companies',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          companyName: 'Ludus Sales Nueva',
          accountName: 'Cuenta nueva',
          email: 'nueva@ludusales.local',
          accessCode: 'NUEVA-ACCESS-2026',
        }),
      },
      authEnv(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden.' });
  });

  it('creates a company and company account for superusers', async () => {
    const loginResponse = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode: 'OWNER-LOCAL-2026' }),
      },
      authEnv(),
    );
    const sessionCookie = loginResponse.headers.get('Set-Cookie')?.split(';')[0];

    if (!sessionCookie) {
      throw new Error('Expected session cookie');
    }

    const response = await app.request(
      '/superuser/companies',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          companyName: 'Ludus Sales Nueva',
          accountName: 'Cuenta nueva',
          email: 'nueva@ludusales.local',
          accessCode: 'NUEVA-ACCESS-2026',
        }),
      },
      authEnv(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; company: { public_id: string; name: string } };

    expect(body.ok).toBe(true);
    expect(body.company.name).toBe('Ludus Sales Nueva');
    expect(body.company.public_id).toEqual(expect.any(String));

    const createdLoginResponse = await app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessCode: 'NUEVA-ACCESS-2026' }),
      },
      authEnv(),
    );

    expect(createdLoginResponse.status).toBe(200);
    await expect(createdLoginResponse.json()).resolves.toEqual({
      ok: true,
      role: 'company',
      company: {
        public_id: body.company.public_id,
        name: 'Ludus Sales Nueva',
      },
    });
  });

  it('clears the session cookie on logout', async () => {
    const response = await app.request(
      '/auth/logout',
      {
        method: 'POST',
      },
      authEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get('Set-Cookie')).toContain('ls_session=');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});
