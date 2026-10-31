// Small, dependency-free converters for the Jira text formats used by fab.
type Node = { type: string; text?: string; attrs?: Record<string, unknown>; content?: Node[]; marks?: Node[] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function adfToText(node: unknown): string {
  function render(value: unknown, depth = 0): string {
    if (depth > 100) return '';
    const n = record(value);
    if (!n) return '';
    const children = Array.isArray(n.content) ? n.content : [];
    const content = () => children.map(c => render(c, depth + 1)).join('');
    switch (n.type) {
      case 'text': {
        let text = typeof n.text === 'string' ? n.text : '';
        for (const mark of Array.isArray(n.marks) ? n.marks : []) {
          const m = record(mark);
          if (m?.type === 'code') text = '`' + text + '`';
          const href = record(m?.attrs)?.href;
          if (m?.type === 'link' && typeof href === 'string') text = `[${text}](${href})`;
        }
        return text;
      }
      case 'hardBreak': return '\n';
      case 'paragraph': return content() + '\n\n';
      case 'heading': return content() + '\n\n';
      case 'codeBlock': {
        const attrs = record(n.attrs);
        return '```' + (typeof attrs?.language === 'string' ? attrs.language : '') + '\n' + content() + '\n```\n\n';
      }
      case 'bulletList':
      case 'orderedList': {
        const start = record(n.attrs)?.order;
        return children.map((item, index) => {
          const text = render(item, depth + 1).trim();
          const prefix = n.type === 'orderedList' ? `${typeof start === 'number' ? start + index : index + 1}. ` : '- ';
          return prefix + text.replace(/\n/g, '\n  ') + '\n';
        }).join('') + '\n';
      }
      case 'listItem': return content();
      case 'inlineCard': {
        const url = record(n.attrs)?.url;
        return typeof url === 'string' ? url : '';
      }
      default: return content();
    }
  }
  return render(node).trim();
}

function inline(text: string): Node[] {
  const nodes: Node[] = [];
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > offset) nodes.push({ type: 'text', text: text.slice(offset, match.index) });
    nodes.push(match[1] !== undefined
      ? { type: 'text', text: match[1], marks: [{ type: 'code' }] }
      : { type: 'text', text: match[2]!, marks: [{ type: 'link', attrs: { href: match[3]! } }] });
    offset = match.index! + match[0].length;
  }
  if (offset < text.length) nodes.push({ type: 'text', text: text.slice(offset) });
  return nodes;
}

export function markdownToAdf(md: string): unknown {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  const bullet = (line: string) => /^(\s*)-\s+(.*)$/.exec(line);
  function list(indent: number): Node {
    const items: Node[] = [];
    while (index < lines.length) {
      const item = bullet(lines[index]!);
      if (!item || item[1]!.length !== indent) break;
      index++;
      const content: Node[] = [{ type: 'paragraph', content: inline(item[2]!) }];
      while (index < lines.length) {
        const nested = bullet(lines[index]!);
        if (!nested || nested[1]!.length <= indent) break;
        content.push(list(nested[1]!.length));
      }
      items.push({ type: 'listItem', content });
    }
    return { type: 'bulletList', content: items };
  }
  const content: Node[] = [];
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    const fence = /^\s*```([^`]*)$/.exec(line);
    if (fence) {
      index++;
      const code: string[] = [];
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) code.push(lines[index++]!);
      if (index < lines.length) index++;
      content.push({ type: 'codeBlock', ...(fence[1]!.trim() ? { attrs: { language: fence[1]!.trim() } } : {}), content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      content.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: inline(heading[2]!) });
      index++;
      continue;
    }
    const item = bullet(line);
    if (item) { content.push(list(item[1]!.length)); continue; }
    const paragraph: Node[] = [];
    do {
      if (paragraph.length) paragraph.push({ type: 'hardBreak' });
      paragraph.push(...inline(lines[index++]!));
    } while (index < lines.length && lines[index]!.trim() && !/^(#{1,6})\s|^\s*```/.test(lines[index]!) && !bullet(lines[index]!));
    content.push({ type: 'paragraph', content: paragraph });
  }
  return { version: 1, type: 'doc', content };
}
