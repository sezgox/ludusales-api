import type { Context, Hono } from 'hono';
import sanitizeHtml from 'sanitize-html';

export type GamificationPrincipal =
  | { role: 'company'; user_public_id: string; company: { public_id: string; name: string } }
  | { role: 'superuser'; user_public_id: string; companies: Array<{ public_id: string; name: string }> };

type AuthResult = { ok: true; principal: GamificationPrincipal } | { ok: false; response: Response };
type AppContext = Context<{ Bindings: Env }>;
type ReadAuthenticatedPrincipal = (context: AppContext) => Promise<AuthResult>;
type CanAccessCompany = (principal: GamificationPrincipal, companyPublicId: string) => boolean;
type D1Database = Env['DB'];
type D1PreparedStatement = ReturnType<D1Database['prepare']>;
type D1Result = Awaited<ReturnType<D1PreparedStatement['run']>>;

type CompanyRow = { id: number; public_id: string; name: string };
type GamificationRow = {
  id: number;
  public_id: string;
  company_id: number;
  company_public_id: string;
  title: string;
  description: string;
  image_key: string | null;
  start_at: string;
  end_at: string;
  goal_value: number | null;
  value_precision: number;
  goal_unit: string | null;
  max_live_ranking: number;
  ranking_field_headers_json: string;
  status: 'draft' | 'active' | 'closed';
  outcome: 'pending' | 'achieved' | 'missed' | 'not_applicable';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  actual_end_at: string | null;
};

type PrizeRow = {
  id: number;
  public_id: string;
  gamification_id: number;
  name: string;
  picture_key: string | null;
  sort_order: number;
  ranking_position: number;
  estimated_value_cents: number | null;
  created_at: string;
  updated_at: string;
};

type RankingRow = {
  participant_code: string;
  full_name: string;
  picture_key: string | null;
  score_value: number;
  custom_fields_json: string;
  position: number;
  created_at: string;
  updated_at: string;
};

type ParticipantRow = {
  id: number;
  company_id: number;
  participant_code: string;
  full_name: string;
  picture_key: string | null;
  created_at: string;
  updated_at: string;
};

type GamificationRuleRow = {
  position: number;
  title: string;
  description: string;
  icon_name: string;
};

type GamificationRuleInput = {
  position: number;
  title: string;
  description: string;
  iconName: string;
};

type GamificationInput = {
  title: string;
  description: string;
  startAt: string;
  endAt: string;
  goalValue: number | null;
  valuePrecision: number;
  goalUnit: string | null;
  maxLiveRanking: number;
  rules?: GamificationRuleInput[];
};

type RankingInput = {
  participantCode: string;
  fullName: string;
  scoreValue: number;
  customFields: Record<string, string>;
};

const maxImageBytes = 2 * 1024 * 1024;
const maxImageDimension = 2400;
const maxRankingEntries = 1000;
const maxRankingFieldHeaders = 30;
const maxRankingFieldHeaderLength = 80;
const maxRankingFieldValueLength = 500;
const minLiveRankingEntries = 3;
const maxScaledValue = 9_000_000_000_000;
const maxTitleLength = 160;
const maxDescriptionLength = 20_000;
const maxRuleDescriptionLength = 2_000;
const allowedDescriptionTags = ['p', 'h2', 'h3', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'br', 'a'];
const immutableImageCacheControl = 'public, max-age=31536000, immutable';

export const registerGamificationRoutes = (
  app: Hono<{ Bindings: Env }>,
  readAuthenticatedPrincipal: ReadAuthenticatedPrincipal,
  canAccessCompany: CanAccessCompany,
): void => {
  app.get('/media/*', async (c) => {
    const encodedKey = c.req.path.slice('/media/'.length);
    if (!encodedKey) return c.notFound();

    let key: string;
    try {
      key = encodedKey.split('/').map(decodeURIComponent).join('/');
    } catch {
      return c.notFound();
    }

    const object = await c.env.MEDIA_BUCKET.get(key);
    if (!object) return c.notFound();

    return new Response(object.body, {
      headers: {
        'Cache-Control': object.httpMetadata?.cacheControl ?? immutableImageCacheControl,
        'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      },
    });
  });

  app.get('/companies/:companyPublicId/gamifications', async (c) => {
    const auth = await readAuthenticatedPrincipal(c);
    if (!auth.ok) return auth.response;

    const company = await findCompany(c.env.DB, c.req.param('companyPublicId'));
    if (!company) return c.json({ error: 'Company not found.' }, 404);
    if (!canAccessCompany(auth.principal, company.public_id)) return c.json({ error: 'Forbidden.' }, 403);

    await deactivateExpiredGamifications(c.env.DB, new Date().toISOString());

    const result = await c.env.DB.prepare(
      `${gamificationSelect} WHERE g.company_id = ? ORDER BY g.start_at DESC, g.id DESC`,
    )
      .bind(company.id)
      .all<GamificationRow>();

    return c.json({
      ok: true,
      gamifications: result.results.map((row: GamificationRow) => serializeGamification(row, c.env, c.req.url)),
    });
  });

  app.get('/companies/:companyPublicId/gamifications/:gamificationPublicId', async (c) => {
    const auth = await readAuthenticatedPrincipal(c);
    if (!auth.ok) return auth.response;

    const company = await findCompany(c.env.DB, c.req.param('companyPublicId'));
    if (!company) return c.json({ error: 'Company not found.' }, 404);
    if (!canAccessCompany(auth.principal, company.public_id)) return c.json({ error: 'Forbidden.' }, 403);

    await deactivateExpiredGamifications(c.env.DB, new Date().toISOString());
    const gamification = await findGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification || gamification.company_id !== company.id) {
      return c.json({ error: 'Gamification not found.' }, 404);
    }

    const [prizeResult, rankingResult, ruleResult] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, public_id, gamification_id, name, picture_key, sort_order, ranking_position, estimated_value_cents,
                created_at, updated_at
         FROM prizes WHERE gamification_id = ? ORDER BY ranking_position ASC, id ASC`,
      )
        .bind(gamification.id)
        .all<PrizeRow>(),
      c.env.DB.prepare(
        `SELECT p.participant_code, p.full_name, p.picture_key, r.score_value, r.custom_fields_json, r.created_at, r.updated_at,
                RANK() OVER (ORDER BY score_value DESC) AS position
         FROM rankings r
         INNER JOIN participants p ON p.id = r.participant_id
         WHERE r.gamification_id = ?
         ORDER BY r.score_value DESC, p.full_name ASC, p.participant_code ASC`,
      )
        .bind(gamification.id)
        .all<RankingRow>(),
      c.env.DB.prepare(
        `SELECT position, title, description, icon_name
         FROM gamification_rules WHERE gamification_id = ? ORDER BY position ASC`,
      )
        .bind(gamification.id)
        .all<GamificationRuleRow>(),
    ]);

    return c.json({
      ok: true,
      gamification: {
        ...serializeGamification(gamification, c.env, c.req.url),
        prizes: prizeResult.results.map((row: PrizeRow) => serializePrize(row, c.env, c.req.url)),
        ranking: rankingResult.results.map((row: RankingRow) => serializeRanking(row, gamification.value_precision, c.env, c.req.url)),
        rules: ruleResult.results.map(serializeGamificationRule),
      },
    });
  });

  app.post('/superuser/companies/:companyPublicId/gamifications', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;

    const company = await findCompany(c.env.DB, c.req.param('companyPublicId'));
    if (!company) return c.json({ error: 'Company not found.' }, 404);

    const body = await readJson(c.req.raw);
    const parsed = parseGamificationInput(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const publicId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO gamifications
       (public_id, company_id, title, description, start_at, end_at, goal_value, value_precision, goal_unit, max_live_ranking)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        publicId,
        company.id,
        parsed.value.title,
        parsed.value.description,
        parsed.value.startAt,
        parsed.value.endAt,
        parsed.value.goalValue,
        parsed.value.valuePrecision,
        parsed.value.goalUnit,
        parsed.value.maxLiveRanking,
      )
      .run();

    const gamification = await findGamification(c.env.DB, publicId);
    if (parsed.value.rules?.length) {
      await c.env.DB.batch(ruleInsertStatements(c.env.DB, gamification!.id, parsed.value.rules));
    }
    return c.json({ ok: true, gamification: serializeGamification(gamification!, c.env, c.req.url) }, 201);
  });

  app.patch('/superuser/gamifications/:gamificationPublicId', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;

    const gamification = await findGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);
    const body = await readJson(c.req.raw);
    if (!isRecord(body)) return c.json({ error: 'Invalid gamification payload.' }, 400);

    const requestedPrecision = body['valuePrecision'];
    if (
      requestedPrecision !== undefined &&
      requestedPrecision !== gamification.value_precision &&
      (await rankingCount(c.env.DB, gamification.id)) > 0
    ) {
      return c.json({ error: 'Value precision cannot change after ranking entries exist.' }, 409);
    }

    const parsed = parseGamificationInput(body, gamification);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const outcome = gamification.status === 'closed'
      ? await outcomeForGoal(c.env.DB, gamification.id, parsed.value.goalValue)
      : gamification.outcome;

    const statements = [
      c.env.DB.prepare(
        `UPDATE gamifications
         SET title = ?, description = ?, start_at = ?, end_at = ?, goal_value = ?, value_precision = ?, goal_unit = ?, max_live_ranking = ?,
             outcome = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
        .bind(
          parsed.value.title,
          parsed.value.description,
          parsed.value.startAt,
          parsed.value.endAt,
          parsed.value.goalValue,
          parsed.value.valuePrecision,
          parsed.value.goalUnit,
          parsed.value.maxLiveRanking,
          outcome,
          gamification.id,
        ),
    ];
    if (parsed.value.rules !== undefined) {
      statements.push(
        c.env.DB.prepare('DELETE FROM gamification_rules WHERE gamification_id = ?').bind(gamification.id),
        ...ruleInsertStatements(c.env.DB, gamification.id, parsed.value.rules),
      );
    }
    await c.env.DB.batch(statements);

    const updated = await findGamification(c.env.DB, gamification.public_id);
    return c.json({ ok: true, gamification: serializeGamification(updated!, c.env, c.req.url) });
  });

  app.post('/superuser/gamifications/:gamificationPublicId/activate', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;

    let gamification = await findGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);
    const now = new Date().toISOString();
    if (gamification.status === 'active' && gamification.end_at <= now) {
      await deactivateGamification(c.env.DB, gamification.id, now);
      gamification = await findGamification(c.env.DB, gamification.public_id);
    }
    if (gamification!.status === 'active') return c.json({ error: 'Gamification is already active.' }, 409);

    const body = await readJson(c.req.raw);
    const requestedEndAt = isRecord(body) && body['endAt'] !== undefined
      ? readIsoDate(body['endAt'])
      : gamification!.end_at;
    if (!requestedEndAt || requestedEndAt <= gamification!.start_at || requestedEndAt <= now) {
      return c.json({ error: 'A new end date after the current time is required to activate this gamification.' }, 409);
    }

    await c.env.DB.prepare(
      `UPDATE gamifications
       SET status = 'active', outcome = 'pending', closed_at = NULL, actual_end_at = NULL, end_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(requestedEndAt, gamification!.id)
      .run();
    const updated = await findGamification(c.env.DB, gamification!.public_id);
    return c.json({ ok: true, gamification: serializeGamification(updated!, c.env, c.req.url) });
  });

  app.post('/superuser/gamifications/:gamificationPublicId/deactivate', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;

    const gamification = await findGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);
    if (gamification.status !== 'active') return c.json({ error: 'Only active gamifications can be deactivated.' }, 409);

    await deactivateGamification(c.env.DB, gamification.id, new Date().toISOString());
    const updated = await findGamification(c.env.DB, gamification.public_id);
    return c.json({ ok: true, gamification: serializeGamification(updated!, c.env, c.req.url) });
  });

  app.delete('/superuser/gamifications/:gamificationPublicId', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;

    const gamification = await findGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);

    const pictures = await c.env.DB.prepare(
      `SELECT picture_key FROM prizes WHERE gamification_id = ? AND picture_key IS NOT NULL`,
    )
      .bind(gamification.id)
      .all<{ picture_key: string }>();
    const keys = [gamification.image_key, ...pictures.results.map((row: { picture_key: string }) => row.picture_key)].filter(
      (key): key is string => Boolean(key),
    );
    await c.env.DB.batch([...keys.map((key) => enqueueMediaStatement(c.env.DB, key)), c.env.DB.prepare('DELETE FROM gamifications WHERE id = ?').bind(gamification.id)]);

    return c.json({ ok: true });
  });

  app.post('/superuser/gamifications/:gamificationPublicId/prizes', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const gamification = await requireWritableGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);
    const body = await readJson(c.req.raw);
    const parsed = parsePrizeInput(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const sortOrder =
      parsed.value.sortOrder ??
      ((await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM prizes WHERE gamification_id = ?')
        .bind(gamification.id)
        .first<{ next_order: number }>())?.next_order ?? 0);
    const publicId = crypto.randomUUID();

    const rankingPosition = parsed.value.rankingPosition;
    const existingPosition = await c.env.DB.prepare(
      'SELECT id FROM prizes WHERE gamification_id = ? AND ranking_position = ? LIMIT 1',
    )
      .bind(gamification.id, rankingPosition)
      .first<{ id: number }>();
    if (existingPosition) return c.json({ error: 'A prize already exists for this ranking position.' }, 409);

    await c.env.DB.prepare(
      `INSERT INTO prizes (public_id, gamification_id, name, sort_order, ranking_position, estimated_value_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(publicId, gamification.id, parsed.value.name, sortOrder, rankingPosition, parsed.value.estimatedValueCents)
      .run();
    const prize = await findPrize(c.env.DB, publicId);
    return c.json({ ok: true, prize: serializePrize(prize!, c.env, c.req.url) }, 201);
  });

  app.patch('/superuser/prizes/:prizePublicId', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const prize = await findPrize(c.env.DB, c.req.param('prizePublicId'));
    if (!prize) return c.json({ error: 'Prize not found.' }, 404);
    const body = await readJson(c.req.raw);
    const parsed = parsePrizeInput(body, prize);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const duplicatePosition = await c.env.DB.prepare(
      'SELECT id FROM prizes WHERE gamification_id = ? AND ranking_position = ? AND id != ? LIMIT 1',
    )
      .bind(prize.gamification_id, parsed.value.rankingPosition, prize.id)
      .first<{ id: number }>();
    if (duplicatePosition) return c.json({ error: 'A prize already exists for this ranking position.' }, 409);
    await c.env.DB.prepare(
      `UPDATE prizes
       SET name = ?, sort_order = ?, ranking_position = ?, estimated_value_cents = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(parsed.value.name, parsed.value.sortOrder, parsed.value.rankingPosition, parsed.value.estimatedValueCents, prize.id)
      .run();
    const updated = await findPrize(c.env.DB, prize.public_id);
    return c.json({ ok: true, prize: serializePrize(updated!, c.env, c.req.url) });
  });

  app.delete('/superuser/prizes/:prizePublicId', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const prize = await findPrize(c.env.DB, c.req.param('prizePublicId'));
    if (!prize) return c.json({ error: 'Prize not found.' }, 404);
    const statements = [c.env.DB.prepare('DELETE FROM prizes WHERE id = ?').bind(prize.id)];
    if (prize.picture_key) statements.unshift(enqueueMediaStatement(c.env.DB, prize.picture_key));
    await c.env.DB.batch(statements);
    return c.json({ ok: true });
  });

  app.put('/superuser/gamifications/:gamificationPublicId/ranking', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const gamification = await requireWritableGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);
    const body = await readJson(c.req.raw);
    if (!isRecord(body) || !Array.isArray(body['entries']) || body['entries'].length > maxRankingEntries) {
      return c.json({ error: 'Ranking entries must be an array with at most 1000 items.' }, 400);
    }
    const headers = parseRankingFieldHeaders(body['fieldHeaders']);
    if (!headers.ok) return c.json({ error: headers.error }, 400);
    const entries: RankingInput[] = [];
    const participantCodes = new Set<string>();
    for (const item of body['entries']) {
      const parsed = parseRankingInput(item, gamification.value_precision, headers.value);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      if (participantCodes.has(parsed.value.participantCode)) {
        return c.json({ error: 'Ranking contains duplicate participant codes.' }, 400);
      }
      participantCodes.add(parsed.value.participantCode);
      entries.push(parsed.value);
    }

    const statements = [
      c.env.DB.prepare('UPDATE gamifications SET ranking_field_headers_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(JSON.stringify(headers.value), gamification.id),
      c.env.DB.prepare('DELETE FROM rankings WHERE gamification_id = ?').bind(gamification.id),
      ...entries.map((entry) => c.env.DB.prepare(
        `INSERT INTO participants (company_id, participant_code, full_name)
         VALUES (?, ?, ?)
         ON CONFLICT (company_id, participant_code) DO UPDATE SET
           full_name = excluded.full_name, updated_at = CURRENT_TIMESTAMP`,
      ).bind(gamification.company_id, entry.participantCode, entry.fullName)),
      ...entries.map((entry) =>
        c.env.DB.prepare(
          `INSERT INTO rankings (gamification_id, participant_id, score_value, custom_fields_json)
           SELECT ?, id, ?, ? FROM participants WHERE company_id = ? AND participant_code = ?`,
        ).bind(
          gamification.id,
          entry.scoreValue,
          JSON.stringify(entry.customFields),
          gamification.company_id,
          entry.participantCode,
        ),
      ),
    ];
    await c.env.DB.batch(statements);
    return c.json({ ok: true, count: entries.length });
  });

  app.put('/superuser/gamifications/:gamificationPublicId/ranking/:participantCode', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const gamification = await requireWritableGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);
    const body = await readJson(c.req.raw);
    const requestedHeaders = isRecord(body) && body['fieldHeaders'] !== undefined
      ? parseRankingFieldHeaders(body['fieldHeaders'])
      : { ok: true as const, value: parseStoredFieldHeaders(gamification.ranking_field_headers_json) };
    if (!requestedHeaders.ok) return c.json({ error: requestedHeaders.error }, 400);
    const fieldHeaders = mergeRankingFieldHeaders(
      parseStoredFieldHeaders(gamification.ranking_field_headers_json),
      requestedHeaders.value,
    );
    const parsed = parseRankingInput(
      { ...(isRecord(body) ? body : {}), participantCode: c.req.param('participantCode') },
      gamification.value_precision,
      fieldHeaders,
    );
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const previousParticipantCode = isRecord(body) && body['previousParticipantCode'] !== undefined
      ? readOptionalString(body, 'previousParticipantCode', 128)
      : undefined;
    if (previousParticipantCode === null) return c.json({ error: 'Previous participant code is invalid.' }, 400);
    if (previousParticipantCode && previousParticipantCode !== parsed.value.participantCode) {
      const participant = await findParticipant(c.env.DB, gamification.company_id, previousParticipantCode);
      if (!participant) return c.json({ error: 'Ranking participant not found.' }, 404);
      const duplicate = await findParticipant(c.env.DB, gamification.company_id, parsed.value.participantCode);
      if (duplicate) return c.json({ error: 'Participant code already exists for this company.' }, 409);
      const existingRelationship = await c.env.DB.prepare(
        'SELECT id FROM rankings WHERE gamification_id = ? AND participant_id = ? LIMIT 1',
      ).bind(gamification.id, participant.id).first<{ id: number }>();
      if (!existingRelationship) return c.json({ error: 'Ranking participant not found.' }, 404);
      await c.env.DB.batch([
        c.env.DB.prepare(
          'UPDATE participants SET participant_code = ?, full_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ).bind(parsed.value.participantCode, parsed.value.fullName, participant.id),
        c.env.DB.prepare(
          'UPDATE rankings SET score_value = ?, custom_fields_json = ?, updated_at = CURRENT_TIMESTAMP WHERE gamification_id = ? AND participant_id = ?',
        ).bind(parsed.value.scoreValue, JSON.stringify(parsed.value.customFields), gamification.id, participant.id),
        c.env.DB.prepare('UPDATE gamifications SET ranking_field_headers_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(JSON.stringify(fieldHeaders), gamification.id),
      ]);
      return c.json({ ok: true });
    }
    const existingEntry = await c.env.DB.prepare(
      `SELECT r.id FROM rankings r INNER JOIN participants p ON p.id = r.participant_id
       WHERE r.gamification_id = ? AND p.participant_code = ? LIMIT 1`,
    )
      .bind(gamification.id, parsed.value.participantCode)
      .first<{ id: number }>();
    if (!existingEntry && (await rankingCount(c.env.DB, gamification.id)) >= maxRankingEntries) {
      return c.json({ error: 'Ranking cannot contain more than 1000 entries.' }, 409);
    }
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO participants (company_id, participant_code, full_name)
         VALUES (?, ?, ?)
         ON CONFLICT (company_id, participant_code) DO UPDATE SET
           full_name = excluded.full_name, updated_at = CURRENT_TIMESTAMP`,
      ).bind(gamification.company_id, parsed.value.participantCode, parsed.value.fullName),
      c.env.DB.prepare(
        `INSERT INTO rankings (gamification_id, participant_id, score_value, custom_fields_json)
         SELECT ?, id, ?, ? FROM participants WHERE company_id = ? AND participant_code = ?
         ON CONFLICT (gamification_id, participant_id) DO UPDATE SET
           score_value = excluded.score_value, custom_fields_json = excluded.custom_fields_json, updated_at = CURRENT_TIMESTAMP`,
      ).bind(gamification.id, parsed.value.scoreValue, JSON.stringify(parsed.value.customFields), gamification.company_id, parsed.value.participantCode),
      c.env.DB.prepare('UPDATE gamifications SET ranking_field_headers_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(JSON.stringify(fieldHeaders), gamification.id),
    ]);
    return c.json({ ok: true });
  });

  app.delete('/superuser/gamifications/:gamificationPublicId/ranking/:participantCode', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const gamification = await requireWritableGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);
    const participant = await findRankedParticipant(c.env.DB, gamification.id, c.req.param('participantCode'));
    if (!participant) return c.json({ ok: true });
    await c.env.DB.prepare('DELETE FROM rankings WHERE gamification_id = ? AND participant_id = ?')
      .bind(gamification.id, participant.id)
      .run();
    return c.json({ ok: true });
  });

  app.put('/superuser/gamifications/:gamificationPublicId/ranking/:participantCode/picture', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const gamification = await requireWritableGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);
    const participant = await findRankedParticipant(c.env.DB, gamification.id, c.req.param('participantCode'));
    if (!participant) return c.json({ error: 'Ranking participant not found.' }, 404);
    const image = await readWebp(c.req.raw);
    if (!image.ok) return c.json({ error: image.error }, image.status);
    const participantCode = encodeURIComponent(participant.participant_code);
    const key = `companies/${gamification.company_public_id}/participants/${participantCode}/${crypto.randomUUID()}.webp`;
    const stored = await replaceMedia(c.env, key, image.bytes, participant.picture_key, () =>
      c.env.DB.prepare(
        'UPDATE participants SET picture_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ).bind(key, participant.id),
    );
    if (!stored.ok) return c.json({ error: stored.error }, 500);
    return c.json({ ok: true, pictureUrl: assetUrl(c.env, key) });
  });

  app.delete('/superuser/gamifications/:gamificationPublicId/ranking/:participantCode/picture', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const gamification = await requireWritableGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);
    const participant = await findRankedParticipant(c.env.DB, gamification.id, c.req.param('participantCode'));
    if (!participant) return c.json({ error: 'Ranking participant not found.' }, 404);
    if (participant.picture_key) {
      await c.env.DB.batch([
        c.env.DB.prepare(
          'UPDATE participants SET picture_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ).bind(participant.id),
        enqueueMediaStatement(c.env.DB, participant.picture_key),
      ]);
    }
    return c.json({ ok: true });
  });

  app.put('/superuser/gamifications/:gamificationPublicId/image', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const gamification = await requireWritableGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);
    const image = await readWebp(c.req.raw);
    if (!image.ok) return c.json({ error: image.error }, image.status);
    const key = `companies/${gamification.company_public_id}/gamifications/${gamification.public_id}/cover/${crypto.randomUUID()}.webp`;
    const stored = await replaceMedia(c.env, key, image.bytes, gamification.image_key, () =>
      c.env.DB.prepare('UPDATE gamifications SET image_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(
        key,
        gamification.id,
      ),
    );
    if (!stored.ok) return c.json({ error: stored.error }, 500);
    return c.json({ ok: true, imageUrl: assetUrl(c.env, key) });
  });

  app.delete('/superuser/gamifications/:gamificationPublicId/image', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const gamification = await requireWritableGamification(c.env.DB, c.req.param('gamificationPublicId'));
    if (!gamification) return c.json({ error: 'Gamification not found.' }, 404);
    if (gamification.image_key) {
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE gamifications SET image_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(
          gamification.id,
        ),
        enqueueMediaStatement(c.env.DB, gamification.image_key),
      ]);
    }
    return c.json({ ok: true });
  });

  app.put('/superuser/prizes/:prizePublicId/picture', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const prize = await findPrizeWithGamification(c.env.DB, c.req.param('prizePublicId'));
    if (!prize) return c.json({ error: 'Prize not found.' }, 404);
    const image = await readWebp(c.req.raw);
    if (!image.ok) return c.json({ error: image.error }, image.status);
    const key = `companies/${prize.company_public_id}/gamifications/${prize.gamification_public_id}/prizes/${prize.public_id}/${crypto.randomUUID()}.webp`;
    const stored = await replaceMedia(c.env, key, image.bytes, prize.picture_key, () =>
      c.env.DB.prepare('UPDATE prizes SET picture_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(key, prize.id),
    );
    if (!stored.ok) return c.json({ error: stored.error }, 500);
    return c.json({ ok: true, pictureUrl: assetUrl(c.env, key) });
  });

  app.delete('/superuser/prizes/:prizePublicId/picture', async (c) => {
    const auth = await requireSuperuser(c, readAuthenticatedPrincipal);
    if (!auth.ok) return auth.response;
    const prize = await findPrizeWithGamification(c.env.DB, c.req.param('prizePublicId'));
    if (!prize) return c.json({ error: 'Prize not found.' }, 404);
    if (prize.picture_key) {
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE prizes SET picture_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(prize.id),
        enqueueMediaStatement(c.env.DB, prize.picture_key),
      ]);
    }
    return c.json({ ok: true });
  });
};

export const runGamificationMaintenance = async (env: Env, now = new Date()): Promise<void> => {
  const closedAt = now.toISOString();
  await deactivateExpiredGamifications(env.DB, closedAt);

  const queued = await env.DB.prepare(
    'SELECT object_key FROM media_deletion_queue ORDER BY created_at ASC LIMIT 100',
  ).all<{ object_key: string }>();
  for (const item of queued.results) {
    try {
      await env.MEDIA_BUCKET.delete(item.object_key);
      await env.DB.prepare('DELETE FROM media_deletion_queue WHERE object_key = ?').bind(item.object_key).run();
    } catch (error) {
      await env.DB.prepare(
        `UPDATE media_deletion_queue
         SET attempts = attempts + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE object_key = ?`,
      )
        .bind(errorMessage(error).slice(0, 500), item.object_key)
        .run();
    }
  }
};

const gamificationSelect = `SELECT g.id, g.public_id, g.company_id, c.public_id AS company_public_id,
  g.title, g.description, g.image_key, g.start_at, g.end_at, g.goal_value, g.value_precision, g.goal_unit, g.max_live_ranking, g.ranking_field_headers_json,
  g.status, g.outcome, g.created_at, g.updated_at, g.closed_at, g.actual_end_at
  FROM gamifications g JOIN companies c ON c.id = g.company_id`;

const findCompany = (db: D1Database, publicId: string): Promise<CompanyRow | null> =>
  db.prepare('SELECT id, public_id, name FROM companies WHERE public_id = ? LIMIT 1').bind(publicId).first<CompanyRow>();

const findGamification = (db: D1Database, publicId: string): Promise<GamificationRow | null> =>
  db.prepare(`${gamificationSelect} WHERE g.public_id = ? LIMIT 1`).bind(publicId).first<GamificationRow>();

const requireWritableGamification = findGamification;

const findPrize = (db: D1Database, publicId: string): Promise<PrizeRow | null> =>
  db
    .prepare(
      `SELECT id, public_id, gamification_id, name, picture_key, sort_order, ranking_position, estimated_value_cents,
              created_at, updated_at
       FROM prizes WHERE public_id = ? LIMIT 1`,
    )
    .bind(publicId)
    .first<PrizeRow>();

type PrizeWithGamification = PrizeRow & {
  status: GamificationRow['status'];
  company_public_id: string;
  gamification_public_id: string;
};

const findPrizeWithGamification = (db: D1Database, publicId: string): Promise<PrizeWithGamification | null> =>
  db
    .prepare(
      `SELECT p.id, p.public_id, p.gamification_id, p.name, p.picture_key, p.sort_order, p.ranking_position,
              p.estimated_value_cents, p.created_at, p.updated_at,
              g.status, g.public_id AS gamification_public_id, c.public_id AS company_public_id
       FROM prizes p
       JOIN gamifications g ON g.id = p.gamification_id
       JOIN companies c ON c.id = g.company_id
       WHERE p.public_id = ? LIMIT 1`,
    )
    .bind(publicId)
    .first<PrizeWithGamification>();

const rankingCount = async (db: D1Database, gamificationId: number): Promise<number> =>
  (await db.prepare('SELECT COUNT(*) AS count FROM rankings WHERE gamification_id = ?').bind(gamificationId).first<{ count: number }>())
    ?.count ?? 0;

const outcomeForGoal = async (
  db: D1Database,
  gamificationId: number,
  goalValue: number | null,
): Promise<GamificationRow['outcome']> => {
  if (goalValue === null) return 'not_applicable';
  const total = (await db.prepare('SELECT COALESCE(SUM(score_value), 0) AS total FROM rankings WHERE gamification_id = ?').bind(gamificationId).first<{ total: number }>())?.total ?? 0;
  return total >= goalValue ? 'achieved' : 'missed';
};

const findParticipant = (db: D1Database, companyId: number, participantCode: string): Promise<ParticipantRow | null> =>
  db
    .prepare(
      `SELECT id, company_id, participant_code, full_name, picture_key, created_at, updated_at
       FROM participants WHERE company_id = ? AND participant_code = ? LIMIT 1`,
    )
    .bind(companyId, participantCode)
    .first<ParticipantRow>();

const findRankedParticipant = (db: D1Database, gamificationId: number, participantCode: string): Promise<ParticipantRow | null> =>
  db
    .prepare(
      `SELECT p.id, p.company_id, p.participant_code, p.full_name, p.picture_key, p.created_at, p.updated_at
       FROM rankings r
       INNER JOIN participants p ON p.id = r.participant_id
       WHERE r.gamification_id = ? AND p.participant_code = ? LIMIT 1`,
    )
    .bind(gamificationId, participantCode)
    .first<ParticipantRow>();

const requireSuperuser = async (
  c: AppContext,
  readAuthenticatedPrincipal: ReadAuthenticatedPrincipal,
): Promise<AuthResult> => {
  const auth = await readAuthenticatedPrincipal(c);
  if (!auth.ok || auth.principal.role === 'superuser') return auth;
  return { ok: false, response: c.json({ error: 'Forbidden.' }, 403) };
};

const parseGamificationInput = (
  body: unknown,
  existing?: GamificationRow,
): { ok: true; value: GamificationInput } | { ok: false; error: string } => {
  if (!isRecord(body)) return { ok: false, error: 'Invalid gamification payload.' };

  const title = readString(body, 'title', maxTitleLength, existing?.title);
  const rawDescription = readString(body, 'description', maxDescriptionLength, existing?.description);
  const description = rawDescription === null ? null : sanitizeDescription(rawDescription);
  const goalUnit = readOptionalString(body, 'goalUnit', 40, existing?.goal_unit);
  const valuePrecision = readInteger(body, 'valuePrecision', 0, 6, existing?.value_precision);
  const maxLiveRanking = readInteger(
    body,
    'maxLiveRanking',
    minLiveRankingEntries,
    maxRankingEntries,
    existing?.max_live_ranking ?? 5,
  );
  const startAt = readIsoDate(body['startAt'], existing?.start_at);
  const endAt = readIsoDate(body['endAt'], existing?.end_at);
  const rules = parseGamificationRules(body['rules']);

  if (
    !title || !description || goalUnit === undefined || typeof valuePrecision !== 'number' || typeof maxLiveRanking !== 'number' || !startAt || !endAt
  ) {
    return { ok: false, error: 'Title, description, dates, value precision and live ranking are required.' };
  }
  if (endAt <= startAt) return { ok: false, error: 'End date must be after start date.' };
  if (!rules.ok) return rules;

  const defaultGoal = existing?.goal_value === null || existing === undefined
    ? null
    : trimDecimalZeros(formatDecimal(existing.goal_value, existing.value_precision));
  const goalValue = parseOptionalDecimal(body['goal'] === undefined ? defaultGoal : body['goal'], valuePrecision);
  if (goalValue === undefined) return { ok: false, error: 'Goal must be a non-negative decimal matching value precision.' };

  return { ok: true, value: { title, description, startAt, endAt, goalValue, valuePrecision, goalUnit, maxLiveRanking, rules: rules.value } };
};

const parseGamificationRules = (
  raw: unknown,
): { ok: true; value: GamificationRuleInput[] | undefined } | { ok: false; error: string } => {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: 'Rules must be an array.' };

  const positions = new Set<number>();
  const rules: GamificationRuleInput[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return { ok: false, error: 'Each rule is invalid.' };
    const position = readInteger(item, 'position', 1, Number.MAX_SAFE_INTEGER);
    const title = readString(item, 'title', maxTitleLength);
    const description = readString(item, 'description', maxRuleDescriptionLength);
    const iconName = readString(item, 'iconName', 120);
    if (
      typeof position !== 'number' || !title || !description || !iconName
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(iconName) || positions.has(position)
    ) {
      return { ok: false, error: 'Rules require unique positions, title, description and a valid Lucide icon name.' };
    }
    positions.add(position);
    rules.push({ position, title, description, iconName });
  }
  return { ok: true, value: rules };
};

const sanitizeDescription = (value: string): string | null => {
  const sanitized = sanitizeHtml(value, {
    allowedTags: allowedDescriptionTags,
    allowedAttributes: {
      a: ['href', 'title'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    exclusiveFilter: (frame) => (frame.tag === 'a' && !frame.attribs['href'] ? 'excludeTag' : false),
  }).trim();
  const visibleText = sanitizeHtml(sanitized, { allowedTags: [], allowedAttributes: {} })
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&#160;', ' ')
    .trim();

  return visibleText && sanitized.length <= maxDescriptionLength ? sanitized : null;
};

const parsePrizeInput = (
  body: unknown,
  existing?: PrizeRow,
): {
  ok: true;
  value: { name: string; sortOrder: number | undefined; rankingPosition: number; estimatedValueCents: number | null };
} | { ok: false; error: string } => {
  if (!isRecord(body)) return { ok: false, error: 'Invalid prize payload.' };
  const name = readString(body, 'name', 160, existing?.name);
  const sortOrder = readInteger(body, 'sortOrder', 0, Number.MAX_SAFE_INTEGER, existing?.sort_order, true);
  const rankingPosition = readInteger(body, 'rankingPosition', 1, maxRankingEntries, existing?.ranking_position);
  const estimatedValueCents = body['estimatedValue'] === undefined
    ? (existing?.estimated_value_cents ?? null)
    : parseEuroAmount(body['estimatedValue']);
  if (name === null || sortOrder === null || typeof rankingPosition !== 'number' || estimatedValueCents === undefined) {
    return { ok: false, error: 'Prize name, ranking position or estimated value is invalid.' };
  }
  return { ok: true, value: { name, sortOrder, rankingPosition, estimatedValueCents } };
};

const parseRankingInput = (
  body: unknown,
  precision: number,
  fieldHeaders: string[],
): { ok: true; value: RankingInput } | { ok: false; error: string } => {
  if (!isRecord(body)) return { ok: false, error: 'Invalid ranking entry.' };
  const participantCode = readString(body, 'participantCode', 128);
  const fullName = readString(body, 'fullName', 160);
  const scoreValue = parseDecimal(body['score'], precision);
  const customFields = parseRankingFieldValues(body['customFields'], fieldHeaders);
  if (participantCode === null || fullName === null || scoreValue === null) {
    return { ok: false, error: 'Each ranking entry requires participantCode, fullName and a valid score.' };
  }
  if (!customFields.ok) return customFields;
  return { ok: true, value: { participantCode, fullName, scoreValue, customFields: customFields.value } };
};

const reservedRankingFieldHeaders = new Set(['participantcode', 'fullname', 'score', 'image']);

const parseRankingFieldHeaders = (raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } => {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.length > maxRankingFieldHeaders) {
    return { ok: false, error: `Ranking field headers must be an array with at most ${maxRankingFieldHeaders} items.` };
  }
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'Each ranking field header must be text.' };
    const header = item.trim();
    const key = header.toLocaleLowerCase('en-US');
    if (!header || header.length > maxRankingFieldHeaderLength || reservedRankingFieldHeaders.has(key) || seen.has(key)) {
      return { ok: false, error: 'Ranking field headers are invalid, reserved or duplicated.' };
    }
    seen.add(key);
    headers.push(header);
  }
  return { ok: true, value: headers };
};

const parseRankingFieldValues = (
  raw: unknown,
  fieldHeaders: string[],
): { ok: true; value: Record<string, string> } | { ok: false; error: string } => {
  if (raw === undefined) return { ok: true, value: {} };
  if (!isRecord(raw)) return { ok: false, error: 'Ranking custom fields must be an object.' };
  const allowed = new Map(fieldHeaders.map((header) => [header.toLocaleLowerCase('en-US'), header]));
  const values: Record<string, string> = {};
  for (const [rawHeader, rawValue] of Object.entries(raw)) {
    const header = allowed.get(rawHeader.trim().toLocaleLowerCase('en-US'));
    if (!header || typeof rawValue !== 'string' || rawValue.trim().length > maxRankingFieldValueLength) {
      return { ok: false, error: 'Ranking custom field values are invalid.' };
    }
    const value = rawValue.trim();
    if (value) values[header] = value;
  }
  return { ok: true, value: values };
};

const parseStoredFieldHeaders = (raw: string): string[] => {
  try {
    const parsed = parseRankingFieldHeaders(JSON.parse(raw));
    return parsed.ok ? parsed.value : [];
  } catch {
    return [];
  }
};

const mergeRankingFieldHeaders = (existing: string[], requested: string[]): string[] => {
  const headers = [...existing];
  const seen = new Set(headers.map((header) => header.toLocaleLowerCase('en-US')));
  for (const header of requested) {
    const key = header.toLocaleLowerCase('en-US');
    if (!seen.has(key)) {
      seen.add(key);
      headers.push(header);
    }
  }
  return headers;
};

const readJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

const readString = (
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
  fallback?: string,
): string | null => {
  const raw = body[key] === undefined ? fallback : body[key];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value && value.length <= maxLength ? value : null;
};

const readOptionalString = (
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
  fallback?: string | null,
): string | null | undefined => {
  const raw = body[key] === undefined ? (fallback ?? null) : body[key];
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value ? (value.length <= maxLength ? value : undefined) : null;
};

const readInteger = (
  body: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  fallback?: number,
  optional = false,
): number | null | undefined => {
  const raw = body[key] === undefined ? fallback : body[key];
  if (raw === undefined && optional) return undefined;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= minimum && raw <= maximum ? raw : null;
};

const readIsoDate = (raw: unknown, fallback?: string): string | null => {
  const value = raw === undefined ? fallback : raw;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const parseDecimal = (raw: unknown, precision: number): number | null => {
  if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  if (fraction.length > precision) return null;
  const normalized = `${whole}${fraction.padEnd(precision, '0')}`.replace(/^0+(?=\d)/, '');
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value >= 0 && value <= maxScaledValue ? value : null;
};

const parseOptionalDecimal = (raw: unknown, precision: number): number | null | undefined => {
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) return null;
  return parseDecimal(raw, precision) ?? undefined;
};

const parseEuroAmount = (raw: unknown): number | null | undefined => {
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  const cents = Math.round(raw * 100);
  return Number.isSafeInteger(cents) && Math.abs(raw * 100 - cents) < 0.000_001 ? cents : undefined;
};

const formatDecimal = (value: number, precision: number): string => {
  if (precision === 0) return String(value);
  const raw = String(value).padStart(precision + 1, '0');
  return `${raw.slice(0, -precision)}.${raw.slice(-precision)}`;
};

const trimDecimalZeros = (value: string): string => value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

const serializeGamification = (row: GamificationRow, env: Env, requestUrl?: string) => ({
  publicId: row.public_id,
  companyPublicId: row.company_public_id,
  title: row.title,
  description: row.description,
  imageUrl: row.image_key ? assetUrl(env, row.image_key, requestUrl) : null,
  startAt: row.start_at,
  endAt: row.end_at,
  goal: row.goal_value === null ? null : formatDecimal(row.goal_value, row.value_precision),
  valuePrecision: row.value_precision,
  goalUnit: row.goal_unit,
  maxLiveRanking: row.max_live_ranking,
  rankingFieldHeaders: parseStoredFieldHeaders(row.ranking_field_headers_json),
  status: row.status === 'closed' ? 'inactive' : row.status,
  outcome: row.outcome,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  actualEndAt: row.actual_end_at ?? row.closed_at,
});

const serializeGamificationRule = (row: GamificationRuleRow) => ({
  position: row.position,
  title: row.title,
  description: row.description,
  iconName: row.icon_name,
});

const serializePrize = (row: PrizeRow, env: Env, requestUrl?: string) => ({
  publicId: row.public_id,
  name: row.name,
  pictureUrl: row.picture_key ? assetUrl(env, row.picture_key, requestUrl) : null,
  sortOrder: row.sort_order,
  rankingPosition: row.ranking_position,
  estimatedValue: row.estimated_value_cents === null ? null : row.estimated_value_cents / 100,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const serializeRanking = (row: RankingRow, precision: number, env: Env, requestUrl?: string) => ({
  participantCode: row.participant_code,
  fullName: row.full_name,
  pictureUrl: row.picture_key ? assetUrl(env, row.picture_key, requestUrl) : null,
  position: row.position,
  score: formatDecimal(row.score_value, precision),
  customFields: parseStoredFieldValues(row.custom_fields_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const parseStoredFieldValues = (raw: string): Record<string, string> => {
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
};

const ruleInsertStatements = (
  db: D1Database,
  gamificationId: number,
  rules: GamificationRuleInput[],
): D1PreparedStatement[] => rules.map((rule) =>
  db.prepare(
    `INSERT INTO gamification_rules (gamification_id, position, title, description, icon_name)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(gamificationId, rule.position, rule.title, rule.description, rule.iconName),
);

const assetUrl = (env: Env, key: string, requestUrl?: string): string => {
  const path = key.split('/').map(encodeURIComponent).join('/');
  const request = requestUrl ? new URL(requestUrl) : null;
  const isLocalRequest = request && (request.hostname === 'localhost' || request.hostname === '127.0.0.1');
  if (isLocalRequest) return `${request.origin}/media/${path}`;

  const base = env.ASSET_BASE_URL.replace(/\/$/, '');
  return `${base}/${path}`;
};

const deactivateExpiredGamifications = (db: D1Database, actualEndAt: string): Promise<D1Result> =>
  db
    .prepare(
      `UPDATE gamifications
       SET status = 'closed',
           outcome = CASE
             WHEN goal_value IS NULL THEN 'not_applicable'
             WHEN (SELECT COALESCE(SUM(r.score_value), 0) FROM rankings r WHERE r.gamification_id = gamifications.id) >= goal_value
               THEN 'achieved'
             ELSE 'missed'
           END,
           closed_at = ?, actual_end_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE status = 'active' AND end_at <= ?`,
    )
    .bind(actualEndAt, actualEndAt, actualEndAt)
    .run();

const deactivateGamification = (db: D1Database, id: number, actualEndAt: string): Promise<D1Result> =>
  db
    .prepare(
      `UPDATE gamifications
       SET status = 'closed',
           outcome = CASE
             WHEN goal_value IS NULL THEN 'not_applicable'
             WHEN (SELECT COALESCE(SUM(r.score_value), 0) FROM rankings r WHERE r.gamification_id = gamifications.id) >= goal_value
               THEN 'achieved'
             ELSE 'missed'
           END,
           closed_at = ?, actual_end_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'active'`,
    )
    .bind(actualEndAt, actualEndAt, id)
    .run();

const enqueueMediaStatement = (db: D1Database, key: string): D1PreparedStatement =>
  db.prepare('INSERT OR IGNORE INTO media_deletion_queue (object_key) VALUES (?)').bind(key);

const replaceMedia = async (
  env: Env,
  newKey: string,
  bytes: Uint8Array,
  oldKey: string | null,
  updateStatement: () => D1PreparedStatement,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  try {
    await env.MEDIA_BUCKET.put(newKey, bytes, {
      httpMetadata: { contentType: 'image/webp', cacheControl: immutableImageCacheControl },
    });
  } catch (error) {
    logError('R2 upload error', error);
    return { ok: false, error: 'Unable to store image.' };
  }

  try {
    const statements = [updateStatement()];
    if (oldKey) statements.push(enqueueMediaStatement(env.DB, oldKey));
    await env.DB.batch(statements);
    return { ok: true };
  } catch (error) {
    logError('Image database update error', error);
    try {
      await env.MEDIA_BUCKET.delete(newKey);
    } catch (cleanupError) {
      logError('R2 rollback cleanup error', cleanupError);
    }
    return { ok: false, error: 'Unable to attach image.' };
  }
};

const readWebp = async (
  request: Request,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 413 | 415 | 422; error: string }> => {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'image/webp') {
    return { ok: false, status: 415, error: 'Content-Type must be image/webp.' };
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxImageBytes) {
    return { ok: false, status: 413, error: 'Image exceeds the 2 MB limit.' };
  }
  if (!request.body) return { ok: false, status: 415, error: 'Body is not a valid supported WebP image.' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maxImageBytes) {
      await reader.cancel('Image exceeds the 2 MB limit.');
      return { ok: false, status: 413, error: 'Image exceeds the 2 MB limit.' };
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const dimensions = webpDimensions(bytes);
  if (!dimensions) return { ok: false, status: 415, error: 'Body is not a valid supported WebP image.' };
  if (dimensions.width > maxImageDimension || dimensions.height > maxImageDimension) {
    return { ok: false, status: 422, error: 'Image dimensions exceed 2400 pixels.' };
  }
  return { ok: true, bytes };
};

const webpDimensions = (bytes: Uint8Array): { width: number; height: number } | null => {
  if (
    bytes.length < 25 ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 12) !== 'WEBP' ||
    uint32(bytes, 4) + 8 !== bytes.length
  ) {
    return null;
  }
  const chunk = ascii(bytes, 12, 16);
  const chunkSize = uint32(bytes, 16);
  if (20 + chunkSize > bytes.length) return null;
  if (chunk === 'VP8X' && chunkSize >= 10 && bytes.length >= 30) {
    return { width: 1 + uint24(bytes, 24), height: 1 + uint24(bytes, 27) };
  }
  if (chunk === 'VP8 ' && chunkSize >= 10 && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === 'VP8L' && chunkSize >= 5 && bytes[20] === 0x2f) {
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  return null;
};

const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));
const uint24 = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
const uint32 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const logError = (message: string, error: unknown): void => {
  console.error(JSON.stringify({ message, error: errorMessage(error) }));
};
