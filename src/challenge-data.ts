import type { Context, Hono } from 'hono';
import { calculatePublication, type Entry, type Member, type Projection, type Publication } from './challenge-calculation';
import { emptySettings, parseChallengeSettings, record, type ChallengeSettings } from './challenge-settings';

type Db = Env['DB'];
type AppContext = Context<{ Bindings: Env }>;
type Admin = { ok: true; principal: { user_public_id: string } } | { ok: false; response: Response };
export type Challenge = { id: number; public_id: string; company_id: number; start_at: string; end_at: string; value_precision: number; tv_enabled: number };
type StoredSettings = { settings_json: string; revision: string };

export const getChallengeSettings = (db: Db, challengeId: number): Promise<StoredSettings | null> =>
  db.prepare('SELECT settings_json, revision FROM challenge_settings WHERE gamification_id = ?').bind(challengeId).first<StoredSettings>();

async function listMembers(db: Db, challengeId: number): Promise<Member[]> {
  const { results } = await db.prepare(`SELECT p.id, p.participant_code AS code, p.full_name AS fullName, m.zone, m.active
    FROM challenge_members m JOIN participants p ON p.id = m.participant_id
    WHERE m.gamification_id = ? ORDER BY p.full_name`)
    .bind(challengeId).all<Omit<Member, 'active'> & { active: number }>();
  return results.map((item: Omit<Member, 'active'> & { active: number }) => ({ ...item, active: item.active === 1 }));
}

async function publications(db: Db, challengeId: number) {
  type UpdateRow = { id: number; public_id: string; data_date: string | null; projection_json: string | null; value_precision: number };
  const { results: updates } = await db.prepare(`SELECT id, public_id, data_date, projection_json, value_precision
    FROM data_updates WHERE gamification_id = ? AND status = 'published' ORDER BY id DESC`)
    .bind(challengeId).all<UpdateRow>();
  const { results: rows } = await db.prepare(`SELECT r.update_id, r.participant_id, r.score_value, r.position, r.calculation_json
    FROM participant_results r JOIN data_updates u ON u.id = r.update_id
    WHERE u.gamification_id = ? AND u.status = 'published' AND (r.calculation_json IS NOT NULL OR u.id = ?)`)
    .bind(challengeId, updates[0]?.id ?? 0).all<{ update_id: number; participant_id: number; score_value: number; position: number; calculation_json: string | null }>();
  const past = new Map<number, Publication>(updates.map((row: UpdateRow) => [row.id, {
    date: row.data_date ?? '', entries: new Map(), projection: row.projection_json ? JSON.parse(row.projection_json) as Projection : null,
  }]));
  const previousScale = 10 ** (updates[0]?.value_precision ?? 0);
  for (const row of rows) {
    const publication = past.get(row.update_id);
    if (!publication) continue;
    const legacyScore = row.score_value / previousScale;
    const entry = row.calculation_json ? JSON.parse(row.calculation_json) as Entry : {
      id: row.participant_id, code: '', fullName: '', zone: '', active: true, metrics: {}, period: {}, breakdown: [],
      score: legacyScore, baseScore: legacyScore, position: row.position, positionChange: null, scoreChange: null,
      weekPoints: 0, distance: null, streak: 0, streakPoints: 0, badges: [], missionAwards: [], eligible: true, minimumsMissing: [],
    };
    publication.entries.set(row.participant_id, entry);
  }
  return { latestId: (updates[0]?.public_id ?? '') as string, history: [...past.values()].filter((row, index) => index === 0 || row.date) };
}

const hexDigest = async (value: string | ArrayBuffer): Promise<string> => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value),
), (byte) => byte.toString(16).padStart(2, '0')).join('');
const maxWorkbookBytes = 4 * 1024 * 1024;
const workbookPartBytes = 128 * 1024;
const xlsxMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function registerChallengeDataRoutes(app: Hono<{ Bindings: Env }>, requireAdmin: (context: AppContext) => Promise<Admin>,
  findChallenge: (db: Db, publicId: string) => Promise<Challenge | null>): void {
  const prefix = '/superuser/gamifications/:gamificationPublicId';

  async function adminChallenge(c: AppContext) {
    const auth = await requireAdmin(c);
    if (!auth.ok) return auth;
    const challenge = await findChallenge(c.env.DB, c.req.param('gamificationPublicId') ?? '');
    if (!challenge) return { ok: false as const, response: c.json({ error: 'Reto no encontrado.' }, 404) };
    return { ok: true as const, challenge, administrator: auth.principal.user_public_id };
  }

  app.get(`${prefix}/challenge-settings`, async (c) => {
    const access = await adminChallenge(c);
    if (!access.ok) return access.response;
    const stored = await getChallengeSettings(c.env.DB, access.challenge.id);
    return c.json({ settings: stored ? JSON.parse(stored.settings_json) as ChallengeSettings : emptySettings });
  });

  app.put(`${prefix}/challenge-settings`, async (c) => {
    const access = await adminChallenge(c);
    if (!access.ok) return access.response;
    let settings: ChallengeSettings;
    try {
      settings = parseChallengeSettings(await c.req.json());
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Configuración no válida.' }, 400);
    }
    if (settings.missions.some(({ start, end }) => start < access.challenge.start_at || end > access.challenge.end_at)) {
      return c.json({ error: 'Las misiones deben comenzar y terminar dentro del reto.' }, 400);
    }
    if (settings.duels.some(({ start, end }) => start < access.challenge.start_at || end > access.challenge.end_at)) {
      return c.json({ error: 'Los enfrentamientos deben celebrarse dentro del reto.' }, 400);
    }
    if (settings.duels.length) {
      const roster = new Set((await listMembers(c.env.DB, access.challenge.id)).map(({ code }) => code));
      if (settings.duels.some(({ left, right }) => [...left, ...right].some((code) => !roster.has(code)))) {
        return c.json({ error: 'Cada participante de un enfrentamiento tiene que pertenecer al reto.' }, 400);
      }
    }
    await c.env.DB.prepare(`INSERT INTO challenge_settings (gamification_id, settings_json, revision) VALUES (?, ?, ?)
      ON CONFLICT(gamification_id) DO UPDATE SET settings_json = excluded.settings_json, revision = excluded.revision`)
      .bind(access.challenge.id, JSON.stringify(settings), crypto.randomUUID()).run();
    return c.json({ settings });
  });

  app.get(`${prefix}/challenge-members`, async (c) => {
    const access = await adminChallenge(c);
    if (!access.ok) return access.response;
    return c.json({ members: await listMembers(c.env.DB, access.challenge.id) });
  });

  app.put(`${prefix}/challenge-members/:code`, async (c) => {
    const access = await adminChallenge(c);
    if (!access.ok) return access.response;
    const body = record(await c.req.json().catch(() => null));
    const code = c.req.param('code').trim();
    const fullName = body?.['fullName'];
    const zone = body?.['zone'];
    const active = body?.['active'];
    if (!code || code.length > 128 || typeof fullName !== 'string' || !fullName.trim() || fullName.length > 160 ||
        typeof zone !== 'string' || zone.length > 80 || typeof active !== 'boolean') {
      return c.json({ error: 'Revisa el código, el nombre y la zona.' }, 400);
    }
    const { id, company_id: companyId } = access.challenge;
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO participants (company_id, participant_code, full_name) VALUES (?, ?, ?)
        ON CONFLICT(company_id, participant_code) DO UPDATE SET full_name = excluded.full_name`).bind(companyId, code, fullName.trim()),
      c.env.DB.prepare(`INSERT INTO challenge_members (gamification_id, participant_id, zone, active)
        SELECT ?, id, ?, ? FROM participants WHERE company_id = ? AND participant_code = ?
        ON CONFLICT(gamification_id, participant_id) DO UPDATE SET zone = excluded.zone, active = excluded.active`)
        .bind(id, zone.trim(), Number(active), companyId, code),
      c.env.DB.prepare('UPDATE challenge_settings SET revision = ? WHERE gamification_id = ?').bind(crypto.randomUUID(), id),
    ]);
    return c.json({ members: await listMembers(c.env.DB, id) });
  });

  app.post(`${prefix}/master-preview`, async (c) => execute(c, false));
  app.post(`${prefix}/master-publications`, async (c) => execute(c, true));

  app.get(`${prefix}/ranking-publications/:publicationId/workbook`, async (c) => {
    const access = await adminChallenge(c);
    if (!access.ok) return access.response;
    const release = await c.env.DB.prepare('SELECT id, source_name FROM data_updates WHERE gamification_id = ? AND public_id = ?')
      .bind(access.challenge.id, c.req.param('publicationId')).first<{ id: number; source_name: string }>();
    if (!release) return c.json({ error: 'No hay archivo para esta publicación.' }, 404);
    const { results } = await c.env.DB.prepare('SELECT content FROM master_workbook_parts WHERE update_id = ? ORDER BY part_index')
      .bind(release.id).all<{ content: number[] }>();
    if (!results.length) return c.json({ error: 'No hay archivo para esta publicación.' }, 404);
    const filename = encodeURIComponent(release.source_name.replace(/[\r\n]/g, '')).replace(/[!'()*]/g, (symbol) => `%${symbol.charCodeAt(0).toString(16)}`);
    return new Response(new Blob(results.map(({ content }: { content: number[] }) => Uint8Array.from(content))), {
      headers: { 'Content-Type': xlsxMimeType, 'Content-Disposition': `attachment; filename*=UTF-8''${filename}`, 'Cache-Control': 'no-store' },
    });
  });

  app.post(`${prefix}/tv-link`, async (c) => {
    const access = await adminChallenge(c);
    if (!access.ok) return access.response;
    if (access.challenge.tv_enabled !== 1) return c.json({ error: 'Activa el modo TV antes de generar su enlace.' }, 409);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    await c.env.DB.prepare(`INSERT INTO challenge_tv_access (gamification_id, token_hash, created_at) VALUES (?, ?, ?)
      ON CONFLICT(gamification_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`)
      .bind(access.challenge.id, await hexDigest(token), new Date().toISOString()).run();
    c.header('Cache-Control', 'no-store');
    return c.json({ token }, 201);
  });

  app.delete(`${prefix}/tv-link`, async (c) => {
    const access = await adminChallenge(c);
    if (!access.ok) return access.response;
    await c.env.DB.prepare('DELETE FROM challenge_tv_access WHERE gamification_id = ?').bind(access.challenge.id).run();
    return c.json({ ok: true });
  });

  app.post('/tv/read', async (c) => {
    c.header('Cache-Control', 'no-store');
    const token = record(await c.req.json().catch(() => null))?.['token'];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return c.json({ error: 'Pantalla no disponible.' }, 404);

    const db = c.env.DB;
    const challenge = await db.prepare(`SELECT g.id, g.title, g.value_precision, g.ranking_unit, g.goal_value, g.goal_unit,
      s.settings_json FROM challenge_tv_access a JOIN gamifications g ON g.id = a.gamification_id
      LEFT JOIN challenge_settings s ON s.gamification_id = g.id
      WHERE a.token_hash = ? AND g.tv_enabled = 1 AND g.status = 'active' AND g.end_at >= date('now')`)
      .bind(await hexDigest(token)).first<{ id: number; title: string; value_precision: number; ranking_unit: string;
        goal_value: number | null; goal_unit: string | null; settings_json: string | null }>();
    if (!challenge) return c.json({ error: 'Pantalla no disponible.' }, 404);
    const settings = challenge.settings_json ? JSON.parse(challenge.settings_json) as ChallengeSettings : emptySettings;
    type TvEntry = { participant_code: string; full_name: string; position: number; score_value: number };
    const [ranking, latest] = await Promise.all([
      db.prepare(`SELECT p.participant_code, p.full_name, r.score_value, RANK() OVER (ORDER BY r.score_value DESC) AS position
        FROM rankings r JOIN participants p ON p.id = r.participant_id
        LEFT JOIN challenge_members m ON m.gamification_id = r.gamification_id AND m.participant_id = p.id
        WHERE r.gamification_id = ? AND COALESCE(m.active, 1) = 1
        ORDER BY r.score_value DESC, p.full_name LIMIT ?`).bind(challenge.id, settings.tvLimit ?? 10).all<TvEntry>(),
      db.prepare(`SELECT u.published_at, u.projection_json,
        (SELECT COALESCE(SUM(score_value), 0) FROM rankings WHERE gamification_id = u.gamification_id) AS ranking_total
        FROM data_updates u WHERE u.gamification_id = ? AND u.status = 'published' ORDER BY u.id DESC LIMIT 1`)
        .bind(challenge.id).first<{ published_at: string; projection_json: string | null; ranking_total: number }>(),
    ]);
    const scale = 10 ** challenge.value_precision;
    const projection = latest?.projection_json ? JSON.parse(latest.projection_json) as Projection : null;
    const entries = ranking.results.map((entry: TvEntry) => ({ position: entry.position, score: entry.score_value / scale,
      name: settings.anonymousFrom !== null && entry.position >= settings.anonymousFrom ? `Participante ${entry.position}` : entry.full_name }));
    return c.json({ title: challenge.title, rankingUnit: challenge.ranking_unit, valuePrecision: challenge.value_precision,
      updatedAt: latest?.published_at ?? null, seconds: settings.tvInterval ?? 9, ranking: entries,
      goal: challenge.goal_value === null ? null : challenge.goal_value / scale, goalUnit: challenge.goal_unit,
      goalTotal: projection?.goalTotal ?? (latest?.ranking_total ?? 0) / scale,
      teams: projection?.teams.map(({ name, average }) => ({ name, average })) ?? [],
      news: projection?.news.flatMap((item) => {
        const index = ranking.results.findIndex((entry: TvEntry) => entry.participant_code === item.code);
        const published = ranking.results[index] as TvEntry | undefined;
        const visible = entries[index];
        return item.code ? published && visible && item.text.startsWith(published.full_name)
          ? [visible.name + item.text.slice(published.full_name.length)] : [] : [item.text];
      }).slice(0, 4) ?? [],
    });
  });

  async function execute(c: AppContext, publish: boolean): Promise<Response> {
    const access = await adminChallenge(c);
    if (!access.ok) return access.response;
    const isMultipart = c.req.header('Content-Type')?.startsWith('multipart/form-data');
    const form = isMultipart ? await c.req.formData().catch(() => null) : null;
    const payload = form?.get('payload');
    let body: Record<string, unknown> | null;
    try {
      body = record(typeof payload === 'string' ? JSON.parse(payload) : await c.req.json());
    } catch {
      return c.json({ error: 'Solicitud no válida.' }, 400);
    }
    if (!body) return c.json({ error: 'Solicitud no válida.' }, 400);
    const challenge = access.challenge;
    const db = c.env.DB;
    const token = body['previewToken'];
    if (publish && typeof token === 'string') {
      const prior = await db.prepare(`SELECT public_id FROM data_updates WHERE gamification_id = ? AND preview_token = ? AND status = 'published'`)
        .bind(challenge.id, token).first<{ public_id: string }>();
      if (prior) return c.json({ publicId: prior.public_id }, 200);
    }
    const stored = await getChallengeSettings(db, challenge.id);
    if (!stored) return c.json({ error: 'Configura las reglas de puntos del reto antes de importar.' }, 409);
    const settings = JSON.parse(stored.settings_json) as ChallengeSettings;
    const [members, past] = await Promise.all([listMembers(db, challenge.id), publications(db, challenge.id)]);
    const bounds = { start: challenge.start_at, end: challenge.end_at, precision: challenge.value_precision, today: new Date().toISOString().slice(0, 10) };
    const result = calculatePublication(body['input'], settings, members, past.history, bounds);
    if (!result.ok) return c.json({ errors: result.errors, warnings: result.warnings }, 422);
    const proof = await hexDigest(JSON.stringify([challenge.public_id, stored.revision, past.latestId, bounds, result.input]));
    if (!publish) return c.json({ previewToken: proof, ...result, input: undefined });
    if (token !== proof) return c.json({ error: 'El reto cambió desde la vista previa. Vuelve a validar el archivo.' }, 409);
    const workbook = form?.get('workbook');
    let contents: ArrayBuffer | null = null;
    if (result.input.sourceHash || workbook) {
      if (!(workbook instanceof File) || !workbook.name.toLowerCase().endsWith('.xlsx') || workbook.size > maxWorkbookBytes || workbook.size < 4) {
        return c.json({ error: 'Adjunta el Excel original validado de hasta 4 MB.' }, 400);
      }
      contents = await workbook.arrayBuffer();
      const magic = new Uint8Array(contents, 0, 4);
      if (magic[0] !== 0x50 || magic[1] !== 0x4b || magic[2] !== 3 || magic[3] !== 4 || await hexDigest(contents) !== result.input.sourceHash) {
        return c.json({ error: 'El archivo adjunto no coincide con el Excel validado.' }, 400);
      }
    }

    const publicId = crypto.randomUUID();
    const scale = 10 ** challenge.value_precision;
    const fieldHeaders = JSON.stringify(['Zona', ...settings.metrics.map(({ label }) => label)]);
    const statements = [db.prepare(`INSERT INTO data_updates (public_id, gamification_id, published_at, value_precision,
      field_headers_json, data_date, import_mode, source_name, author_public_id, projection_json, preview_token)
      SELECT ?, g.id, ?, g.value_precision, ?, ?, ?, ?, ?, ?, ? FROM gamifications g
      JOIN challenge_settings settings ON settings.gamification_id = g.id
      WHERE g.id = ? AND g.value_precision = ? AND g.start_at = ? AND g.end_at = ? AND settings.revision = ?
        AND COALESCE((SELECT public_id FROM data_updates WHERE gamification_id = g.id AND status = 'published' ORDER BY id DESC LIMIT 1), '') = ?`)
      .bind(publicId, new Date().toISOString(), fieldHeaders, result.projection.dataDate, result.input.mode, result.input.sourceName,
        access.administrator, JSON.stringify(result.projection), proof, challenge.id, bounds.precision, bounds.start, bounds.end, stored.revision, past.latestId)];

    for (let offset = 0; offset < result.entries.length; offset += 100) {
      const batch = result.entries.slice(offset, offset + 100).map((entry, index) => [entry.id, Math.round(entry.score * scale), entry.position,
        { Zona: entry.zone, ...Object.fromEntries(settings.metrics.flatMap(({ key, label }) => entry.metrics[key] === undefined ? [] : [[label, String(entry.metrics[key])]])) },
        entry, offset + index]);
      statements.push(db.prepare(`INSERT INTO participant_results (update_id, participant_id, score_value, position, custom_fields_json, calculation_json, sort_order)
        SELECT u.id, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
          json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]')
        FROM data_updates u CROSS JOIN json_each(?) j WHERE u.public_id = ?`).bind(JSON.stringify(batch), publicId));
    }
    if (contents) {
      for (let offset = 0; offset < contents.byteLength; offset += workbookPartBytes) {
        statements.push(db.prepare(`INSERT INTO master_workbook_parts (update_id, part_index, content)
          SELECT id, ?, ? FROM data_updates WHERE public_id = ?`)
          .bind(offset / workbookPartBytes, contents.slice(offset, offset + workbookPartBytes), publicId));
      }
    }
    statements.push(
      db.prepare(`DELETE FROM rankings WHERE gamification_id = ? AND EXISTS (SELECT 1 FROM data_updates WHERE public_id = ?)`)
        .bind(challenge.id, publicId),
      db.prepare(`INSERT INTO rankings (gamification_id, participant_id, score_value, custom_fields_json)
        SELECT u.gamification_id, r.participant_id, r.score_value, r.custom_fields_json FROM data_updates u
        JOIN participant_results r ON r.update_id = u.id WHERE u.public_id = ?`).bind(publicId),
      db.prepare(`UPDATE gamifications SET ranking_field_headers_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND EXISTS (SELECT 1 FROM data_updates WHERE public_id = ?)`)
        .bind(fieldHeaders, challenge.id, publicId),
    );
    const [inserted] = await db.batch(statements);
    if (inserted?.meta.changes !== 1) return c.json({ error: 'El reto cambió desde la vista previa. Vuelve a validar el archivo.' }, 409);
    return c.json({ publicId }, 201);
  }
}
