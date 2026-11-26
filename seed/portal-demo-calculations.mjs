const base = 'http://localhost:8787';
const company = '11000000-0000-4000-8000-000000000014';
const challenge = '11000000-0000-4000-8000-000000000016';
const adminPath = `/superuser/gamifications/${challenge}`;
let cookie = '';

async function request(path, method = 'GET', payload) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${data.error ?? data.errors?.join(' ') ?? response.status}`);
  const session = response.headers.get('set-cookie');
  if (session) cookie = session.split(';', 1)[0];
  return data;
}

function relativeDate(offset) {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

await request('/auth/login', 'POST', { accessCode: 'OWNER-LOCAL-2026' });
const { settings } = await request(`${adminPath}/challenge-settings`);
const { gamification } = await request(`/companies/${company}/gamifications/${challenge}`);
if (settings.rules.length || gamification.challengeInfo?.projection) {
  console.log('La empresa demo ya tiene configuración o publicaciones del Excel maestro.');
  process.exit(0);
}
const { members } = await request(`${adminPath}/challenge-members`);
if (members.length !== 15) throw new Error('Prepara primero la empresa demo con npm run db:seed:portal.');

const metrics = [
  { key: 'ventas_cerradas', label: 'Ventas cerradas', kind: 'sum', integer: true },
  { key: 'ventas_estrategicas', label: 'Producto estratégico', kind: 'sum', integer: true },
  { key: 'encuestas_5_estrellas', label: 'Encuestas de 5 estrellas', kind: 'sum', integer: true },
  { key: 'satisfaccion_media', label: 'Satisfacción', kind: 'latest', integer: false },
  { key: 'importe_vendido', label: 'Ventas en euros', kind: 'sum', integer: false },
];
const dates = [-4, -3, -2].map(relativeDate);
if (dates[0] < gamification.startAt || relativeDate(1) > gamification.endAt) {
  throw new Error('Las fechas de la empresa demo están fuera de su reto activo.');
}
await request(adminPath, 'PATCH', { goal: '30000', goalUnit: '€' });
await request(`${adminPath}/challenge-settings`, 'PUT', {
  ...settings, metrics, goalMetric: 'importe_vendido', showTeams: true,
  hiddenMetrics: ['satisfaccion_media', 'importe_vendido'],
  rules: [
    { metric: 'ventas_cerradas', label: 'Ventas', rate: 10, multiplier: null },
    { metric: 'ventas_estrategicas', label: 'Producto estratégico', rate: 10, multiplier: 1.5 },
    { metric: 'encuestas_5_estrellas', label: 'Encuestas', rate: 5, multiplier: null },
  ],
  minimums: [
    { metric: 'satisfaccion_media', operator: '>=', value: 3.5, label: 'Satisfacción mínima de 3,5' },
    { metric: 'importe_vendido', operator: '>=', value: 300, label: 'Facturación mínima de 300 €' },
  ],
  tieBreakers: ['ventas_cerradas', 'satisfaccion_media'], streak: { length: 3, points: 8 },
  missions: [
    { id: 'estrategica', title: 'Objetivo estratégico', description: 'Cierra tres ventas del producto estratégico.', kind: 'all',
      metric: 'ventas_estrategicas', threshold: 3, start: dates[0], end: relativeDate(1), reward: 30, featured: true },
  ],
  badges: [
    { id: 'primera', title: 'Primera venta', description: 'Cierra tu primera venta del reto.', rarity: 'common', points: 5, rule: 'metric', metric: 'ventas_cerradas', threshold: 1, active: true },
    { id: 'umbral', title: 'Imparable', description: 'Consigue 150 puntos en el reto.', rarity: 'legendary', points: 50, rule: 'points', metric: '', threshold: 150, active: true },
  ],
});

const sample = [[6, 1, 1], [9, 2, 2], [12, 8, 5]];
for (const [index, date] of dates.entries()) {
  const [sales, strategic, surveys] = sample[index];
  const input = {
    sourceName: `demo-${date}.xlsx`, mode: 'accumulated',
    headers: ['id_participante', 'nombre', 'fecha_datos', 'zona_equipo', ...metrics.map(({ key }) => key)],
    rows: members.map((item) => {
      const position = Number(item.code.split('-').at(-1));
      return {
        id_participante: item.code, nombre: item.fullName, zona_equipo: item.zone, fecha_datos: date,
        ventas_cerradas: position === 6 ? sales : position < 6 ? 40 - position + index : position < 9 ? 13 + index * 2 : 16 - position + index,
        ventas_estrategicas: position === 6 ? strategic : 0, encuestas_5_estrellas: position === 6 ? surveys : 0,
        satisfaccion_media: position < 11 ? 4.2 : 3, importe_vendido: (30 - position) * 40 + index * 25,
      };
    }),
  };
  const preview = await request(`${adminPath}/master-preview`, 'POST', { input });
  if (index === dates.length - 1) {
    const marta = preview.entries.find(({ code }) => code === 'portal-06');
    if (marta?.score !== 278 || marta.position !== 6 || marta.positionChange !== 2) throw new Error('La vista previa de Marta no coincide con la especificación.');
  }
  await request(`${adminPath}/master-publications`, 'POST', { input, previewToken: preview.previewToken });
}
console.log('Demo del Excel maestro publicada. Marta Ruiz tiene 278 puntos, puesto 6, subida de 2 puestos.');
