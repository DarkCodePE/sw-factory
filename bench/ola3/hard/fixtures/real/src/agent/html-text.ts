/** Linear, non-executing text extraction; deliberately not a browser or full HTML parser. */
export function htmlText(html: string): string {
  const lower = html.replace(/[A-Z]/g, c => c.toLowerCase()), out: string[] = [];
  const blocks = new Set(['p', 'div', 'br', 'hr', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'pre']);
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf('<', i);
    if (start < 0) { out.push(html.slice(i)); break; }
    out.push(html.slice(i, start));
    if (lower.startsWith('<!--', start)) { const end = html.indexOf('-->', start + 4); i = end < 0 ? html.length : end + 3; continue; }
    const name = /^<\/?([a-z][a-z0-9:-]*)\b/i.exec(html.slice(start, start + 128))?.[1]?.toLowerCase();
    if (!name && html[start + 1] !== '!') { out.push('<'); i = start + 1; continue; }
    let end = start + 1, quote = '';
    for (; end < html.length; end++) {
      const ch = html[end]!;
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (end === html.length) break;
    i = end + 1;
    if (['script', 'style'].includes(name ?? '') && html[start + 1] !== '/') {
      let close = lower.indexOf('</' + name, i);
      while (close >= 0 && !/[\s/>]/.test(lower[close + name!.length + 2] ?? '>')) close = lower.indexOf('</' + name, close + 2);
      if (close < 0) break;
      const stop = html.indexOf('>', close); i = stop < 0 ? html.length : stop + 1;
    }
    if (blocks.has(name ?? '')) out.push('\n');
  }
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return out.join('').replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (match, key: string) => {
    if (key[0] !== '#') return entities[key.toLowerCase()] ?? match;
    const n = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
  }).trim();
}
