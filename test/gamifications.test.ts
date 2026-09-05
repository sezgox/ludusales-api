import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';
import { runGamificationMaintenance } from '../src/gamifications';

type TestEnv = Env & { TEST_MIGRATIONS: D1Migration[] };

const testEnv = env as TestEnv;
const demoCompanyId = '82b4c7b9-68d1-4cc6-9e36-41d4db4e05f0';
const otherCompanyId = '4c6f2c3d-3f73-4472-a453-4e0d6cb472d8';

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO companies (public_id, name) VALUES (?, ?)').bind(demoCompanyId, 'Ludus Sales Demo'),
    testEnv.DB.prepare('INSERT INTO companies (public_id, name) VALUES (?, ?)').bind(otherCompanyId, 'Ludus Sales Beta'),
    testEnv.DB.prepare(
      `INSERT INTO users (public_id, role, display_name, email, access_code_hash, company_id)
       VALUES (?, 'superuser', ?, ?, ?, NULL)`,
    ).bind(
      '99999999-9999-4999-8999-999999999999',
      'Owner local',
      'owner@ludusales.local',
      'CaOHpuTkYPpTsPnn2_ySLAxTL5FDgbQUKJUtI0njtdU',
    ),
    testEnv.DB.prepare(
      `INSERT INTO users (public_id, role, display_name, email, access_code_hash, company_id)
       SELECT ?, 'company', ?, ?, ?, id FROM companies WHERE public_id = ?`,
    ).bind(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Ludus Sales Demo',
      'demo@ludusales.local',
      'z2jjggVZ7dLgb7GtG2nIZklvToG8uRj9udau8ChlP10',
      demoCompanyId,
    ),
  ]);
});

describe('gamification schema', () => {
  it('enforces dates, decimal precision and cascading children', async () => {
    const company = await testEnv.DB.prepare('SELECT id FROM companies WHERE public_id = ?').bind(demoCompanyId).first<{ id: number }>();
    await expect(
      testEnv.DB.prepare(
        `INSERT INTO gamifications
         (public_id, company_id, description, start_at, end_at, goal_value, value_precision, goal_unit)
         VALUES ('invalid', ?, 'Invalid', '2027-01-02T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 1, 7, 'sales')`,
      )
        .bind(company!.id)
        .run(),
    ).rejects.toThrow();

    await testEnv.DB.prepare(
      `INSERT INTO gamifications
       (public_id, company_id, description, start_at, end_at, goal_value, value_precision, goal_unit)
       VALUES ('cascade-test', ?, 'Cascade', '2027-01-01T00:00:00.000Z', '2027-01-02T00:00:00.000Z', 100, 2, 'sales')`,
    )
      .bind(company!.id)
      .run();
    const gamification = await testEnv.DB.prepare("SELECT id FROM gamifications WHERE public_id = 'cascade-test'").first<{ id: number }>();
    await testEnv.DB.prepare(
      "INSERT INTO prizes (public_id, gamification_id, name) VALUES ('cascade-prize', ?, 'Prize')",
    )
      .bind(gamification!.id)
      .run();
    await testEnv.DB.prepare("DELETE FROM gamifications WHERE public_id = 'cascade-test'").run();
    await expect(testEnv.DB.prepare("SELECT id FROM prizes WHERE public_id = 'cascade-prize'").first()).resolves.toBeNull();
  });
});

describe('gamification API', () => {
  it('sanitizes rich descriptions and rejects empty or oversized content', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const richDescription = [
      '<h2 onclick="alert(1)">Reto trimestral</h2>',
      '<p>Consigue <strong>más ventas</strong> y <a href="https://example.com" title="Reglas">consulta las reglas</a>.</p>',
      '<script>alert(1)</script><img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">Enlace inseguro</a>',
    ].join('');
    const created = await createGamification(cookie, demoCompanyId, richDescription);
    const detail = await request(`/companies/${demoCompanyId}/gamifications/${created.publicId}`, cookie);
    const detailBody = (await detail.json()) as { gamification: { description: string } };

    expect(detailBody.gamification.description).toBe(
      '<h2>Reto trimestral</h2><p>Consigue <strong>más ventas</strong> y <a href="https://example.com" title="Reglas">consulta las reglas</a>.</p>Enlace inseguro',
    );

    const empty = await request(`/superuser/gamifications/${created.publicId}`, cookie, {
      method: 'PATCH',
      json: { description: '<script>alert(1)</script><br>' },
    });
    expect(empty.status).toBe(400);

    const oversized = await request(`/superuser/gamifications/${created.publicId}`, cookie, {
      method: 'PATCH',
      json: { description: `<p>${'x'.repeat(20_001)}</p>` },
    });
    expect(oversized.status).toBe(400);
  });

  it('allows only superusers to write and isolates company reads', async () => {
    const companyCookie = await login('DEMO-ACCESS-2026');
    const superuserCookie = await login('OWNER-LOCAL-2026');

    const forbidden = await request(`/superuser/companies/${demoCompanyId}/gamifications`, companyCookie, {
      method: 'POST',
      json: gamificationPayload('Forbidden'),
    });
    expect(forbidden.status).toBe(403);

    const created = await createGamification(superuserCookie, demoCompanyId, 'Visible');
    expect(created.goal).toBe('125.50');

    const ownRead = await request(`/companies/${demoCompanyId}/gamifications`, companyCookie);
    expect(ownRead.status).toBe(200);
    const ownBody = (await ownRead.json()) as { gamifications: Array<{ publicId: string }> };
    expect(ownBody.gamifications.some((item) => item.publicId === created.publicId)).toBe(true);

    const otherRead = await request(`/companies/${otherCompanyId}/gamifications`, companyCookie);
    expect(otherRead.status).toBe(403);
  });

  it('supports overlapping active gamifications', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const first = await createGamification(cookie, demoCompanyId, 'First');
    const second = await createGamification(cookie, demoCompanyId, 'Second');

    expect((await request(`/superuser/gamifications/${first.publicId}/activate`, cookie, { method: 'POST' })).status).toBe(200);
    expect((await request(`/superuser/gamifications/${second.publicId}/activate`, cookie, { method: 'POST' })).status).toBe(200);

    const active = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM gamifications WHERE status = 'active'`,
    ).first<{ count: number }>();
    expect(active?.count).toBe(2);
  });

  it('replaces and upserts rankings, derives 1-1-3 positions and freezes a closed result', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const gamification = await createGamification(cookie, demoCompanyId, 'Ranking');
    await request(`/superuser/gamifications/${gamification.publicId}/activate`, cookie, { method: 'POST' });

    const replace = await request(`/superuser/gamifications/${gamification.publicId}/ranking`, cookie, {
      method: 'PUT',
      json: {
        entries: [
          { externalParticipantId: 'p1', fullName: 'Ana', score: '50.25' },
          { externalParticipantId: 'p2', fullName: 'Bea', score: '50.25' },
          { externalParticipantId: 'p3', fullName: 'Carla', score: '20.00' },
        ],
      },
    });
    expect(replace.status).toBe(200);

    const upsert = await request(`/superuser/gamifications/${gamification.publicId}/ranking/p3`, cookie, {
      method: 'PUT',
      json: { fullName: 'Carla Ruiz', score: '25.00' },
    });
    expect(upsert.status).toBe(200);

    const detail = await request(`/companies/${demoCompanyId}/gamifications/${gamification.publicId}`, cookie);
    const detailBody = (await detail.json()) as {
      gamification: { ranking: Array<{ position: number; score: string; fullName: string }> };
    };
    expect(detailBody.gamification.ranking.map((entry) => entry.position)).toEqual([1, 1, 3]);
    expect(detailBody.gamification.ranking[2]).toMatchObject({ fullName: 'Carla Ruiz', score: '25.00' });

    const closed = await request(`/superuser/gamifications/${gamification.publicId}/close`, cookie, { method: 'POST' });
    const closedBody = (await closed.json()) as { gamification: { status: string; outcome: string } };
    expect(closedBody.gamification).toMatchObject({ status: 'closed', outcome: 'achieved' });

    const frozen = await request(`/superuser/gamifications/${gamification.publicId}/ranking/p1`, cookie, {
      method: 'PUT',
      json: { fullName: 'Ana', score: '60.00' },
    });
    expect(frozen.status).toBe(409);
  });

  it('closes expired active gamifications from scheduled maintenance', async () => {
    const company = await testEnv.DB.prepare('SELECT id FROM companies WHERE public_id = ?').bind(demoCompanyId).first<{ id: number }>();
    await testEnv.DB.prepare(
      `INSERT INTO gamifications
       (public_id, company_id, description, start_at, end_at, goal_value, value_precision, goal_unit, status)
       VALUES ('expired', ?, 'Expired', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', 1000, 2, 'sales', 'active')`,
    )
      .bind(company!.id)
      .run();

    await runGamificationMaintenance(testEnv, new Date('2025-01-03T00:00:00.000Z'));
    const row = await testEnv.DB.prepare("SELECT status, outcome FROM gamifications WHERE public_id = 'expired'").first<{
      status: string;
      outcome: string;
    }>();
    expect(row).toEqual({ status: 'closed', outcome: 'missed' });
  });

  it('validates WebP, stores immutable media and removes replaced objects through the queue', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const gamification = await createGamification(cookie, demoCompanyId, 'Images');

    const invalid = await request(`/superuser/gamifications/${gamification.publicId}/image`, cookie, {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
      contentType: 'image/webp',
    });
    expect(invalid.status).toBe(415);

    const tooWide = await request(`/superuser/gamifications/${gamification.publicId}/image`, cookie, {
      method: 'PUT',
      body: webp(2401, 10),
      contentType: 'image/webp',
    });
    expect(tooWide.status).toBe(422);

    const firstUpload = await request(`/superuser/gamifications/${gamification.publicId}/image`, cookie, {
      method: 'PUT',
      body: webp(100, 100),
      contentType: 'image/webp',
    });
    expect(firstUpload.status).toBe(200);
    const firstKey = (await testEnv.DB.prepare('SELECT image_key FROM gamifications WHERE public_id = ?')
      .bind(gamification.publicId)
      .first<{ image_key: string }>())!.image_key;
    const storedObject = await testEnv.MEDIA_BUCKET.get(firstKey);
    expect(storedObject).not.toBeNull();
    expect(storedObject?.httpMetadata).toMatchObject({
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    await storedObject?.arrayBuffer();

    expect(
      (
        await request(`/superuser/gamifications/${gamification.publicId}/image`, cookie, {
          method: 'PUT',
          body: webp(200, 200),
          contentType: 'image/webp',
        })
      ).status,
    ).toBe(200);
    expect(await testEnv.DB.prepare('SELECT object_key FROM media_deletion_queue WHERE object_key = ?').bind(firstKey).first()).not.toBeNull();

    await runGamificationMaintenance(testEnv);
    expect(await testEnv.MEDIA_BUCKET.get(firstKey)).toBeNull();
    expect(await testEnv.DB.prepare('SELECT object_key FROM media_deletion_queue WHERE object_key = ?').bind(firstKey).first()).toBeNull();
  });

  it('deletes children and queues attached media when a gamification is explicitly removed', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const gamification = await createGamification(cookie, demoCompanyId, 'Delete');
    const prizeResponse = await request(`/superuser/gamifications/${gamification.publicId}/prizes`, cookie, {
      method: 'POST',
      json: { name: 'Trip' },
    });
    const prize = (await prizeResponse.json()) as { prize: { publicId: string } };
    expect(prizeResponse.status).toBe(201);

    const picture = await request(`/superuser/prizes/${prize.prize.publicId}/picture`, cookie, {
      method: 'PUT',
      body: webp(80, 80),
      contentType: 'image/webp',
    });
    expect(picture.status).toBe(200);

    expect((await request(`/superuser/gamifications/${gamification.publicId}`, cookie, { method: 'DELETE' })).status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT id FROM prizes WHERE public_id = ?').bind(prize.prize.publicId).first()).toBeNull();
    const queued = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM media_deletion_queue').first<{ count: number }>();
    expect(queued?.count).toBe(1);
  });
});

const login = async (accessCode: string): Promise<string> => {
  const response = await app.request(
    '/auth/login',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode }) },
    testEnv,
  );
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0];
};

const request = (
  path: string,
  cookie: string,
  options: { method?: string; json?: unknown; body?: BodyInit; contentType?: string } = {},
): Promise<Response> => {
  const headers = new Headers({ Cookie: cookie });
  let body = options.body;
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.json);
  } else if (options.contentType) {
    headers.set('Content-Type', options.contentType);
  }
  return Promise.resolve(app.request(path, { method: options.method ?? 'GET', headers, body }, testEnv));
};

const createGamification = async (cookie: string, companyId: string, description: string) => {
  const response = await request(`/superuser/companies/${companyId}/gamifications`, cookie, {
    method: 'POST',
    json: gamificationPayload(description),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { gamification: { publicId: string; goal: string } }).gamification;
};

const gamificationPayload = (description: string) => ({
  description,
  startAt: '2027-01-01T09:00:00+01:00',
  endAt: '2027-02-01T18:00:00+01:00',
  goal: '125.50',
  valuePrecision: 2,
  goalUnit: 'sales',
});

const webp = (width: number, height: number): ArrayBuffer => {
  const buffer = new ArrayBuffer(30);
  const bytes = new Uint8Array(buffer);
  writeAscii(bytes, 0, 'RIFF');
  writeAscii(bytes, 8, 'WEBP');
  writeAscii(bytes, 12, 'VP8X');
  bytes[4] = 22;
  bytes[16] = 10;
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  bytes[24] = widthMinusOne & 0xff;
  bytes[25] = (widthMinusOne >>> 8) & 0xff;
  bytes[26] = (widthMinusOne >>> 16) & 0xff;
  bytes[27] = heightMinusOne & 0xff;
  bytes[28] = (heightMinusOne >>> 8) & 0xff;
  bytes[29] = (heightMinusOne >>> 16) & 0xff;
  return buffer;
};

const writeAscii = (bytes: Uint8Array, offset: number, value: string): void => {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
};
