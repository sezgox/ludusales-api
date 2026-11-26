type Database = Env['DB'];

export type RankingPublication = {
  public_id: string;
  published_at: string;
  value_precision: number;
  status: 'published' | 'reverted';
};

export function snapshotRanking(db: Database, gamificationId: number) {
  const publicId = crypto.randomUUID();
  return [
    db.prepare(`INSERT OR IGNORE INTO challenge_members (gamification_id, participant_id, zone)
      SELECT gamification_id, participant_id, COALESCE(json_extract(custom_fields_json, '$.Zona'), json_extract(custom_fields_json, '$.Zone'), '')
      FROM rankings WHERE gamification_id = ?`).bind(gamificationId),
    db.prepare(`INSERT INTO data_updates (public_id, gamification_id, published_at, value_precision, field_headers_json)
      SELECT ?, id, ?, value_precision, ranking_field_headers_json FROM gamifications WHERE id = ?`)
      .bind(publicId, new Date().toISOString(), gamificationId),
    db.prepare(`INSERT INTO participant_results (update_id, participant_id, score_value, position, custom_fields_json)
      SELECT u.id, r.participant_id, r.score_value, RANK() OVER (ORDER BY r.score_value DESC), r.custom_fields_json
      FROM rankings r JOIN data_updates u ON u.gamification_id = r.gamification_id
      WHERE u.public_id = ?`).bind(publicId),
  ];
}

export async function revertRankingPublication(db: Database, gamificationId: number, publicId: string): Promise<boolean> {
  // Each statement sees the same latest publication until the last statement marks it reverted.
  const published = `SELECT id FROM data_updates WHERE gamification_id = ? AND status = 'published' ORDER BY id DESC`;
  const targetIsLatest = `EXISTS (SELECT 1 FROM data_updates WHERE id = (${published} LIMIT 1) AND public_id = ?)`;
  const previous = `SELECT * FROM data_updates WHERE id = (${published} LIMIT 1 OFFSET 1)`;
  const precisionMatches = `EXISTS (SELECT 1 FROM (${previous}) prev JOIN gamifications g ON g.id = prev.gamification_id
    WHERE prev.value_precision = g.value_precision)`;
  const canRestore = `${targetIsLatest} AND ${precisionMatches}`;
  const condition = [gamificationId, publicId, gamificationId];
  const results = await db.batch([
    db.prepare(`DELETE FROM rankings WHERE gamification_id = ? AND ${canRestore}`)
      .bind(gamificationId, ...condition),
    db.prepare(`INSERT INTO rankings (gamification_id, participant_id, score_value, custom_fields_json)
      SELECT ?, r.participant_id, r.score_value, r.custom_fields_json FROM participant_results r
      WHERE r.update_id = (${published} LIMIT 1 OFFSET 1) AND ${canRestore}`)
      .bind(gamificationId, gamificationId, ...condition),
    db.prepare(`UPDATE gamifications SET ranking_field_headers_json = COALESCE((SELECT field_headers_json FROM (${previous})), '[]'),
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ${canRestore}`)
      .bind(gamificationId, gamificationId, ...condition),
    db.prepare(`UPDATE data_updates SET status = 'reverted' WHERE public_id = ? AND ${canRestore}`)
      .bind(publicId, ...condition),
  ]);
  return results.at(-1)?.meta.changes === 1;
}
