import type { ChallengeSettings } from './challenge-settings';

type HistoricalRow = {
  challenge: string; title: string; name: string; position: number; score: number;
  ranking_unit: string; scale: number; initial_position: number | null; best_sale: number | null; settings_json: string | null;
};

export async function readChallengeHistory(db: Env['DB'], companyPublicId: string, isCompany: boolean) {
  const { results } = await db.prepare(`WITH latest AS (
    SELECT g.id, g.public_id, g.title, g.ranking_unit, g.value_precision, s.settings_json,
      (SELECT id FROM data_updates WHERE gamification_id = g.id AND status = 'published' ORDER BY id DESC LIMIT 1) AS latest_id,
      (SELECT id FROM data_updates WHERE gamification_id = g.id AND status = 'published' ORDER BY id ASC LIMIT 1) AS initial_id
    FROM gamifications g JOIN companies c ON c.id = g.company_id
    LEFT JOIN challenge_settings s ON s.gamification_id = g.id
    WHERE c.public_id = ? AND g.status = 'closed'
  ), ranked AS (
    SELECT latest.public_id AS challenge, latest.title, latest.ranking_unit, latest.settings_json, p.full_name AS name,
      r.position, r.score_value AS score, CAST('1' || substr('000000', 1, u.value_precision) AS INTEGER) AS scale,
      original.position AS initial_position, json_extract(r.calculation_json, '$.metrics.venta_maxima') AS best_sale,
      ROW_NUMBER() OVER (PARTITION BY latest.id ORDER BY r.position, r.sort_order, r.participant_id) AS display_order,
      r.participant_id
    FROM latest JOIN data_updates u ON u.id = latest.latest_id
    JOIN participant_results r ON r.update_id = u.id JOIN participants p ON p.id = r.participant_id
    LEFT JOIN participant_results original ON original.update_id = latest.initial_id AND original.participant_id = r.participant_id
  ), candidates AS (
    SELECT ranked.*, MAX(initial_position - position) OVER (PARTITION BY challenge) AS highest_climb,
      MAX(best_sale) OVER (PARTITION BY challenge) AS highest_sale
    FROM ranked
  )
  SELECT * FROM candidates WHERE display_order <= 3
    OR (highest_climb > 0 AND initial_position - position = highest_climb) OR (highest_sale > 0 AND best_sale = highest_sale)
  ORDER BY challenge, display_order`).bind(companyPublicId).all<HistoricalRow & { display_order: number }>();

  type RecordHolder = { title: string; name: string; challenge: string; value: number; unit: string };
  const podiums: Record<string, Array<{ name: string; position: number; score: number }>> = {};
  const recordScores = new Map<string, RecordHolder>();
  let bestClimb: RecordHolder | null = null;
  let bestSale: RecordHolder | null = null;
  for (const row of results as Array<HistoricalRow & { display_order: number }>) {
    const settings = row.settings_json ? JSON.parse(row.settings_json) as ChallengeSettings : null;
    const name = isCompany && settings?.anonymousFrom != null && row.position >= settings.anonymousFrom ? `Participante ${row.position}` : row.name;
    const score = row.score / row.scale;
    const holder = { name, challenge: row.challenge };
    if (row.display_order <= 3) (podiums[row.challenge] ??= []).push({ name, position: row.position, score });
    if (score > (recordScores.get(row.ranking_unit)?.value ?? -1)) {
      recordScores.set(row.ranking_unit, { ...holder, title: `Mayor puntuación · ${row.ranking_unit}`, value: score, unit: row.ranking_unit });
    }
    const change = (row.initial_position ?? row.position) - row.position;
    if (change > (bestClimb?.value ?? 0)) bestClimb = { ...holder, title: 'Mayor remontada', value: change, unit: 'puestos' };
    if (row.best_sale !== null && row.best_sale > (bestSale?.value ?? 0) && (!isCompany || !settings?.hiddenMetrics.includes('venta_maxima'))) {
      bestSale = { ...holder, title: 'Venta más alta', value: row.best_sale, unit: '€' };
    }
  }
  return { podiums, records: [...recordScores.values(), ...(bestClimb ? [bestClimb] : []), ...(bestSale ? [bestSale] : [])] };
}
