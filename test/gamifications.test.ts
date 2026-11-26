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
         VALUES ('invalid', ?, 'Invalid', '2027-01-02', '2027-01-01', 1, 7, 'sales')`,
      )
        .bind(company!.id)
        .run(),
    ).rejects.toThrow();

    await testEnv.DB.prepare(
      `INSERT INTO gamifications
       (public_id, company_id, description, start_at, end_at, goal_value, value_precision, goal_unit)
       VALUES ('cascade-test', ?, 'Cascade', '2027-01-01', '2027-01-02', 100, 2, 'sales')`,
    )
      .bind(company!.id)
      .run();
    const gamification = await testEnv.DB.prepare("SELECT id FROM gamifications WHERE public_id = 'cascade-test'").first<{ id: number }>();
    await testEnv.DB.prepare(
      "INSERT INTO prizes (public_id, gamification_id, name, ranking_position) VALUES ('cascade-prize', ?, 'Prize', 1)",
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
    expect(created.title).toBe('Reto de prueba');

    const invalidPayload = gamificationPayload('Sin título');
    const { title: _title, ...withoutTitle } = invalidPayload;
    const missingTitle = await request(`/superuser/companies/${demoCompanyId}/gamifications`, superuserCookie, {
      method: 'POST',
      json: withoutTitle,
    });
    expect(missingTitle.status).toBe(400);

    const ownDraft = await request(`/companies/${demoCompanyId}/gamifications/${created.publicId}`, companyCookie);
    expect(ownDraft.status).toBe(404);
    const activation = await request(`/superuser/gamifications/${created.publicId}/activate`, superuserCookie, { method: 'POST' });
    expect(activation.status).toBe(200);
    const ownRead = await request(`/companies/${demoCompanyId}/gamifications`, companyCookie);
    expect(ownRead.status).toBe(200);
    const ownBody = (await ownRead.json()) as { gamifications: Array<{ publicId: string }> };
    expect(ownBody.gamifications.some((item) => item.publicId === created.publicId)).toBe(true);

    const otherRead = await request(`/companies/${otherCompanyId}/gamifications`, companyCookie);
    expect(otherRead.status).toBe(403);
  });

  it('defaults and validates the Live Ranking participant limit', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const gamification = await createGamification(cookie, demoCompanyId, 'Live limit');
    const detail = await request(`/companies/${demoCompanyId}/gamifications/${gamification.publicId}`, cookie);
    expect(((await detail.json()) as { gamification: { maxLiveRanking: number; rankingUnit: string } }).gamification)
      .toMatchObject({ maxLiveRanking: 5, rankingUnit: 'Ludu Points', tvEnabled: false });

    const updated = await request(`/superuser/gamifications/${gamification.publicId}`, cookie, {
      method: 'PATCH', json: { maxLiveRanking: 7, rankingUnit: 'Créditos', tvEnabled: true },
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { gamification: { maxLiveRanking: number; rankingUnit: string } }).gamification)
      .toMatchObject({ maxLiveRanking: 7, rankingUnit: 'Créditos', tvEnabled: true });

    const invalid = await request(`/superuser/gamifications/${gamification.publicId}`, cookie, {
      method: 'PATCH', json: { maxLiveRanking: 2 },
    });
    expect(invalid.status).toBe(400);
  });

  it('records immutable ranking results, shows movement, and atomically restores a previous publication', async () => {
    const owner = await login('OWNER-LOCAL-2026');
    const company = await login('DEMO-ACCESS-2026');
    const created = await createGamification(owner, demoCompanyId, 'Publicaciones');
    const readPath = `/companies/${demoCompanyId}/gamifications/${created.publicId}`;
    const managePath = `/superuser/gamifications/${created.publicId}`;
    expect((await request(`${managePath}/activate`, owner, { method: 'POST' })).status).toBe(200);

    const publish = async (alice: string, bob: string) => request(`${managePath}/ranking`, owner, {
      method: 'PUT', json: { fieldHeaders: ['Zona'], entries: [
        { participantCode: 'snap-alice', fullName: 'Alicia', score: alice, customFields: { Zona: 'Sur' } },
        { participantCode: 'snap-bob', fullName: 'Roberto', score: bob, customFields: { Zona: 'Norte' } },
      ] },
    });
    expect((await publish('10.00', '7.25')).status).toBe(200);
    expect((await publish('9.95', '12.50')).status).toBe(200);

    const detail = await (await request(readPath, company)).json() as { gamification: { ranking: unknown[]; rankingTotal: string } };
    expect(detail.gamification.rankingTotal).toBe('22.45');
    expect(detail.gamification.ranking).toMatchObject([
      { participantCode: 'snap-bob', position: 1, positionChange: 1, scoreChange: '5.25' },
      { participantCode: 'snap-alice', position: 2, positionChange: -1, scoreChange: '-0.05' },
    ]);
    const evolution = await (await request(`${readPath}/ranking/snap-alice/history`, company)).json() as { history: unknown[] };
    expect(evolution.history).toMatchObject([{ position: 1, score: '10.00' }, { position: 2, score: '9.95' }]);

    const publications = await (await request(`${managePath}/ranking-publications`, owner)).json() as { publications: Array<{ publicId: string }> };
    const [latest, previous] = publications.publications;
    expect((await request(`${managePath}/ranking-publications/${latest!.publicId}/revert`, company, { method: 'POST' })).status).toBe(403);
    expect((await request(`${managePath}/ranking-publications/${previous!.publicId}/revert`, owner, { method: 'POST' })).status).toBe(409);
    const attempts = await Promise.all([1, 2].map(() => request(`${managePath}/ranking-publications/${latest!.publicId}/revert`, owner, { method: 'POST' })));
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 409]);
    const restored = await (await request(readPath, company)).json() as { gamification: { ranking: unknown[]; rankingTotal: string } };
    expect(restored.gamification.rankingTotal).toBe('17.25');
    expect(restored.gamification.ranking).toMatchObject([
      { participantCode: 'snap-alice', position: 1, positionChange: null, customFields: { Zona: 'Sur' } },
      { participantCode: 'snap-bob', position: 2, positionChange: null, customFields: { Zona: 'Norte' } },
    ]);
  });

  it('publishes the validated master spreadsheet once and projects only permitted data to the company and TV', async () => {
    const owner = await login('OWNER-LOCAL-2026');
    const company = await login('DEMO-ACCESS-2026');
    const today = new Date().toISOString().slice(0, 10);
    const after = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const create = await request(`/superuser/companies/${demoCompanyId}/gamifications`, owner, {
      method: 'POST', json: { ...gamificationPayload('Maestro'), startAt: today, endAt: after, tvEnabled: true },
    });
    const { gamification } = await create.json() as { gamification: { publicId: string } };
    const admin = `/superuser/gamifications/${gamification.publicId}`;
    const portal = `/companies/${demoCompanyId}/gamifications/${gamification.publicId}`;
    expect((await request(`${admin}/activate`, owner, { method: 'POST' })).status).toBe(200);
    expect((await request(`${admin}/challenge-members/master-a`, owner, { method: 'PUT', json: { fullName: 'Nombre Privado', zone: 'Norte', active: true } })).status).toBe(200);
    const settings = { metrics: [{ key: 'importe', label: 'Importe privado', kind: 'sum', integer: false }],
      rules: [{ metric: 'importe', label: 'Puntuación', rate: 1 }], hiddenMetrics: ['importe'], anonymousFrom: 1 };
    expect((await request(`${admin}/challenge-settings`, owner, { method: 'PUT', json: settings })).status).toBe(200);
    const input = { mode: 'accumulated', sourceName: 'test.xlsx', headers: ['id_participante', 'nombre', 'fecha_datos', 'importe'],
      rows: [{ id_participante: 'master-a', nombre: 'Nombre Privado', fecha_datos: today, importe: 125.5 }] };
    const preview = async () => {
      const response = await request(`${admin}/master-preview`, owner, { method: 'POST', json: { input } });
      expect(response.status).toBe(200);
      const data = await response.json() as { previewToken: string; entries: unknown[] };
      expect(data.entries).toMatchObject([{ code: 'master-a', score: 125.5, position: 1 }]);
      return data.previewToken;
    };
    const publish = (previewToken: string) => request(`${admin}/master-publications`, owner, { method: 'POST', json: { input, previewToken } });
    const stale = await preview();
    expect((await request(`${admin}/challenge-settings`, owner, { method: 'PUT', json: { ...settings, showPhotos: false } })).status).toBe(200);
    expect((await publish(stale)).status).toBe(409);
    const current = await preview();
    expect((await publish(current)).status).toBe(201);
    expect((await publish(current)).status).toBe(200);
    expect((await request(`${admin}/master-preview`, company, { method: 'POST', json: { input } })).status).toBe(403);

    const visible = await (await request(portal, company)).json() as { gamification: { ranking: unknown[]; rankingFieldHeaders: string[] } };
    expect(visible.gamification.ranking).toMatchObject([{ fullName: 'Participante 1', score: '125.50', customFields: { Zona: 'Norte' }, pictureUrl: null }]);
    expect(JSON.stringify(visible.gamification.ranking)).not.toContain('Importe privado');
    expect(visible.gamification.rankingFieldHeaders).not.toContain('Importe privado');

    const generated = await request(`${admin}/tv-link`, owner, { method: 'POST' });
    expect(generated.status).toBe(201);
    const { token } = (await generated.json()) as { token: string };
    const tv = await app.request('/tv/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }, testEnv);
    expect(tv.headers.get('cache-control')).toBe('no-store');
    expect(await tv.json()).toMatchObject({ ranking: [{ name: 'Participante 1', position: 1, score: 125.5 }] });
    expect((await request(`${admin}/tv-link`, owner, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/tv/read', { method: 'POST', body: JSON.stringify({ token }) }, testEnv)).status).toBe(404);

    const workbook = Uint8Array.from([80, 75, 3, 4, 10, 20, 30]);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', workbook));
    const sourceHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const withArchive = { ...input, sourceHash };
    const beforeArchive = await request(`${admin}/master-preview`, owner, { method: 'POST', json: { input: withArchive } });
    expect(beforeArchive.status).toBe(200);
    const { previewToken } = (await beforeArchive.json()) as { previewToken: string };
    const form = new FormData();
    form.set('payload', JSON.stringify({ input: withArchive, previewToken }));
    form.set('workbook', new File([workbook], input.sourceName));
    const archived = await app.request(`${admin}/master-publications`, { method: 'POST', headers: { Cookie: owner }, body: form }, testEnv);
    expect(archived.status).toBe(201);
    const { publicId } = (await archived.json()) as { publicId: string };
    const download = `${admin}/ranking-publications/${publicId}/workbook`;
    expect((await request(download, company)).status).toBe(403);
    expect(new Uint8Array(await (await request(download, owner)).arrayBuffer())).toEqual(workbook);

    const prize = await request(`${admin}/prizes`, owner, { method: 'POST', json: { name: 'Sorteo', kind: 'raffle', rankingPosition: null } });
    expect(prize.status).toBe(201);
    const { prize: draw } = (await prize.json()) as { prize: { publicId: string; rankingPosition: number | null } };
    expect(draw.rankingPosition).toBeNull();
    const drawPath = `/superuser/prizes/${draw.publicId}/confirm`;
    expect((await request(drawPath, owner, { method: 'POST' })).status).toBe(409);
    expect((await request(`${admin}/deactivate`, owner, { method: 'POST' })).status).toBe(200);
    const attempts = await Promise.all([1, 2].map(() => request(drawPath, owner, { method: 'POST' })));
    expect(attempts.map(({ status }) => status)).toEqual([200, 200]);
    const confirmed = await (await request(portal, company)).json() as { gamification: { prizes: unknown[] } };
    expect(confirmed.gamification.prizes).toMatchObject([{ kind: 'raffle', winners: ['Participante 1'] }]);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM prize_decisions WHERE prize_public_id = ?').bind(draw.publicId).first()).toMatchObject({ count: 1 });
  });

  it('stores ordered rules and closes gamifications without a goal as not applicable', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const payload = {
      ...gamificationPayload('Rules'),
      goal: null,
      goalUnit: null,
      rules: [
        { position: 2, title: 'Premio', description: 'Gana puntos por resultados.', iconName: 'award' },
        { position: 1, title: 'Ventas', description: 'Cierra ventas y suma puntos.', iconName: 'chart-column' },
      ],
    };
    const created = await request(`/superuser/companies/${demoCompanyId}/gamifications`, cookie, { method: 'POST', json: payload });
    expect(created.status).toBe(201);
    const gamification = (await created.json()) as { gamification: { publicId: string; goal: null; goalUnit: null } };
    expect(gamification.gamification).toMatchObject({ goal: null, goalUnit: null });

    const detail = await request(`/companies/${demoCompanyId}/gamifications/${gamification.gamification.publicId}`, cookie);
    expect(((await detail.json()) as { gamification: { rules: Array<{ position: number; iconName: string }> } }).gamification.rules)
      .toEqual([{ position: 1, title: 'Ventas', description: 'Cierra ventas y suma puntos.', iconName: 'chart-column' }, { position: 2, title: 'Premio', description: 'Gana puntos por resultados.', iconName: 'award' }]);

    const invalid = await request(`/superuser/gamifications/${gamification.gamification.publicId}`, cookie, {
      method: 'PATCH',
      json: { rules: [{ position: 1, title: 'Duplicada', description: 'Una.', iconName: 'star' }, { position: 1, title: 'Duplicada', description: 'Dos.', iconName: 'star' }] },
    });
    expect(invalid.status).toBe(400);

    expect((await request(`/superuser/gamifications/${gamification.gamification.publicId}/activate`, cookie, { method: 'POST' })).status).toBe(200);
    const deactivated = await request(`/superuser/gamifications/${gamification.gamification.publicId}/deactivate`, cookie, { method: 'POST' });
    expect(((await deactivated.json()) as { gamification: { outcome: string } }).gamification.outcome).toBe('not_applicable');

    const goalAddedAfterClose = await request(`/superuser/gamifications/${gamification.gamification.publicId}`, cookie, {
      method: 'PATCH', json: { goal: '1', goalUnit: 'ventas' },
    });
    expect(((await goalAddedAfterClose.json()) as { gamification: { outcome: string } }).gamification.outcome).toBe('missed');
  });

  it('stores optional estimated prize value and enforces one prize per position', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const gamification = await createGamification(cookie, demoCompanyId, 'Prizes');
    const created = await request(`/superuser/gamifications/${gamification.publicId}/prizes`, cookie, {
      method: 'POST', json: { name: 'Trip', rankingPosition: 1, estimatedValue: 99.95 },
    });
    expect(created.status).toBe(201);
    const prize = ((await created.json()) as { prize: { publicId: string; rankingPosition: number; estimatedValue: number | null } }).prize;
    expect(prize).toEqual({
      publicId: expect.any(String), name: 'Trip', pictureUrl: null, sortOrder: 0, rankingPosition: 1, estimatedValue: 99.95,
      createdAt: expect.any(String), updatedAt: expect.any(String), kind: 'position', description: '', parameter: '',
    });

    const renamed = await request(`/superuser/prizes/${prize.publicId}`, cookie, { method: 'PATCH', json: { name: 'Trip renamed' } });
    expect(((await renamed.json()) as { prize: { estimatedValue: number | null } }).prize.estimatedValue).toBe(99.95);

    const duplicate = await request(`/superuser/gamifications/${gamification.publicId}/prizes`, cookie, {
      method: 'POST', json: { name: 'Another trip', rankingPosition: 1, estimatedValue: null },
    });
    expect(duplicate.status).toBe(409);

    const invalidAmount = await request(`/superuser/gamifications/${gamification.publicId}/prizes`, cookie, {
      method: 'POST', json: { name: 'Invalid amount', rankingPosition: 2, estimatedValue: 10.999 },
    });
    expect(invalidAmount.status).toBe(400);
  });

  it('stores ordered configurable blocks and reuses global block images', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const gamification = await createGamification(cookie, demoCompanyId, 'Blocks');
    const first = await request(`/superuser/gamifications/${gamification.publicId}/block-one-cards`, cookie, {
      method: 'POST', json: { title: 'Objetivo mensual', iconName: 'target', value: '75', subvalue: 'Ventas', hasProgress: true, currentValue: '50.5', maxValue: '75.25' },
    });
    expect(first.status).toBe(201);
    const firstCard = ((await first.json()) as { card: { publicId: string } }).card;
    const second = await request(`/superuser/gamifications/${gamification.publicId}/block-one-cards`, cookie, {
      method: 'POST', json: { title: 'Puntos', iconName: 'star', value: '120', subvalue: null, hasProgress: false },
    });
    const secondCard = ((await second.json()) as { card: { publicId: string } }).card;
    expect((await request(`/superuser/gamifications/${gamification.publicId}/block-one-cards/order`, cookie, {
      method: 'PUT', json: { ids: [secondCard.publicId, firstCard.publicId] },
    })).status).toBe(200);

    const uploaded = await request('/superuser/block-images', cookie, { method: 'PUT', body: webp(80, 80), contentType: 'image/webp' });
    expect(uploaded.status).toBe(201);
    const image = ((await uploaded.json()) as { image: { publicId: string } }).image;
    const promo = await request(`/superuser/gamifications/${gamification.publicId}/block-two-cards`, cookie, {
      method: 'POST', json: { imagePublicId: image.publicId, title: 'Premio mensual', description: 'Cena para primera posición.' },
    });
    expect(promo.status).toBe(201);

    const detail = await request(`/companies/${demoCompanyId}/gamifications/${gamification.publicId}`, cookie);
    const body = (await detail.json()) as { gamification: { blockOneCards: Array<{ title: string; progressCurrent: string | null }>; blockTwoCards: Array<{ imagePublicId: string }> } };
    expect(body.gamification.blockOneCards.map((card) => card.title)).toEqual(['Puntos', 'Objetivo mensual']);
    expect(body.gamification.blockOneCards[1].progressCurrent).toBe('50.5');
    expect(body.gamification.blockTwoCards).toEqual([expect.objectContaining({ imagePublicId: image.publicId })]);
    expect((await request('/superuser/block-images', cookie)).status).toBe(200);
  });

  it('supports overlapping active gamifications', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const first = await createGamification(cookie, demoCompanyId, 'First');
    const second = await createGamification(cookie, demoCompanyId, 'Second');

    expect((await request(`/superuser/gamifications/${first.publicId}/activate`, cookie, { method: 'POST' })).status).toBe(200);
    expect((await request(`/superuser/gamifications/${second.publicId}/activate`, cookie, { method: 'POST' })).status).toBe(200);

    const active = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM gamifications
       WHERE status = 'active'
         AND company_id = (SELECT id FROM companies WHERE public_id = ?)`,
    )
      .bind(demoCompanyId)
      .first<{ count: number }>();
    expect(active?.count).toBe(2);
  });

  it('replaces and upserts rankings, derives 1-1-3 positions and keeps inactive gamifications editable', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const gamification = await createGamification(cookie, demoCompanyId, 'Ranking');
    await request(`/superuser/gamifications/${gamification.publicId}/activate`, cookie, { method: 'POST' });

    const replace = await request(`/superuser/gamifications/${gamification.publicId}/ranking`, cookie, {
      method: 'PUT',
      json: {
        fieldHeaders: ['Email', 'Localización'],
        entries: [
          { participantCode: 'p1', fullName: 'Ana', score: '50.25', customFields: { Email: 'ana@example.com', Localización: 'Valencia' } },
          { participantCode: 'p2', fullName: 'Bea', score: '50.25' },
          { participantCode: 'p3', fullName: 'Carla', score: '20.00' },
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
      gamification: { rankingFieldHeaders: string[]; ranking: Array<{ position: number; score: string; fullName: string; customFields: Record<string, string> }> };
    };
    expect(detailBody.gamification.ranking.map((entry) => entry.position)).toEqual([1, 1, 3]);
    expect(detailBody.gamification.rankingFieldHeaders).toEqual(['Email', 'Localización']);
    expect(detailBody.gamification.ranking[0].customFields).toEqual({ Email: 'ana@example.com', Localización: 'Valencia' });
    expect(detailBody.gamification.ranking[2]).toMatchObject({ fullName: 'Carla Ruiz', score: '25.00' });

    const picture = await request(`/superuser/gamifications/${gamification.publicId}/ranking/p3/picture`, cookie, {
      method: 'PUT', body: webp(80, 80), contentType: 'image/webp',
    });
    expect(picture.status).toBe(200);
    const withPicture = await request(`/companies/${demoCompanyId}/gamifications/${gamification.publicId}`, cookie);
    const picturedEntry = ((await withPicture.json()) as {
      gamification: { ranking: Array<{ participantCode: string; pictureUrl: string | null }> };
    }).gamification.ranking.find((entry) => entry.participantCode === 'p3');
    expect(picturedEntry?.pictureUrl).toContain('/participants/p3/');

    expect((await request(`/superuser/gamifications/${gamification.publicId}/ranking/p3/picture`, cookie, { method: 'DELETE' })).status).toBe(200);

    const deactivated = await request(`/superuser/gamifications/${gamification.publicId}/deactivate`, cookie, { method: 'POST' });
    const deactivatedBody = (await deactivated.json()) as { gamification: { status: string; outcome: string; actualEndAt: string } };
    expect(deactivatedBody.gamification).toMatchObject({ status: 'inactive', outcome: 'achieved', actualEndAt: expect.any(String) });
    expect((await request(`/superuser/gamifications/${gamification.publicId}/deactivate`, cookie, { method: 'POST' })).status).toBe(409);

    const editable = await request(`/superuser/gamifications/${gamification.publicId}/ranking/p1`, cookie, {
      method: 'PUT',
      json: { fullName: 'Ana', score: '60.00' },
    });
    expect(editable.status).toBe(200);
  });

  it('shares participant profiles across rankings of the same company', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const first = await createGamification(cookie, demoCompanyId, 'Shared profile one');
    const second = await createGamification(cookie, demoCompanyId, 'Shared profile two');

    expect((await request(`/superuser/gamifications/${first.publicId}/ranking/ana-001`, cookie, {
      method: 'PUT', json: { fullName: 'Ana', score: '10.00' },
    })).status).toBe(200);
    expect((await request(`/superuser/gamifications/${second.publicId}/ranking/ana-001`, cookie, {
      method: 'PUT', json: { fullName: 'Ana GarcÃ­a', score: '20.00' },
    })).status).toBe(200);

    const participants = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM participants
       WHERE company_id = (SELECT id FROM companies WHERE public_id = ?) AND participant_code = ?`,
    ).bind(demoCompanyId, 'ana-001').first<{ count: number }>();
    expect(participants?.count).toBe(1);

    const detail = await request(`/companies/${demoCompanyId}/gamifications/${first.publicId}`, cookie);
    expect(((await detail.json()) as { gamification: { ranking: Array<{ fullName: string; score: string }> } }).gamification.ranking)
      .toContainEqual(expect.objectContaining({ fullName: 'Ana GarcÃ­a', score: '10.00' }));

    expect((await request(`/superuser/gamifications/${first.publicId}/ranking/ana-002`, cookie, {
      method: 'PUT', json: { fullName: 'Ana GarcÃ­a', score: '15.00', previousParticipantCode: 'ana-001' },
    })).status).toBe(200);
    const renamed = await request(`/companies/${demoCompanyId}/gamifications/${second.publicId}`, cookie);
    expect(((await renamed.json()) as { gamification: { ranking: Array<{ participantCode: string }> } }).gamification.ranking)
      .toContainEqual(expect.objectContaining({ participantCode: 'ana-002' }));
  });

  it('requires a new future end date to reactivate an expired gamification', async () => {
    const cookie = await login('OWNER-LOCAL-2026');
    const company = await testEnv.DB.prepare('SELECT id FROM companies WHERE public_id = ?').bind(demoCompanyId).first<{ id: number }>();
    await testEnv.DB.prepare(
      `INSERT INTO gamifications
       (public_id, company_id, description, start_at, end_at, goal_value, value_precision, goal_unit, status)
       VALUES ('reactivation-expired', ?, 'Expired', '2025-01-01', '2025-01-02', 1000, 2, 'sales', 'active')`,
    ).bind(company!.id).run();

    const missingEndDate = await request('/superuser/gamifications/reactivation-expired/activate', cookie, { method: 'POST' });
    expect(missingEndDate.status).toBe(409);

    const reactivated = await request('/superuser/gamifications/reactivation-expired/activate', cookie, {
      method: 'POST',
      json: { endAt: '2027-02-01' },
    });
    expect(((await reactivated.json()) as { gamification: { status: string; endAt: string; actualEndAt: string | null } }).gamification)
      .toMatchObject({ status: 'active', endAt: '2027-02-01', actualEndAt: null });
  });

  it('closes expired active gamifications from scheduled maintenance', async () => {
    const company = await testEnv.DB.prepare('SELECT id FROM companies WHERE public_id = ?').bind(demoCompanyId).first<{ id: number }>();
    await testEnv.DB.prepare(
      `INSERT INTO gamifications
       (public_id, company_id, description, start_at, end_at, goal_value, value_precision, goal_unit, status)
       VALUES ('expired', ?, 'Expired', '2025-01-01', '2025-01-02', 1000, 2, 'sales', 'active')`,
    )
      .bind(company!.id)
      .run();

    await runGamificationMaintenance(testEnv, new Date('2025-01-03T00:00:00.000Z'));
    const row = await testEnv.DB.prepare("SELECT status, outcome, actual_end_at FROM gamifications WHERE public_id = 'expired'").first<{
      status: string;
      outcome: string;
      actual_end_at: string | null;
    }>();
    expect(row).toMatchObject({ status: 'closed', outcome: 'missed', actual_end_at: '2025-01-03T00:00:00.000Z' });
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
      json: { name: 'Trip', rankingPosition: 1, estimatedValue: null },
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
  return ((await response.json()) as { gamification: { publicId: string; title: string; goal: string } }).gamification;
};

const gamificationPayload = (description: string) => ({
  title: 'Reto de prueba',
  description,
  startAt: '2027-01-01',
  endAt: '2027-02-01',
  goal: '125.50',
  valuePrecision: 2,
  goalUnit: 'sales',
  rankingUnit: 'Ludu Points',
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
