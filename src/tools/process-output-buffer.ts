import { StringDecoder } from "node:string_decoder";

export type ProcessOutputStream = "stdout" | "stderr";
export type ProcessOutputChunk = Readonly<{
  sequence: number;
  stream: ProcessOutputStream;
  text: string;
}>;

export type ProcessOutputRead = Readonly<{
  entries: readonly ProcessOutputChunk[];
  nextSequence: number;
  truncated: boolean;
}>;

export type ProcessOutputOptions = Readonly<{
  /** Foreground capture cap shared between stdout and stderr. */
  maxOutputBytes?: number;
  /** Incremental log retention for managed background sessions. */
  maxBufferedChunks?: number;
  maxChunkBytes?: number;
}>;

/**
 * Shared output collection. Policy is configured by the caller:
 * - foreground run: bounded byte capture, overflow requests termination;
 * - long-lived session: bounded, cursor-addressable UTF-8 chunk history.
 *
 * This component deliberately never sends process signals.
 */
export class ProcessOutputBuffer {
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];
  private readonly records: ProcessOutputChunk[] = [];
  private readonly decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  private storedBytes = 0;
  private sequence = 0;
  private finished = false;
  private truncatedOutput = false;

  constructor(private readonly options: ProcessOutputOptions = {}) {
    for (const [name, value] of Object.entries(options)) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new RangeError(name + " must be a positive integer");
      }
    }
  }

  /** @returns true exactly when the foreground byte limit is first exceeded. */
  append(stream: ProcessOutputStream, chunk: Buffer): boolean {
    if (this.finished) return false;

    if (this.options.maxBufferedChunks !== undefined) {
      const chunkSize = this.options.maxChunkBytes ?? 8192;
      for (let offset = 0; offset < chunk.length; offset += chunkSize) {
        this.appendText(stream, this.decoders[stream].write(chunk.subarray(offset, offset + chunkSize)));
      }
    }

    const maxBytes = this.options.maxOutputBytes;
    if (maxBytes === undefined) return false;

    const available = Math.max(0, maxBytes - this.storedBytes);
    if (available > 0) {
      const taken = chunk.subarray(0, available);
      // Copy the retained slice: Buffer.subarray() aliases the full incoming\n      // chunk and could accidentally keep a huge allocation alive.\n      (stream === "stdout" ? this.stdout : this.stderr).push(Buffer.from(taken));
      this.storedBytes += taken.length;
    }
    if (chunk.length > available && !this.truncatedOutput) {
      this.truncatedOutput = true;
      return true;
    }
    return false;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.options.maxBufferedChunks !== undefined) {
      this.appendText("stdout", this.decoders.stdout.end());
      this.appendText("stderr", this.decoders.stderr.end());
    }
  }

  capture(): Readonly<{ stdout: string; stderr: string; outputTruncated: boolean }> {
    return {
      stdout: Buffer.concat(this.stdout).toString("utf8"),
      stderr: Buffer.concat(this.stderr).toString("utf8"),
      outputTruncated: this.truncatedOutput,
    };
  }

  read(fromSequence = 0): ProcessOutputRead {
    if (!Number.isSafeInteger(fromSequence) || fromSequence < 0) {
      throw new RangeError("fromSequence must be a nonnegative integer");
    }
    const firstRetained = this.records[0]?.sequence ?? this.sequence;
    return {
      entries: this.records.filter((event) => event.sequence >= fromSequence),
      nextSequence: this.sequence,
      truncated: fromSequence < firstRetained,
    };
  }

  private appendText(stream: ProcessOutputStream, text: string): void {
    if (!text || this.options.maxBufferedChunks === undefined) return;
    this.records.push({ sequence: this.sequence++, stream, text });
    if (this.records.length > this.options.maxBufferedChunks) this.records.shift();
  }
}
