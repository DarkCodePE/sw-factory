export type Channel = 'stable' | 'prerelease';
export function parseVersion(value: string) {
  const match = value.length <= 120 && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if (!match) throw new Error('Versión SemVer inválida');
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(p => /^\d+$/.test(p) && p.length > 1 && p.startsWith('0'))) throw new Error('Versión SemVer inválida');
  return { value: value.replace(/^v/, ''), core: match.slice(1, 4).map(n => BigInt(n!)), pre };
}
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a), right = parseVersion(b);
  const cmp = (x: bigint | string, y: bigint | string) => x < y ? -1 : x > y ? 1 : 0;
  for (let i = 0; i < 3; i++) { const result = cmp(left.core[i]!, right.core[i]!); if (result) return result; }
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    const result = xn && yn ? cmp(BigInt(x), BigInt(y)) : xn !== yn ? xn ? -1 : 1 : cmp(x, y);
    if (result) return result;
  }
  return 0;
}
export function updateChannel(current: string, selected?: string): Channel {
  if (selected !== undefined && selected !== 'stable' && selected !== 'prerelease') throw new Error('Canal inválido: usa stable o prerelease');
  return selected ?? (parseVersion(current).pre.length ? 'prerelease' : 'stable');
}
