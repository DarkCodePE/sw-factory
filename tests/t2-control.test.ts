import { expect, test } from 'bun:test';
import { validarControl } from '../bench/t2-control/validate.ts';
test('perfil control solo cambia pasos 2–3 con longitud dentro de ±5 %', () => {
  const result = validarControl();
  expect(result.ratio).toBeGreaterThanOrEqual(0.95);
  expect(result.ratio).toBeLessThanOrEqual(1.05);
});
