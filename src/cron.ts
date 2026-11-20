// Horario de las automations (T68a): subconjunto de cron de cinco campos, en UTC y sin dependencias.
// Puro: no lee el reloj, `lastDue` recibe `now`. El minuto es un único número, así que nada vence más de una vez por hora.
export type Cron = {
  minute: number;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
};

const FIELDS = [
  { name: 'minuto', min: 0, max: 59 },
  { name: 'hora', min: 0, max: 23 },
  { name: 'día del mes', min: 1, max: 31 },
  { name: 'mes', min: 1, max: 12 },
  { name: 'día de la semana', min: 0, max: 6 },
] as const;

const num = (s: string, name: string, min: number, max: number): number => {
  if (!/^\d{1,2}$/.test(s)) throw new Error(`cron: el campo ${name} no admite «${s}»`);
  const n = Number(s);
  if (n < min || n > max) throw new Error(`cron: el campo ${name} debe estar entre ${min} y ${max}, no «${s}»`);
  return n;
};

const field = (raw: string, name: string, min: number, max: number): Set<number> => {
  const out = new Set<number>();
  for (const item of raw.split(',')) {
    const [range = '', step, extra] = item.split('/');
    if (extra !== undefined || step === '') throw new Error(`cron: el campo ${name} tiene un paso inválido en «${item}»`);
    const n = step === undefined ? 1 : num(step, name, 1, max);
    let lo: number, hi: number;
    if (range === '*') [lo, hi] = [min, max];
    else if (range.includes('-')) {
      const [a = '', b = '', more] = range.split('-');
      if (more !== undefined) throw new Error(`cron: el campo ${name} tiene un rango inválido en «${item}»`);
      [lo, hi] = [num(a, name, min, max), num(b, name, min, max)];
      if (lo > hi) throw new Error(`cron: el campo ${name} tiene un rango invertido en «${item}»`);
    } else {
      lo = num(range, name, min, max);
      hi = step === undefined ? lo : max; // «a/n» = desde a hasta el máximo
    }
    for (let v = lo; v <= hi; v += n) out.add(v);
  }
  return out;
};

export const parseCron = (expr: string): Cron => {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === '') throw new Error('cron: se esperan cinco campos (minuto hora día-del-mes mes día-de-la-semana)');
  const [minute, hours, days, months, weekdays] = parts as [string, string, string, string, string];
  return {
    minute: num(minute, FIELDS[0].name, FIELDS[0].min, FIELDS[0].max),
    hours: field(hours, FIELDS[1].name, FIELDS[1].min, FIELDS[1].max),
    days: field(days, FIELDS[2].name, FIELDS[2].min, FIELDS[2].max),
    months: field(months, FIELDS[3].name, FIELDS[3].min, FIELDS[3].max),
    weekdays: field(weekdays, FIELDS[4].name, FIELDS[4].min, FIELDS[4].max),
    daysRestricted: !days.startsWith('*'),
    weekdaysRestricted: !weekdays.startsWith('*'),
  };
};

const HOUR = 3_600_000;
const MAX_HOURS = 366 * 24;

// Instante programado más reciente con floor < t ≤ now (UTC), o null. Recorre hacia atrás hora a hora.
export const lastDue = (cron: Cron, floor: Date, now: Date): Date | null => {
  let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), cron.minute);
  if (t > now.getTime()) t -= HOUR;
  for (let i = 0; i < MAX_HOURS && t > floor.getTime(); i++, t -= HOUR) {
    const d = new Date(t);
    if (!cron.hours.has(d.getUTCHours()) || !cron.months.has(d.getUTCMonth() + 1)) continue;
    const day = cron.days.has(d.getUTCDate());
    const weekday = cron.weekdays.has(d.getUTCDay());
    if (cron.daysRestricted && cron.weekdaysRestricted ? day || weekday : day && weekday) return d;
  }
  return null;
};

/** Atajos de §2.4 → expresión cron (UTC). */
export function scheduleExpr(v: { cron?: string; every?: string; at?: string; weekday?: string }): string {
  if (v.cron !== undefined) {
    if (v.every || v.at || v.weekday) throw new Error('--cron no se combina con --every, --at ni --weekday');
    return v.cron;
  }
  const num = (s: string, what: string, max: number) => {
    if (!/^\d{1,2}$/.test(s) || Number(s) > max) throw new Error(`${what} inválido: «${s}»`);
    return Number(s);
  };
  if (v.every === 'hour') {
    const m = /^:(\d{1,2})$/.exec(v.at ?? '');
    if (!m || v.weekday !== undefined) throw new Error('--every hour pide --at :MM y no admite --weekday');
    return `${num(m[1]!, 'minuto', 59)} * * * *`;
  }
  if (v.every !== 'day' && v.every !== 'week') throw new Error('indica --cron o --every hour|day|week');
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.at ?? '');
  if (!m) throw new Error(`--every ${v.every} pide --at HH:MM`);
  const hm = `${num(m[2]!, 'minuto', 59)} ${num(m[1]!, 'hora', 23)}`;
  if (v.every === 'day') {
    if (v.weekday !== undefined) throw new Error('--weekday solo va con --every week');
    return `${hm} * * *`;
  }
  if (v.weekday === undefined) throw new Error('--every week pide --weekday 0-6 (domingo 0)');
  return `${hm} * * ${num(v.weekday, 'día de la semana', 6)}`;
}
