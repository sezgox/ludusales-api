import type { Entry } from './challenge-calculation';

export type PrizeKind = 'position' | 'milestone' | 'zone' | 'special' | 'raffle';
export const prizeKinds: PrizeKind[] = ['position', 'milestone', 'zone', 'special', 'raffle'];
type Prize = { public_id: string; gamification_id: number; kind: PrizeKind; parameter: string; ranking_position: number | null };
type Candidate = { id: number; score: number; position: number; zone: string; calculation: Entry | null };
type RawCandidate = { participant_id: number; score_value: number; position: number; calculation_json: string | null; custom_fields_json: string };

function randomIndex(count: number): number {
  const exclusive = 0x1_0000_0000;
  const limit = exclusive - exclusive % count;
  const buffer = new Uint32Array(1);
  do { crypto.getRandomValues(buffer); } while (buffer[0]! >= limit);
  return buffer[0]! % count;
}

function winners(prize: Prize, eligible: Candidate[]): Candidate[] {
  switch (prize.kind) {
    case 'position': return eligible.filter(({ position }) => position === prize.ranking_position).slice(0, 1);
    case 'milestone': return eligible.filter(({ score }) => score >= Number(prize.parameter));
    case 'raffle': return eligible.length ? [eligible[randomIndex(eligible.length)]!] : [];
    case 'zone': {
      if (prize.parameter) return eligible.filter(({ zone }) => zone === prize.parameter);
      const totals = new Map<string, { total: number; members: number }>();
      for (const { zone, score } of eligible) {
        if (!zone) continue;
        const item = totals.get(zone) ?? { total: 0, members: 0 };
        totals.set(zone, { total: item.total + score, members: item.members + 1 });
      }
      const leader = [...totals].sort(([leftName, left], [rightName, right]) =>
        right.total / right.members - left.total / left.members || leftName.localeCompare(rightName, 'es'))[0]?.[0];
      return eligible.filter(({ zone }) => zone === leader);
    }
    case 'special': {
      const merit = ({ calculation }: Candidate) => prize.parameter === 'improved' ? calculation?.positionChange ?? 0
        : prize.parameter === 'missions' ? calculation?.missionAwards.length ?? 0 : calculation?.metrics[prize.parameter] ?? 0;
      const first = eligible.filter((candidate) => merit(candidate) > 0).sort((a, b) => merit(b) - merit(a))[0];
      return first ? [first] : [];
    }
  }
}

export async function confirmPrize(db: Env['DB'], prize: Prize, administrator: string): Promise<'confirmed' | 'no_data' | 'no_winner' | 'stale'> {
  const update = await db.prepare(`SELECT u.id, u.value_precision FROM data_updates u JOIN gamifications g ON g.id = u.gamification_id
    WHERE u.gamification_id = ? AND u.status = 'published' AND g.status = 'closed' ORDER BY u.id DESC LIMIT 1`)
    .bind(prize.gamification_id).first<{ id: number; value_precision: number }>();
  if (!update) return 'no_data';
  const alreadyConfirmed = await db.prepare('SELECT 1 FROM prize_decisions WHERE prize_public_id = ? AND update_id = ?')
    .bind(prize.public_id, update.id).first();
  if (alreadyConfirmed) return 'confirmed';
  const { results } = await db.prepare(`SELECT participant_id, score_value, position, calculation_json, custom_fields_json
    FROM participant_results WHERE update_id = ? ORDER BY position, sort_order, participant_id`).bind(update.id).all<RawCandidate>();
  const scale = 10 ** update.value_precision;
  const eligible = (results as RawCandidate[]).map((row): Candidate => {
    const calculation = row.calculation_json ? JSON.parse(row.calculation_json) as Entry : null;
    const fields = JSON.parse(row.custom_fields_json) as { Zona?: string; Zone?: string };
    return { id: row.participant_id, score: row.score_value / scale, position: row.position, calculation,
      zone: calculation?.zone ?? fields.Zona ?? fields.Zone ?? '' };
  }).filter(({ calculation }) => calculation?.eligible !== false);
  const selected = winners(prize, eligible);
  if (!selected.length) return 'no_winner';

  const result = await db.prepare(`INSERT OR IGNORE INTO prize_decisions (prize_public_id, update_id, kind, winners_json, pool_size, administrator_public_id, decided_at)
    SELECT p.public_id, ?, p.kind, ?, ?, ?, ? FROM prizes p JOIN gamifications g ON g.id = p.gamification_id
    WHERE p.public_id = ? AND p.kind = ? AND p.parameter = ? AND p.ranking_position IS ? AND g.status = 'closed'
      AND ? = (SELECT id FROM data_updates WHERE gamification_id = g.id AND status = 'published' ORDER BY id DESC LIMIT 1)`)
    .bind(update.id, JSON.stringify(selected.map(({ id }) => id)), eligible.length, administrator, new Date().toISOString(), prize.public_id,
      prize.kind, prize.parameter, prize.ranking_position, update.id).run();
  if (result.meta.changes === 1) return 'confirmed';
  return await db.prepare('SELECT 1 FROM prize_decisions WHERE prize_public_id = ? AND update_id = ?')
    .bind(prize.public_id, update.id).first() ? 'confirmed' : 'stale';
}
