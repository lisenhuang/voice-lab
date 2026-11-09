// Incrementally decode short overlapping audio segments while the microphone is active.
// No microphone audio leaves the browser.
export function mergeTranscript(previous: string, next: string): string {
  if (!previous.trim()) return next.trim();
  const left = previous.trim().split(/\s+/),
    right = next.trim().split(/\s+/);
  const normal = (word: string) =>
    word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  for (
    let count = Math.min(20, left.length, right.length);
    count > 0;
    count--
  ) {
    if (
      left
        .slice(-count)
        .every((word, index) => normal(word) === normal(right[index]))
    ) {
      return [...left, ...right.slice(count)].join(" ");
    }
  }
  return `${previous.trim()} ${next.trim()}`.trim();
}
export function speechOnly(text: string): string {
  return /^\s*(?:\[[^\]]*\]|\([^)]*\))\s*[.!?]?\s*$/.test(text)
    ? ""
    : text.trim();
}
export class StreamingRecognition {
  private queue: Promise<void> = Promise.resolve();
  private text = "";
  private error: unknown;
  private revision = 0;
  constructor(
    private transcribe: (pcm: Float32Array) => Promise<string>,
    private partial: (text: string) => void,
  ) {}
  push(pcm: Float32Array) {
    if (!pcm.length) return;
    const revision = this.revision;
    this.queue = this.queue.then(async () => {
      if (revision !== this.revision) return;
      try {
        const next = speechOnly(await this.transcribe(pcm));
        if (revision !== this.revision) return;
        this.text = mergeTranscript(this.text, next);
        this.partial(this.text);
      } catch (error) {
        if (revision === this.revision) this.error = error;
      }
    });
  }
  async finish(tail: Float32Array): Promise<string> {
    const revision = this.revision;
    this.push(tail);
    await this.queue;
    if (revision !== this.revision) return "";
    if (this.error) throw this.error;
    const text = this.text;
    this.reset();
    return text;
  }
  reset() {
    this.revision++;
    this.text = "";
    this.error = undefined;
  }
}
