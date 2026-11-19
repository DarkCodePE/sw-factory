import { expect, test } from 'bun:test';
import { lastDue, parseCron } from '../src/cron.ts';

const at = (s: string) => new Date(`${s}Z`);
const iso = (d: Date | null) => d?.toISOString() ?? null;

test('A4: rechaza horarios inválidos nombrando el campo', () => {
  const casos: [string, RegExp][] = [
    ['30 7 * * * *', /cinco campos/],
    ['60 7 * * *', /minuto/],
    ['* 7 * * *', /minuto/],
    ['*/5 7 * * *', /minuto/],
    ['30 9-7 * * *', /hora/],
    ['30 7 * * MON', /día de la semana/],
    ['', /cinco campos/],
  ];
  for (const [expr, campo] of casos) expect(() => parseCron(expr), expr).toThrow(campo);
});

test('rechaza fuera de rango, pasos nulos y listas vacías', () => {
  expect(() => parseCron('0 24 * * *')).toThrow(/hora/);
  expect(() => parseCron('0 7 0 * *')).toThrow(/día del mes/);
  expect(() => parseCron('0 7 * 13 *')).toThrow(/mes/);
  expect(() => parseCron('0 7 * * 7')).toThrow(/día de la semana/);
  expect(() => parseCron('0 */0 * * *')).toThrow(/hora/);
  expect(() => parseCron('0 7,, * * *')).toThrow(/hora/);
});

test('diario: el instante límite 07:29, 07:30 y 07:31', () => {
  const c = parseCron('30 7 * * *');
  const floor = at('2026-01-01T00:00:00');
  expect(iso(lastDue(c, floor, at('2026-03-10T07:29:00')))).toBe('2026-03-09T07:30:00.000Z');
  expect(iso(lastDue(c, floor, at('2026-03-10T07:30:00')))).toBe('2026-03-10T07:30:00.000Z');
  expect(iso(lastDue(c, floor, at('2026-03-10T07:31:00')))).toBe('2026-03-10T07:30:00.000Z');
});

test('semanal: lunes 07:30', () => {
  const c = parseCron('30 7 * * 1');
  // 2026-03-10 es martes; el lunes anterior es el 9.
  expect(iso(lastDue(c, at('2026-01-01T00:00:00'), at('2026-03-10T12:00:00')))).toBe('2026-03-09T07:30:00.000Z');
});

test('mensual: día 15', () => {
  const c = parseCron('0 6 15 * *');
  expect(iso(lastDue(c, at('2026-01-01T00:00:00'), at('2026-03-10T12:00:00')))).toBe('2026-02-15T06:00:00.000Z');
});

test('lista de horas y paso en horas', () => {
  expect(iso(lastDue(parseCron('0 6,18 * * *'), at('2026-01-01T00:00:00'), at('2026-03-10T12:00:00')))).toBe('2026-03-10T06:00:00.000Z');
  expect(iso(lastDue(parseCron('15 */6 * * *'), at('2026-01-01T00:00:00'), at('2026-03-10T17:00:00')))).toBe('2026-03-10T12:15:00.000Z');
  expect(iso(lastDue(parseCron('0 8-10/2 * * *'), at('2026-01-01T00:00:00'), at('2026-03-10T23:00:00')))).toBe('2026-03-10T10:00:00.000Z');
});

test('cada hora: el minuto fijo de la hora en curso o la anterior', () => {
  const c = parseCron('15 * * * *');
  expect(iso(lastDue(c, at('2026-01-01T00:00:00'), at('2026-03-10T12:14:59')))).toBe('2026-03-10T11:15:00.000Z');
  expect(iso(lastDue(c, at('2026-01-01T00:00:00'), at('2026-03-10T12:15:00')))).toBe('2026-03-10T12:15:00.000Z');
});

test('día del mes y de la semana restringidos: casa si casa cualquiera', () => {
  const c = parseCron('0 6 13 * 5'); // día 13 o viernes
  const floor = at('2026-01-01T00:00:00');
  // 2026-03-13 es viernes y 13; el viernes 6 casa sin ser 13; el sábado 7 no.
  expect(iso(lastDue(c, floor, at('2026-03-07T12:00:00')))).toBe('2026-03-06T06:00:00.000Z');
  expect(iso(lastDue(c, floor, at('2026-02-14T12:00:00')))).toBe('2026-02-13T06:00:00.000Z');
  expect(iso(lastDue(c, floor, at('2026-03-12T12:00:00')))).toBe('2026-03-06T06:00:00.000Z');
});

test('floor posterior al último vencimiento: null; floor igual al vencimiento también', () => {
  const c = parseCron('30 7 * * *');
  expect(lastDue(c, at('2026-03-10T07:31:00'), at('2026-03-10T20:00:00'))).toBeNull();
  expect(lastDue(c, at('2026-03-10T07:30:00'), at('2026-03-10T20:00:00'))).toBeNull();
});

test('sin vencimiento en 366 días: null', () => {
  expect(lastDue(parseCron('0 0 30 2 *'), at('2020-01-01T00:00:00'), at('2026-03-10T00:00:00'))).toBeNull();
});
