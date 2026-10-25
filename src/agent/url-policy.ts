import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { abortable } from './cancellation.ts';

export function httpUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw new Error('FetchUrl requires a URL of at most 8192 characters without whitespace');
  let url: URL; try { url = new URL(value); } catch { throw new Error('Invalid FetchUrl URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('FetchUrl accepts only http(s) URLs without userinfo credentials');
  return url;
}
function publicV4(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
    a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) return publicV4(address);
  if (isIP(address) !== 6) return false;
  let ip = address.toLowerCase();
  if (ip.includes('.')) {
    const start = ip.lastIndexOf(':'), tail = ip.slice(start + 1).split('.').map(Number);
    ip = ip.slice(0, start + 1) + ((tail[0]! << 8) | tail[1]!).toString(16) + ':' + ((tail[2]! << 8) | tail[3]!).toString(16);
  }
  const [left, right] = ip.split('::'), head = left ? left.split(':') : [], end = right ? right.split(':') : [];
  const words = (right !== undefined ? [...head, ...Array(8 - head.length - end.length).fill('0'), ...end] : head).map(s => parseInt(s, 16));
  if (words.slice(0, 5).every(n => n === 0) && words[5] === 0xffff)
    return publicV4([words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255].join('.'));
  // Conservative global unicast only, excluding transition and special/documentation ranges.
  return (words[0]! & 0xe000) === 0x2000 && words[0] !== 0x2002 &&
    !(words[0] === 0x2001 && (words[1]! <= 0x1ff || words[1] === 0xdb8));
}
export type PinnedAddress = { address: string; family: number };
export type ResolveAddresses = (hostname: string, options: { all: true; verbatim: true }) => Promise<PinnedAddress[]>;
export async function pinAddress(url: URL, allowPrivate: boolean, signal: AbortSignal, resolve: ResolveAddresses = lookup): Promise<PinnedAddress> {
  return (await pinAddresses(url, allowPrivate, signal, resolve))[0]!;
}
/** Every resolved address, in resolver order, after all of them passed the destination policy. */
export async function pinAddresses(url: URL, allowPrivate: boolean, signal: AbortSignal, resolve: ResolveAddresses = lookup): Promise<PinnedAddress[]> {
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await abortable(resolve(hostname, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(a => !isIP(a.address) || !allowPrivate && !publicAddress(a.address))) throw new Error('FetchUrl rejects private, local or reserved destinations');
  return addresses;
}
