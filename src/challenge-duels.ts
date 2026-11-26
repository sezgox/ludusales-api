import type { Entry, Publication } from './challenge-calculation';
import type { ChallengeSettings } from './challenge-settings';

export type DuelResult = { id: string; title: string; round: string; start: string; end: string; stake: string; format: 'solo' | 'pairs';
  left: string[]; right: string[]; leftScore: number; rightScore: number; winner: 'left' | 'right' | null;
  status: 'upcoming' | 'active' | 'closed' };

export function calculateDuels(settings: ChallengeSettings, entries: Entry[], past: Publication[], date: string): DuelResult[] {
  const calculated = new Map<string, DuelResult>();
  const prior = past[0]?.projection?.duels ?? [];
  for (const duel of settings.duels ?? []) {
    const frozen = prior.find(({ id, status }) => id === duel.id && status === 'closed');
    if (frozen && frozen.winner) {
      calculated.set(duel.id, frozen);
      continue;
    }
    const resolve = (reference: string, members: string[]) => {
      const feeder = calculated.get(reference);
      return reference ? (feeder?.winner ? feeder[feeder.winner] : []) : members;
    };
    const left = resolve(duel.leftFrom, duel.left);
    const right = resolve(duel.rightFrom, duel.right);
    const start = past.find((previous) => previous.date < duel.start)?.entries;
    const finish = date > duel.end ? [...(past.find((previous) => previous.date <= duel.end)?.entries.values() ?? [])] : entries;
    const countable = date >= duel.start && left.length && right.length;
    const isSum = settings.metrics.find(({ key }) => key === duel.metric)?.kind === 'sum';
    const score = (codes: string[], key: string, subtract: boolean) => {
      const sides = finish.filter((entry) => codes.includes(entry.code));
      const zones = new Set(sides.map(({ zone }) => zone).filter(Boolean));
      const participants = duel.useZone ? finish.filter(({ zone }) => zones.has(zone)) : sides;
      return participants.reduce((total, member) => total + Math.max(0,
        (member.metrics[key] ?? 0) - (subtract ? start?.get(member.id)?.metrics[key] ?? 0 : 0)), 0);
    };
    const leftScore = countable ? score(left, duel.metric, isSum) : 0;
    const rightScore = countable ? score(right, duel.metric, isSum) : 0;
    const status = date < duel.start ? 'upcoming' : date >= duel.end ? 'closed' : 'active';
    let winner: DuelResult['winner'] = null;
    if (status === 'closed' && countable) {
      let difference = leftScore - rightScore;
      for (const metric of settings.tieBreakers) {
        if (difference) break;
        difference = score(left, metric, settings.metrics.find(({ key }) => key === metric)?.kind === 'sum') -
          score(right, metric, settings.metrics.find(({ key }) => key === metric)?.kind === 'sum');
      }
      winner = difference > 0 ? 'left' : difference < 0 ? 'right' : null;
    }
    calculated.set(duel.id, { id: duel.id, title: duel.title, round: duel.round, start: duel.start, end: duel.end,
      stake: duel.stake, format: duel.format, left, right, leftScore, rightScore, winner, status });
  }
  return [...calculated.values()];
}
