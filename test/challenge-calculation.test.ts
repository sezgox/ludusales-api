import { describe, expect, it } from 'vitest';
import { calculatePublication, type Member, type Publication } from '../src/challenge-calculation';
import { parseChallengeSettings } from '../src/challenge-settings';

const settings = parseChallengeSettings({
  metrics: [
    { key: 'ventas_cerradas', label: 'Ventas', kind: 'sum', integer: true },
    { key: 'ventas_estrategicas', label: 'Producto estratégico', kind: 'sum', integer: true },
    { key: 'encuestas_5_estrellas', label: 'Encuestas', kind: 'sum', integer: true },
    { key: 'satisfaccion_media', label: 'Satisfacción', kind: 'latest', integer: false },
    { key: 'importe_vendido', label: 'Importe vendido', kind: 'sum', integer: false },
  ],
  rules: [
    { metric: 'ventas_cerradas', label: 'Ventas', rate: 10 },
    { metric: 'ventas_estrategicas', label: 'Producto estratégico', rate: 10, multiplier: 1.5 },
    { metric: 'encuestas_5_estrellas', label: 'Encuestas', rate: 5 },
  ],
  minimums: [{ metric: 'satisfaccion_media', operator: '>=', value: 3.5, label: 'Satisfacción mínima de 3,5' }],
  goalMetric: 'importe_vendido',
  tieBreakers: ['ventas_cerradas', 'satisfaccion_media'],
  streak: { length: 3, points: 8 },
  missions: [{ id: 'estrategica', title: 'Objetivo estratégico', description: 'Cierra tres ventas estratégicas', kind: 'all',
    metric: 'ventas_estrategicas', threshold: 3, start: '2026-11-16', end: '2026-11-22', reward: 30, featured: true }],
  badges: [
    { id: 'primera', title: 'Primera venta', description: 'Una venta cerrada', rarity: 'common', points: 5, rule: 'metric', metric: 'ventas_cerradas', threshold: 1, active: true },
    { id: 'umbral', title: 'Resultados destacados', description: '150 puntos', rarity: 'legendary', points: 50, rule: 'points', threshold: 150, active: true },
  ],
  showTeams: true,
});

const bounds = { start: '2026-11-01', end: '2026-11-30', today: '2026-11-26', precision: 0 };
const roster: Member[] = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, code: `demo-${index + 1}`,
  fullName: index === 7 ? 'Marta Ruiz' : `Participante ${index + 1}`, zone: index % 2 ? 'Sur' : 'Norte', active: true }));

function sheet(date: string, marta: [number, number, number], other: number, mode = 'accumulated') {
  return { mode, sourceName: 'demo.xlsx', headers: ['id_participante', 'nombre', 'zona_equipo', 'fecha_datos', ...settings.metrics.map(({ key }) => key)],
    rows: roster.map((member, index) => ({ id_participante: member.code, nombre: member.fullName, zona_equipo: member.zone, fecha_datos: date,
      ventas_cerradas: index === 7 ? marta[0] : index < 5 ? 40 + index + other : 12 + other,
      ventas_estrategicas: index === 7 ? marta[1] : 0, encuestas_5_estrellas: index === 7 ? marta[2] : 0,
      satisfaccion_media: index === 6 ? 3 : 4.2, importe_vendido: 100 * other,
    })) };
}

describe('Excel maestro', () => {
  it('calcula los 278 puntos de Marta en el puesto 6, dos puestos arriba', () => {
    const past: Publication[] = [];
    for (const [date, values, other] of [
      ['2026-11-16', [6, 1, 1], 1], ['2026-11-17', [9, 2, 2], 2], ['2026-11-18', [12, 8, 5], 4],
    ] as const) {
      const publication = calculatePublication(sheet(date, [...values], other), settings, roster, past, bounds);
      expect(publication.ok).toBe(true);
      if (!publication.ok) throw new Error(publication.errors.join('; '));
      past.unshift({ date, entries: new Map(publication.entries.map((entry) => [entry.id, entry])), projection: publication.projection });
    }
    const final = past[0]!;
    const marta = final.entries.get(8)!;
    expect(marta).toMatchObject({ score: 278, position: 6, positionChange: 2, streak: 3, eligible: true,
      breakdown: [{ label: 'Ventas', points: 120 }, { label: 'Producto estratégico', points: 40 }, { label: 'Encuestas', points: 25 },
        { label: 'Insignias', points: 55 }, { label: 'Misiones', points: 30 }, { label: 'Racha', points: 8 }] });
    expect(final.entries.get(7)?.minimumsMissing).toEqual(['Satisfacción mínima de 3,5']);
    expect(final.projection?.goalTotal).toBe(3200);
    expect(final.projection?.teams).toHaveLength(2);
    expect(final.projection?.missions[0]?.winners).toEqual([8]);
  });

  it('bloquea duplicados, participantes desconocidos, satisfacción fuera de rango y correcciones no confirmadas', () => {
    const first = calculatePublication(sheet('2026-11-16', [6, 1, 1], 1), settings, roster, [], bounds);
    if (!first.ok) throw new Error(first.errors.join('; '));
    const past = [{ date: first.projection.dataDate, entries: new Map(first.entries.map((entry) => [entry.id, entry])), projection: first.projection }];
    const input = sheet('2026-11-17', [5, 1, 1], 2);
    const rejected = calculatePublication(input, settings, roster, past, bounds);
    expect(rejected.ok ? [] : rejected.errors).toEqual(expect.arrayContaining([expect.stringContaining('baja de 6 a 5')]));
    expect(calculatePublication({ ...input, allowDecreases: true }, settings, roster, past, bounds).ok).toBe(true);
    const invalid = { ...input, rows: [...input.rows, input.rows[0]!, { ...input.rows[0]!, id_participante: 'otra-empresa' }] };
    invalid.rows[0]!.satisfaccion_media = 6;
    const errors = calculatePublication(invalid, settings, roster, past, bounds);
    expect(errors.ok ? [] : errors.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('Satisfacción'), expect.stringContaining('código repetido'), expect.stringContaining('desconocido'),
    ]));
    const period = calculatePublication(sheet('2026-11-17', [2, 1, 1], 2, 'period'), settings, roster, past, bounds);
    expect(period.ok && period.entries.find(({ id }) => id === 8)?.metrics).toMatchObject({ ventas_cerradas: 8, satisfaccion_media: 4.2 });
  });

  it('lleva a los ganadores de semifinales a la final y conserva un cruce ya cerrado', () => {
    const bracket = (id: string, left: string[], right: string[], leftFrom = '', rightFrom = '') => ({
      id, title: id, round: leftFrom ? 'Final' : 'Semifinal', format: 'solo', left, right, leftFrom, rightFrom,
      metric: 'ventas_cerradas', start: leftFrom ? '2026-11-18' : '2026-11-16', end: leftFrom ? '2026-11-19' : '2026-11-17', stake: '', useZone: false,
    });
    const configured = parseChallengeSettings({ ...settings, showDuels: true, duels: [bracket('a', ['demo-1'], ['demo-2']), bracket('b', ['demo-3'], ['demo-4']), bracket('c', [], [], 'a', 'b')] });
    const first = calculatePublication(sheet('2026-11-17', [6, 1, 1], 1), configured, roster, [], bounds);
    if (!first.ok) throw new Error(first.errors.join('; '));
    expect(first.projection.duels).toMatchObject([{ id: 'a', winner: 'right' }, { id: 'b', winner: 'right' }, { id: 'c', left: ['demo-2'], right: ['demo-4'], status: 'upcoming' }]);
    const previous = [{ date: first.projection.dataDate, entries: new Map(first.entries.map((entry) => [entry.id, entry])), projection: first.projection }];
    const second = calculatePublication(sheet('2026-11-19', [12, 8, 5], 4), configured, roster, previous, bounds);
    if (!second.ok) throw new Error(second.errors.join('; '));
    expect(second.projection.duels[0]).toEqual(first.projection.duels[0]);
    expect(second.projection.duels[2]).toMatchObject({ left: ['demo-2'], right: ['demo-4'], leftScore: 3, rightScore: 3, status: 'closed' });
  });
});
