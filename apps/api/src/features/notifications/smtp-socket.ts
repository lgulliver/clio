import { type SetKeepAliveOptions, Socket } from 'node:net';

type Done = (error?: Error | null) => void;

/**
 * Owned socket handed to Nodemailer's public `getSocket` hook. It wraps an already-verified
 * (TLS) or loopback upstream and enforces a cumulative decoded-reply budget BEFORE any byte is
 * pushed to the reader, which a late 'data' listener cannot do. The upstream is kept in a
 * private field: a public `socket` property would make Nodemailer unwrap and bypass this guard.
 *
 * Writes are forwarded in order with the upstream's own backpressure (the Writable callback is
 * only completed once the upstream has accepted the bytes), corked batches stay one write, and
 * timeouts, keep-alive, no-delay, end and destroy are delegated.
 */
export class BudgetedSmtpSocket extends Socket {
  readonly #upstream: Socket;
  readonly #limit: number;
  #received = 0;
  #overBudget = false;
  #dataCommandSent = false;
  #malformed = false;
  #tail = '';
  #replyCode: string | null = null;

  constructor(upstream: Socket, maximumReplyBytes: number) {
    super();
    this.#upstream = upstream;
    this.#limit = maximumReplyBytes;
    // Errors raised before Nodemailer attaches its handlers must not become uncaught exceptions.
    this.on('error', () => {});
    upstream.on('data', (chunk: Buffer | string) => this.#receive(chunk));
    upstream.on('end', () => this.push(null));
    upstream.on('error', (error: Error) => this.destroy(error));
    upstream.on('close', () => this.destroy());
    upstream.on('timeout', () => this.emit('timeout'));
    if (upstream.destroyed) queueMicrotask(() => this.destroy());
  }

  /** True once the cumulative reply budget was exceeded and the connection was terminated. */
  get overBudget(): boolean {
    return this.#overBudget;
  }
  /** True once a DATA command has been written, i.e. a message may have been submitted. */
  get dataCommandSent(): boolean {
    return this.#dataCommandSent;
  }

  /** True once the server sent syntactically invalid or inconsistent reply lines. */
  get malformed(): boolean {
    return this.#malformed;
  }

  /** Validates one complete reply line: `ddd` + (' ' | '-') + RFC 5321 textstring, one code per reply. */
  #validLine(line: string): boolean {
    const code = line.slice(0, 3);
    if (!/^[2-5][0-9]{2}$/.test(code)) return false;
    const separator = line.charAt(3);
    if (line.length > 3 && separator !== ' ' && separator !== '-') return false;
    // textstring = HTAB / SP / %d33-126, i.e. byte 9 or 32..126 (RFC 5321 section 4.2).
    for (let index = 4; index < line.length; index += 1) {
      const byte = line.charCodeAt(index);
      if (byte !== 9 && (byte < 32 || byte > 126)) return false;
    }
    if (this.#replyCode !== null && this.#replyCode !== code) return false;
    this.#replyCode = separator === '-' ? code : null;
    return true;
  }
  #fail(): void {
    this.#malformed = true;
    this.#upstream.destroy();
    this.destroy(new Error('SMTP reply malformed'));
  }

  #receive(chunk: Buffer | string): void {
    if (this.destroyed) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    if (this.#received + bytes.length > this.#limit) {
      this.#overBudget = true;
      this.#upstream.destroy();
      this.destroy(new Error('SMTP reply budget exceeded'));
      return;
    }
    this.#received += bytes.length;
    // Only complete, validated lines reach Nodemailer; an unterminated tail is held back so its
    // permissive parser can never act on (or synthesize a reply from) unvalidated bytes.
    this.#tail += bytes.toString('latin1');
    const end = this.#tail.lastIndexOf('\r\n');
    if (end < 0) {
      if (/[\r\n]/.test(this.#tail.replace(/\r$/, ''))) this.#fail();
      return;
    }
    const complete = this.#tail.slice(0, end + 2);
    this.#tail = this.#tail.slice(end + 2);
    if (/\r(?!\n)|(?<!\r)\n/.test(complete) || /[\r\n]/.test(this.#tail.replace(/\r$/, ''))) {
      this.#fail();
      return;
    }
    for (const line of complete.slice(0, -2).split('\r\n')) {
      if (!this.#validLine(line)) {
        this.#fail();
        return;
      }
    }
    if (!this.push(Buffer.from(complete, 'latin1'))) this.#upstream.pause();
  }
  #observe(bytes: Buffer): void {
    if (!this.#dataCommandSent && /(?:^|\n)DATA\r\n/.test(bytes.toString('latin1')))
      this.#dataCommandSent = true;
  }
  #forward(bytes: Buffer, callback: Done): void {
    if (this.#upstream.destroyed) {
      callback(new Error('SMTP connection closed'));
      return;
    }
    this.#observe(bytes);
    this.#upstream.write(bytes, (error) => callback(error ?? null));
  }

  override _read(): void {
    this.#upstream.resume();
  }
  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: Done): void {
    this.#forward(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk, callback);
  }
  override _writev(
    chunks: ReadonlyArray<{ chunk: Buffer | string; encoding: BufferEncoding }>,
    callback: Done,
  ): void {
    this.#forward(
      Buffer.concat(
        chunks.map(({ chunk, encoding }) =>
          typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk,
        ),
      ),
      callback,
    );
  }
  override _final(callback: Done): void {
    if (this.#upstream.destroyed || this.#upstream.writableEnded) {
      callback();
      return;
    }
    this.#upstream.end(() => callback());
  }
  override _destroy(error: Error | null, callback: Done): void {
    this.#upstream.destroy();
    callback(error);
    // net.Socket disables automatic 'close' (its handle normally emits it); Nodemailer relies on it.
    process.nextTick(() => this.emit('close', error !== null));
  }

  override setTimeout(timeout: number, callback?: () => void): this {
    if (callback !== undefined) this.once('timeout', callback);
    this.#upstream.setTimeout(timeout);
    return this;
  }
  override setKeepAlive(options: SetKeepAliveOptions): this;
  override setKeepAlive(
    enable?: boolean,
    initialDelay?: number,
    interval?: number,
    count?: number,
  ): this;
  override setKeepAlive(
    first?: boolean | SetKeepAliveOptions,
    initialDelay?: number,
    interval?: number,
    count?: number,
  ): this {
    if (typeof first === 'object') this.#upstream.setKeepAlive(first);
    else this.#upstream.setKeepAlive(first, initialDelay, interval, count);
    return this;
  }
  override setNoDelay(noDelay?: boolean): this {
    this.#upstream.setNoDelay(noDelay);
    return this;
  }
}
