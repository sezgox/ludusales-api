import { record, validDate, type Badge, type ChallengeSettings, type ImportMode, type Mission } from './challenge-settings';
import { calculateDuels, type DuelResult } from './challenge-duels';

export type Member = { id: number; code: string; fullName: string; zone: string; active: boolean };
export type Metrics = Record<string, number>;
type PointsLine = { label: string; points: number };
type Award = { id: string; points: number; date: string };

export type Entry = Member & {
  metrics: Metrics;
  period: Metrics;
  breakdown: PointsLine[];
  score: number;
  baseScore: number;
  position: number;
  positionChange: number | null;
  scoreChange: number | null;
  weekPoints: number;
  distance: number | null;
  streak: number;
  streakPoints: number;
  badges: Award[];
  missionAwards: Award[];
  eligible: boolean;
  minimumsMissing: string[];
};

export type MissionResult = {
  id: string;
  status: 'upcoming' | 'active' | 'closed';
  progress: number;
  leaders: Array<{ key: string; value: number }>;
  winners: number[];
};

export type TeamResult = { name: string; total: number; average: number; position: number; change: number | null; mvpCode: string; count: number };
export type News = { text: string; priority: number; code?: string; badgeId?: string; missionId?: string };
export type Projection = { dataDate: string; goalTotal: number; teams: TeamResult[]; missions: MissionResult[]; duels: DuelResult[]; news: News[] };
export type Publication = { date: string; entries: Map<number, Entry>; projection: Projection | null };

type Input = { sourceName: string; sourceHash: string | null; mode: ImportMode; headers: string[]; rows: unknown[]; allowDecreases: boolean };
type Result = { ok: true; input: Input; entries: Entry[]; projection: Projection; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

function readInput(raw: unknown, settings: ChallengeSettings): Input | null {
  const body = record(raw);
  if (!body) return null;
  const { sourceName, sourceHash, headers, rows, allowDecreases } = body;
  const mode = body['mode'] ?? settings.mode;
  if (typeof sourceName !== 'string' || !sourceName.trim() || sourceName.length > 255 || (mode !== 'accumulated' && mode !== 'period') ||
      !Array.isArray(headers) || headers.length === 0 || headers.length > 80 || headers.some((value) => typeof value !== 'string' || value.length > 80) ||
      !Array.isArray(rows) || !rows.length || rows.length > 1000 || (allowDecreases !== undefined && typeof allowDecreases !== 'boolean') ||
      (sourceHash !== undefined && (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash)))) return null;
  return { sourceName, sourceHash: typeof sourceHash === 'string' ? sourceHash : null, headers: headers.map((header: string) => header.trim()), rows, mode, allowDecreases: allowDecreases === true };
}

function number(value: unknown): number | null {
  const normalized = typeof value === 'string' && /^\d+(?:[.,]\d{1,6})?$/.test(value.trim()) ? Number(value.replace(',', '.')) : value;
  return typeof normalized === 'number' && Number.isFinite(normalized) && normalized >= 0 && normalized <= 1_000_000_000 ? normalized : null;
}

function monday(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

function rank<T>(items: T[], score: (item: T) => number, assign: (item: T, position: number) => void): void {
  let position = 0;
  items.forEach((item, index) => {
    if (!index || score(item) !== score(items[index - 1]!)) position = index + 1;
    assign(item, position);
  });
}

function scoreRules(metrics: Metrics, settings: ChallengeSettings, round: (value: number) => number): PointsLine[] {
  return settings.rules.map(({ metric, label, rate, multiplier }) => ({
    label, points: round((metrics[metric] ?? 0) * rate * (multiplier === null ? 1 : multiplier - 1)),
  }));
}

function takeAward(awards: Award[], id: string, points: number, date: string): boolean {
  if (awards.some((award) => award.id === id)) return false;
  awards.push({ id, points, date });
  return true;
}

function evaluateMissions(settings: ChallengeSettings, entries: Entry[], past: Publication[], date: string): MissionResult[] {
  const latest = past[0]?.projection;
  return settings.missions.map((mission) => {
    const status = date < mission.start ? 'upcoming' : date >= mission.end ? 'closed' : 'active';
    const previous = latest?.missions.find(({ id }) => id === mission.id);
    if (previous?.status === 'closed') return previous;
    if (status === 'upcoming') return { id: mission.id, status, progress: 0, leaders: [], winners: [] };
    const baseline = past.find(({ date: previousDate }) => previousDate < mission.start)?.entries;
    const endSnapshot = date > mission.end ? past.find(({ date: previousDate }) => previousDate <= mission.end)?.entries : undefined;
    const source = date > mission.end ? [...(endSnapshot?.values() ?? [])] : entries;
    const kind = settings.metrics.find(({ key }) => key === mission.metric)?.kind;
    const values = source.map((member) => ({ member, value: missionValue(mission, member, baseline?.get(member.id), kind) }))
      .sort((a, b) => b.value - a.value || a.member.code.localeCompare(b.member.code));
    const sum = values.reduce((total, item) => total + item.value, 0);
    const first = values[0];
    let progress = first?.value ?? 0;
    let winners: number[] = [];
    let leaders = values.slice(0, 3).map(({ member, value }) => ({ key: member.code, value }));

    switch (mission.kind) {
      case 'first':
        winners = previous?.winners.length ? previous.winners : (first && first.value >= mission.threshold ? [first.member.id] : []);
        break;
      case 'most':
        if (status === 'closed' && first && first.value > 0) winners = [first.member.id];
        break;
      case 'all':
        winners = values.filter(({ value }) => value >= mission.threshold).map(({ member }) => member.id);
        progress = winners.length;
        break;
      case 'collective':
        progress = sum;
        if (sum >= mission.threshold) winners = values.map(({ member }) => member.id);
        break;
      case 'zones': {
        const zones = groupZones(values, ({ member }) => member.zone);
        leaders = [...zones.entries()].map(([key, team]) => ({ key, value: team.reduce((total, item) => total + item.value, 0) / team.length }))
          .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key, 'es'));
        progress = leaders[0]?.value ?? 0;
        if (status === 'closed' && progress > 0) {
          const winningZones = new Set(leaders.filter(({ value }) => value === progress).map(({ key }) => key));
          winners = values.filter(({ member }) => winningZones.has(member.zone)).map(({ member }) => member.id);
        }
      }
    }
    return { id: mission.id, status, progress, leaders, winners };
  });
}

function missionValue(mission: Mission, entry: Entry, baseline: Entry | undefined, kind: string | undefined): number {
  const value = entry.metrics[mission.metric] ?? 0;
  return kind === 'sum' ? Math.max(0, value - (baseline?.metrics[mission.metric] ?? 0)) : value;
}

function groupZones<T>(items: T[], zoneOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const zone = zoneOf(item);
    if (!zone) continue;
    const members = grouped.get(zone) ?? [];
    members.push(item);
    grouped.set(zone, members);
  }
  return grouped;
}

function badgeEarned(badge: Badge, entry: Entry): boolean {
  switch (badge.rule) {
    case 'metric': return (entry.metrics[badge.metric] ?? 0) >= badge.threshold;
    case 'points': return entry.score >= badge.threshold;
    case 'streak': return entry.streak >= badge.threshold;
    case 'position': return entry.position <= badge.threshold;
    case 'climb': return (entry.positionChange ?? 0) >= badge.threshold;
    case 'minimums': return entry.eligible;
    case 'missions': return entry.missionAwards.length >= badge.threshold;
  }
}

export function calculatePublication(raw: unknown, settings: ChallengeSettings, roster: Member[], past: Publication[],
  bounds: { start: string; end: string; precision: number; today: string }): Result {
  const input = readInput(raw, settings);
  if (!input || !settings.rules.length) return { ok: false, errors: ['Configura las reglas de puntos y selecciona un Excel maestro válido.'], warnings: [] };

  const keys = ['id_participante', 'nombre', 'fecha_datos', 'zona_equipo', ...settings.metrics.map(({ key }) => key)];
  const columns = new Map(input.headers.map((header) => [header.toLocaleLowerCase('es'), header]));
  const source = (key: string) => settings.columns[key] ?? key;
  const header = (key: string) => columns.get(source(key).toLocaleLowerCase('es'));
  const value = (row: Record<string, unknown>, key: string) => row[header(key) ?? source(key)];
  const active = roster.filter((member) => member.active);
  const byCode = new Map(roster.map((member) => [member.code, member]));
  const zoned = settings.showTeams || settings.missions.some(({ kind }) => kind === 'zones');
  const required = keys.filter((key) => key !== 'zona_equipo' || zoned);
  const errors = required.filter((key) => !header(key)).map((key) => `Falta la columna «${source(key)}».`);
  if (columns.size !== input.headers.length) errors.push('El Excel contiene cabeceras duplicadas.');
  const known = new Set(keys.map((key) => source(key).toLocaleLowerCase('es')));
  const warnings = input.headers.filter((column) => !known.has(column.toLocaleLowerCase('es'))).map((column) => `Columna sin asignar: ${column}.`);
  if (errors.length) return { ok: false, errors, warnings };

  const previous = past[0];
  const incoming = new Map<number, { metrics: Metrics; period: Metrics; zone: string }>();
  let date = '';
  const seen = new Set<string>();
  input.rows.forEach((rawRow, index) => {
    const row = record(rawRow) ?? {};
    const label = `Fila ${index + 2}`;
    const id = value(row, 'id_participante');
    const code = typeof id === 'string' ? id.trim() : '';
    const member = byCode.get(code);
    if (!member) {
      errors.push(`${label}: participante desconocido (${code || 'sin código'}).`);
      return;
    }
    if (seen.has(code)) {
      errors.push(`${label}: código repetido (${code}).`);
      return;
    }
    seen.add(code);
    const rawName = value(row, 'nombre');
    if (typeof rawName !== 'string' || !rawName.trim()) errors.push(`${label}: falta el nombre.`);
    const dataDate = value(row, 'fecha_datos');
    if (!validDate(dataDate) || dataDate < bounds.start || dataDate > bounds.end || dataDate > bounds.today || (previous && dataDate < previous.date)) {
      errors.push(`${label}: fecha de datos fuera del reto o anterior a la última publicación.`);
    } else if (date && dataDate !== date) {
      errors.push(`${label}: todas las filas deben tener la misma fecha de datos.`);
    } else {
      date = dataDate;
    }
    const rawZone = value(row, 'zona_equipo');
    const zone = typeof rawZone === 'string' ? rawZone.trim().slice(0, 80) : member.zone;
    if (zoned && !zone) errors.push(`${label}: falta la zona o equipo.`);
    if (!member.active) {
      warnings.push(`${label}: participante inactivo (${code}).`);
      return;
    }

    const metrics: Metrics = {};
    const period: Metrics = {};
    for (const { key, label: metricLabel, kind, integer } of settings.metrics) {
      const next = number(value(row, key));
      if (next === null || (integer && !Number.isInteger(next)) || (key === 'satisfaccion_media' && next > 5)) {
        errors.push(`${label}: valor no válido en ${metricLabel}.`);
        continue;
      }
      const old = previous?.entries.get(member.id)?.metrics[key] ?? 0;
      if (kind === 'sum' && input.mode === 'accumulated' && next < old && !input.allowDecreases) {
        errors.push(`${label}: ${metricLabel} baja de ${old} a ${next}. Confirma la corrección para continuar.`);
      }
      if (kind === 'sum' && old > 0 && (input.mode === 'period' ? next > old * 3 : next > old * 4)) {
        warnings.push(`${label}: aumento superior al 300 % en ${metricLabel}.`);
      }
      metrics[key] = input.mode === 'accumulated' || kind === 'latest' ? next : (kind === 'max' ? Math.max(next, old) : old + next);
      period[key] = input.mode === 'period' || kind !== 'sum' ? next : next - old;
    }
    if (metrics['ventas_cerradas'] !== undefined && metrics['ventas_estrategicas'] !== undefined &&
        metrics['ventas_estrategicas'] > metrics['ventas_cerradas']) {
      errors.push(`${label}: las ventas estratégicas no pueden superar las ventas cerradas.`);
    }
    incoming.set(member.id, { metrics, period, zone });
  });

  if (!incoming.size) errors.push('El archivo no contiene datos de participantes activos.');
  if (errors.length) return { ok: false, errors, warnings };

  const scale = 10 ** bounds.precision;
  const round = (number: number) => Math.round((number + Number.EPSILON) * scale) / scale;
  const sumPoints = (items: Array<{ points: number }>) => round(items.reduce((sum, item) => sum + item.points, 0));
  const weekBaseline = past.find((point) => point.date < monday(date));
  const entries = active.map((member): Entry => {
    const old = previous?.entries.get(member.id);
    const next = incoming.get(member.id);
    if (!next) warnings.push(`Falta el participante activo ${member.fullName}. Se conservan sus datos anteriores.`);
    const metrics = next?.metrics ?? old?.metrics ?? {};
    const breakdown = scoreRules(metrics, settings, round);
    const minimumsMissing = settings.minimums.filter(({ metric, operator, value }) => metrics[metric] === undefined ||
      (operator === '>=' ? metrics[metric]! < value : metrics[metric]! > value)).map(({ label }) => label);
    const baseScore = sumPoints(breakdown);
    return { ...member, zone: next?.zone ?? old?.zone ?? member.zone, metrics, period: next?.period ?? {}, breakdown, score: baseScore,
      baseScore, position: 0, positionChange: null, scoreChange: null, weekPoints: 0, distance: null,
      streak: old?.streak ?? 0, streakPoints: old?.streakPoints ?? 0, badges: [...(old?.badges ?? [])], missionAwards: [...(old?.missionAwards ?? [])],
      eligible: minimumsMissing.length === 0, minimumsMissing };
  });
  const news: News[] = [];
  const missions = evaluateMissions(settings, entries, past, date);
  const missionById = new Map(settings.missions.map((mission) => [mission.id, mission]));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const mission of missions) {
    const rules = missionById.get(mission.id)!;
    for (const id of mission.winners) {
      const member = byId.get(id);
      if (member && takeAward(member.missionAwards, mission.id, rules.reward, date)) {
        news.push({ text: `${member.fullName} completó «${rules.title}».`, priority: 4, code: member.code, missionId: mission.id });
      }
    }
  }

  const compare = (left: Entry, right: Entry) => {
    if (left.score !== right.score) return right.score - left.score;
    for (const key of settings.tieBreakers) {
      const result = (right.metrics[key] ?? 0) - (left.metrics[key] ?? 0);
      if (result) return result;
    }
    return left.fullName.localeCompare(right.fullName, 'es') || left.code.localeCompare(right.code);
  };

  for (const entry of entries) {
    const old = previous?.date ? previous.entries.get(entry.id) : undefined;
    const missionPoints = sumPoints(entry.missionAwards);
    if (!old || round(entry.baseScore + missionPoints) > round(old.baseScore + sumPoints(old.missionAwards))) {
      entry.streak += 1;
      if (settings.streak && entry.streak % settings.streak.length === 0) entry.streakPoints = round(entry.streakPoints + settings.streak.points);
    } else {
      entry.streak = 0;
    }
    entry.score = round(entry.baseScore + missionPoints + sumPoints(entry.badges) + entry.streakPoints);
  }
  entries.sort(compare);
  rank(entries, (entry) => entry.score, (entry, position) => {
    entry.position = position;
    const old = previous?.entries.get(entry.id);
    entry.positionChange = old ? old.position - position : null;
  });

  for (const entry of entries) {
    for (const badge of settings.badges) {
      if (badge.active && badgeEarned(badge, entry) && takeAward(entry.badges, badge.id, badge.points, date)) {
        const priority = 3 + ['common', 'rare', 'epic', 'legendary'].indexOf(badge.rarity);
        news.push({ text: `${entry.fullName} consiguió «${badge.title}».`, priority, code: entry.code, badgeId: badge.id });
      }
    }
    const badges = sumPoints(entry.badges);
    const missionPoints = sumPoints(entry.missionAwards);
    if (badges) entry.breakdown.push({ label: 'Insignias', points: badges });
    if (missionPoints) entry.breakdown.push({ label: 'Misiones', points: missionPoints });
    if (entry.streakPoints) entry.breakdown.push({ label: 'Racha', points: entry.streakPoints });
    entry.score = sumPoints(entry.breakdown);
  }
  if (entries.some(({ score }) => !Number.isSafeInteger(Math.round(score * scale)) || score * scale > 9_000_000_000_000)) {
    return { ok: false, errors: ['El total calculado supera el máximo permitido para la precisión del reto.'], warnings };
  }
  entries.sort(compare);
  rank(entries, (entry) => entry.score, (entry, position) => {
    const old = previous?.entries.get(entry.id);
    entry.position = position;
    entry.positionChange = old ? old.position - position : null;
    entry.scoreChange = old ? round(entry.score - old.score) : null;
    entry.weekPoints = round(entry.score - (weekBaseline?.entries.get(entry.id)?.score ?? 0));
    if (entry.positionChange && entry.positionChange > 0) {
      news.push({ text: `${entry.fullName} subió ${entry.positionChange} ${entry.positionChange === 1 ? 'puesto' : 'puestos'}.`, priority: 1 + Math.min(4, entry.positionChange), code: entry.code });
    }
  });
  for (let index = 1, above = entries[0]; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const previousEntry = entries[index - 1]!;
    if (entry.position !== previousEntry.position) above = previousEntry;
    entry.distance = above && entry.position !== above.position ? round(above.score - entry.score) : null;
  }

  const previousTeams = previous?.projection?.teams ?? [];
  const teams = [...groupZones(entries, (entry) => entry.zone)].map(([name, members]): TeamResult => {
    const total = round(members.reduce((sum, entry) => sum + entry.score, 0));
    return { name, total, average: total / members.length, position: 0, change: null, mvpCode: members[0]!.code, count: members.length };
  }).sort((a, b) => b.average - a.average || a.name.localeCompare(b.name, 'es'));
  rank(teams, ({ average }) => average, (team, position) => {
    team.position = position;
    const old = previousTeams.find(({ name }) => team.name === name);
    team.change = old ? old.position - position : null;
  });
  const goalMetric = settings.goalMetric;
  const goalTotal = round(entries.reduce((total, entry) => total + (goalMetric ? entry.metrics[goalMetric] ?? 0 : entry.score), 0));
  return { ok: true, input, entries, warnings, projection: { dataDate: date, goalTotal, teams, missions, duels: calculateDuels(settings, entries, past, date),
    news: news.sort((left, right) => right.priority - left.priority).slice(0, 12) } };
}
