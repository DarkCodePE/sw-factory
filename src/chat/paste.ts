export type PasteEvent = { type: 'data'; data: Buffer } | { type: 'paste'; text: string } | { type: 'overflow' };
const START = Buffer.from('\x1b[200~'), END = Buffer.from('\x1b[201~');
/** Byte-oriented framing preserves split UTF-8 and escape sequences. Paste never reaches readline as keystrokes. */
export class PasteDecoder {
  private pending = Buffer.alloc(0);
  private pasted: Buffer[] = [];
  private size = 0;
  private inside = false;
  constructor(readonly maxBytes = 256 * 1024) {}
  feed(chunk: Buffer): PasteEvent[] {
    let bytes = Buffer.concat([this.pending, chunk]); this.pending = Buffer.alloc(0);
    const events: PasteEvent[] = [];
    while (bytes.length) {
      const marker = this.inside ? END : START, index = bytes.indexOf(marker);
      if (index >= 0) {
        this.emit(bytes.subarray(0, index), events);
        if (this.inside) {
          events.push(this.size > this.maxBytes ? { type: 'overflow' } : { type: 'paste', text: Buffer.concat(this.pasted).toString('utf8').replace(/\r\n?/g, '\n') });
          this.pasted = []; this.size = 0;
        }
        this.inside = !this.inside; bytes = bytes.subarray(index + marker.length);
      } else {
        let keep = Math.min(marker.length - 1, bytes.length);
        while (keep && !bytes.subarray(bytes.length - keep).equals(marker.subarray(0, keep))) keep--;
        this.emit(bytes.subarray(0, bytes.length - keep), events);
        this.pending = Buffer.from(bytes.subarray(bytes.length - keep)); break;
      }
    }
    return events;
  }
  private emit(data: Buffer, events: PasteEvent[]) {
    if (!data.length) return;
    if (!this.inside) events.push({ type: 'data', data });
    else { this.size += data.length; if (this.size <= this.maxBytes) this.pasted.push(Buffer.from(data)); }
  }
  end(): Buffer {
    const result = this.inside ? Buffer.alloc(0) : this.pending;
    this.pending = Buffer.alloc(0); this.pasted = []; this.size = 0; this.inside = false;
    return result;
  }
}
