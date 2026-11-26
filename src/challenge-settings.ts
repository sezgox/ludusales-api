export type Metric = { key: string; label: string; kind: 'sum' | 'latest' | 'max'; integer: boolean };
export type PointRule = { metric: string; label: string; rate: number; multiplier: number | null };
export type Minimum = { metric: string; operator: '>=' | '<='; value: number; label: string };
export type ImportMode = 'accumulated' | 'period';
export type Mission = {
  id: string;
  title: string;
  description: string;
  kind: 'first' | 'most' | 'all' | 'collective' | 'zones';
  metric: string;
  threshold: number;
  start: string;
  end: string;
  reward: number;
  featured: boolean;
};
export type Badge = {
  id: string;
  title: string;
  description: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  points: number;
  rule: 'metric' | 'points' | 'streak' | 'position' | 'climb' | 'minimums' | 'missions';
  metric: string;
  threshold: number;
  active: boolean;
};
export type Duel = {
  id: string; title: string; round: string; format: 'solo' | 'pairs'; left: string[]; right: string[];
  leftFrom: string; rightFrom: string; metric: string; start: string; end: string; stake: string; useZone: boolean;
};

export type ChallengeSettings = {
  metrics: Metric[];
  rules: PointRule[];
  minimums: Minimum[];
  tieBreakers: string[];
  streak: { length: number; points: number } | null;
  goalMetric: string | null;
  missions: Mission[];
  badges: Badge[];
  duels: Duel[];
  mode: ImportMode;
  columns: Record<string, string>;
  showTeams: boolean;
  showDuels: boolean;
  showPhotos: boolean;
  anonymousFrom: number | null;
  hiddenMetrics: string[];
  tvInterval: number;
  tvLimit: number;
  updateDays: number[];
};

export const emptySettings: ChallengeSettings = {
  metrics: [], rules: [], minimums: [], tieBreakers: [], streak: null, goalMetric: null, missions: [], badges: [], duels: [],
  mode: 'accumulated', columns: {}, showTeams: false, showDuels: false, showPhotos: true, anonymousFrom: null, hiddenMetrics: [], tvInterval: 9, tvLimit: 10, updateDays: [],
};

const colors = ['common', 'rare', 'epic', 'legendary'] as const;
const missionKinds = ['first', 'most', 'all', 'collective', 'zones'] as const;
const badgeRules = ['metric', 'points', 'streak', 'position', 'climb', 'minimums', 'missions'] as const;
const keyPattern = /^[a-z][a-z0-9_]{0,47}$/;

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function string(raw: unknown, label: string, limit = 160): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > limit) throw new Error(`${label} no válido.`);
  return raw.trim();
}

function decimal(raw: unknown, label: string, max = 1_000_000_000): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > max) throw new Error(`${label} no válido.`);
  return raw;
}

function whole(raw: unknown, label: string, minimum: number, maximum: number): number {
  const value = decimal(raw, label, maximum);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${label} no válido.`);
  return value;
}

function oneOf<T extends string>(raw: unknown, options: readonly T[], label: string): T {
  const option = options.find((value) => value === raw);
  if (!option) throw new Error(`${label} no válido.`);
  return option;
}

function list(raw: unknown, label: string, limit: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > limit) throw new Error(`${label} admite un máximo de ${limit} elementos.`);
  return raw;
}

function object(raw: unknown, label: string): Record<string, unknown> {
  const item = record(raw);
  if (!item) throw new Error(`${label} no válido.`);
  return item;
}

function boolean(raw: unknown, label: string): boolean {
  if (typeof raw !== 'boolean') throw new Error(`${label} no válido.`);
  return raw;
}

function unique(items: string[], label: string): void {
  if (new Set(items).size !== items.length) throw new Error(`${label} contiene valores repetidos.`);
}

export function parseChallengeSettings(raw: unknown): ChallengeSettings {
  const body = { ...emptySettings, ...object(raw, 'Configuración') };
  const metrics = list(body.metrics, 'Métricas', 30).map((raw): Metric => {
    const { key, label, kind, integer } = object(raw, 'Métrica');
    if (typeof key !== 'string' || !keyPattern.test(key) || ['constructor', 'prototype', 'nombre', 'fecha_datos', 'id_participante', 'zona_equipo'].includes(key)) {
      throw new Error('Las claves de métricas deben empezar por letra y usar minúsculas, números o guion bajo.');
    }
    return { key, label: string(label, 'Nombre de la métrica'), kind: oneOf(kind, ['sum', 'latest', 'max'], 'Acumulación'), integer: boolean(integer, 'Valor entero') };
  });
  unique(metrics.map(({ key }) => key), 'Claves de métricas');
  unique(['zona', ...metrics.map(({ label }) => label.toLocaleLowerCase('es'))], 'Etiquetas de métricas');
  const metric = (raw: unknown): string => {
    const found = metrics.find(({ key }) => key === raw);
    if (!found) throw new Error(`Métrica no definida: ${typeof raw === 'string' ? raw : 'sin asignar'}.`);
    return found.key;
  };
  const rules = list(body.rules, 'Reglas de puntos', 40).map((raw): PointRule => {
    const { metric: key, label, rate, multiplier } = object(raw, 'Regla de puntos');
    const bonus = multiplier == null ? null : decimal(multiplier, 'Multiplicador', 1000);
    if (bonus !== null && bonus < 1) throw new Error('El multiplicador de un bonus debe ser mayor o igual que 1.');
    return { metric: metric(key), label: string(label, 'Descripción de la regla'), rate: decimal(rate, 'Puntos por unidad'), multiplier: bonus };
  });
  const minimums = list(body.minimums, 'Mínimos', 30).map((raw): Minimum => {
    const { metric: key, operator, value, label } = object(raw, 'Mínimo');
    return { metric: metric(key), operator: oneOf(operator, ['>=', '<='], 'Operador'), value: decimal(value, 'Umbral'), label: string(label, 'Motivo visible') };
  });
  const streak = body.streak === null ? null : object(body.streak, 'Bonus de racha');
  const tieBreakers = list(body.tieBreakers, 'Desempates', 10).map(metric);
  unique(tieBreakers, 'Desempates');
  const missionIds: string[] = [];
  const missions = list(body.missions, 'Misiones', 40).map((raw): Mission => {
    const { id, title, description, kind, metric: key, threshold, start, end, reward, featured } = object(raw, 'Misión');
    if (!validDate(start) || !validDate(end) || start > end) throw new Error('Fechas de misión no válidas.');
    const identifier = string(id, 'Identificador');
    missionIds.push(identifier);
    return { id: identifier, title: string(title, 'Título'), description: string(description, 'Objetivo', 600),
      kind: oneOf(kind, missionKinds, 'Tipo de misión'), metric: metric(key), threshold: decimal(threshold, 'Umbral'),
      start, end, reward: decimal(reward, 'Recompensa'), featured: boolean(featured, 'Destacar') };
  });
  unique(missionIds, 'Misiones');
  const badges = list(body.badges, 'Insignias', 60).map((raw): Badge => {
    const item = object(raw, 'Insignia');
    const rule = oneOf(item['rule'], badgeRules, 'Regla de insignia');
    return { id: string(item['id'], 'Identificador'), title: string(item['title'], 'Nombre'), description: string(item['description'], 'Descripción', 600),
      rarity: oneOf(item['rarity'], colors, 'Rareza'), points: decimal(item['points'], 'Puntos'), rule,
      metric: rule === 'metric' ? metric(item['metric']) : '', threshold: decimal(item['threshold'], 'Umbral'), active: boolean(item['active'], 'Activa') };
  });
  unique(badges.map(({ id }) => id), 'Insignias');
  const bracket = new Map<string, Duel>();
  const sources = new Set<string>();
  for (const raw of list(body.duels, 'Enfrentamientos', 40)) {
    const item = object(raw, 'Enfrentamiento');
    const { start, end } = item;
    if (!validDate(start) || !validDate(end) || start > end) throw new Error('Fechas de enfrentamiento no válidas.');
    const id = string(item['id'], 'Identificador del enfrentamiento');
    if (bracket.has(id)) throw new Error('Los identificadores de enfrentamiento deben ser únicos.');
    const format = oneOf(item['format'], ['solo', 'pairs'], 'Formato');
    const size = format === 'solo' ? 1 : 2;
    const parseSide = (side: 'left' | 'right') => {
      const reference = item[`${side}From`] ? string(item[`${side}From`], 'Cruce anterior') : '';
      const members = list(item[side], 'Participantes del lado', 2).map((code) => string(code, 'Código de participante', 128));
      if (reference) {
        const previous = bracket.get(reference);
        if (!previous || previous.format !== format || previous.end > start || members.length || sources.has(reference)) {
          throw new Error('El cruce anterior debe figurar antes en el cuadro, tener el mismo formato y alimentar un solo lado.');
        }
        sources.add(reference);
      } else if (members.length !== size) throw new Error(`Cada lado necesita ${size} participante(s) o un cruce anterior.`);
      return { reference, members };
    };
    const left = parseSide('left');
    const right = parseSide('right');
    unique([...left.members, ...right.members], 'Participantes del enfrentamiento');
    bracket.set(id, { id, title: string(item['title'], 'Título'), round: string(item['round'], 'Ronda'), format,
      left: left.members, right: right.members, leftFrom: left.reference, rightFrom: right.reference, metric: metric(item['metric']),
      start, end, stake: item['stake'] ? string(item['stake'], 'Apuesta', 600) : '', useZone: boolean(item['useZone'], 'Usar métricas de zona') });
  }
  const mapping = object(body.columns, 'Mapeo del Excel');
  const allowedColumns = new Set(['id_participante', 'nombre', 'fecha_datos', 'zona_equipo', ...metrics.map(({ key }) => key)]);
  const columns = Object.fromEntries(Object.entries(mapping).filter(([key]) => allowedColumns.has(key))
    .map(([key, value]) => [key, string(value, 'Cabecera del Excel', 80)]));
  unique([...allowedColumns].map((key) => (columns[key] ?? key).toLocaleLowerCase('es')), 'Mapeo del Excel');

  return { metrics, rules, minimums, tieBreakers, missions, badges, columns, duels: [...bracket.values()],
    streak: streak ? { length: whole(streak['length'], 'Longitud de racha', 1, 50), points: decimal(streak['points'], 'Bonus de racha') } : null,
    goalMetric: body.goalMetric === null ? null : metric(body.goalMetric),
    mode: oneOf(body.mode, ['accumulated', 'period'], 'Modo de importación'),
    showTeams: boolean(body.showTeams, 'Mostrar equipos'), showDuels: boolean(body.showDuels, 'Mostrar enfrentamientos'), showPhotos: boolean(body.showPhotos, 'Mostrar fotos'),
    anonymousFrom: body.anonymousFrom === null ? null : whole(body.anonymousFrom, 'Puesto de anonimización', 1, 1000),
    hiddenMetrics: list(body.hiddenMetrics, 'Métricas sensibles', 30).map(metric),
    tvInterval: whole(body.tvInterval, 'Intervalo de TV', 3, 120),
    tvLimit: whole(body.tvLimit, 'Número de personas en TV', 3, 100),
    updateDays: [...new Set(list(body.updateDays, 'Días de actualización', 7).map((raw) => whole(raw, 'Día de la semana', 1, 7)))],
  };
}
