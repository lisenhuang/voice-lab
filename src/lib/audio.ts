import type { Engine, WorkerReply, WorkerRequest } from "./types";
class WorkerClient {
  private serial = 0;
  private pending = new Map<
    number,
    { resolve: (x: WorkerReply) => void; reject: (e: Error) => void }
  >();
  constructor(
    private worker: Worker,
    private progress: (s: string) => void,
  ) {
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const x = event.data;
      if (x.kind === "progress") {
        this.progress(x.message ?? "Loading…");
        return;
      }
      const task = this.pending.get(x.id);
      if (!task) return;
      this.pending.delete(x.id);
      if (x.kind === "error") task.reject(new Error(x.message));
      else task.resolve(x);
    };
    worker.onerror = () => {
      for (const p of this.pending.values())
        p.reject(new Error("The browser could not start the audio model."));
      this.pending.clear();
    };
  }
  request(request: Omit<WorkerRequest, "id">) {
    return new Promise<WorkerReply>((resolve, reject) => {
      const id = ++this.serial;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id });
    });
  }
  close() {
    this.worker.terminate();
    for (const p of this.pending.values())
      p.reject(new Error("Audio stopped."));
    this.pending.clear();
  }
}
export class VoiceAudio {
  private tts: WorkerClient | null = null;
  private asr: WorkerClient | null = null;
  private context: AudioContext | null = null;
  private nodes = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private generation = 0;
  private synthesis: Promise<void> = Promise.resolve();
  constructor(
    private progress: (s: string) => void,
    private metric: (seconds: number, duration: number) => void,
    private speaking: () => void,
  ) {}
  async unlock() {
    this.context ??= new AudioContext();
    await this.context.resume();
  }
  async loadVoice(engine: Engine) {
    this.tts ??= new WorkerClient(
      new Worker(new URL("../workers/tts.worker.ts", import.meta.url)),
      this.progress,
    );
    return this.tts.request({ kind: "load", engine });
  }
  async loadRecognition() {
    this.asr ??= new WorkerClient(
      new Worker(new URL("../workers/asr.worker.ts", import.meta.url)),
      this.progress,
    );
    return this.asr.request({ kind: "load" });
  }
  async transcribe(audio: Float32Array) {
    if (!this.asr) throw new Error("Speech recognition is not loaded.");
    const response = await this.asr.request({ kind: "transcribe", audio });
    return response.text ?? "";
  }
  speak(text: string, voice: string) {
    const generation = this.generation;
    this.synthesis = this.synthesis.then(async () => {
      if (generation !== this.generation || !this.tts) return;
      const result = await this.tts.request({ kind: "speak", text, voice });
      if (generation !== this.generation || !result.audio || !this.context)
        return;
      const buffer = this.context.createBuffer(
        1,
        result.audio.length,
        result.sampleRate!,
      );
      buffer.copyToChannel(new Float32Array(result.audio), 0);
      const node = this.context.createBufferSource();
      node.buffer = buffer;
      node.connect(this.context.destination);
      this.nodes.add(node);
      node.onended = () => {
        this.nodes.delete(node);
        node.disconnect();
      };
      this.nextTime = Math.max(this.context.currentTime + 0.04, this.nextTime);
      node.start(this.nextTime);
      this.nextTime += buffer.duration;
      this.metric(result.seconds ?? 0, buffer.duration);
      this.speaking();
    });
    return this.synthesis;
  }
  async drain() {
    const generation = this.generation;
    await this.synthesis;
    while (generation === this.generation && this.nodes.size)
      await new Promise((r) => setTimeout(r, 80));
  }
  stop() {
    this.generation++;
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {}
      n.disconnect();
    }
    this.nodes.clear();
    this.nextTime = 0;
    this.synthesis = Promise.resolve();
  }
  resetVoice() {
    this.stop();
    this.tts?.close();
    this.tts = null;
  }
  close() {
    this.resetVoice();
    this.asr?.close();
    this.asr = null;
    void this.context?.close();
    this.context = null;
  }
}
export class Microphone {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private frames: Float32Array[] = [];
  private samples = 0;
  private voiced = 0;
  private silence = 0;
  private preRoll: Float32Array[] = [];
  private emittedSamples = 0;
  private emittedSpeechEnd = 0;
  private speechEnd = 0;
  private speechEndedAt = 0;
  enabled = false;
  constructor(
    private onUtterance: (audio: Float32Array, speechEndedAt: number) => void,
    private onLevel: (n: number) => void,
    private onSegment?: (audio: Float32Array) => void,
  ) {}
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    try {
      this.context = new AudioContext({ sampleRate: 16000 });
      await this.context.audioWorklet.addModule("/capture-worklet.js");
      const source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, "voice-capture");
      source.connect(this.node);
      const mute = this.context.createGain();
      mute.gain.value = 0;
      this.node.connect(mute);
      mute.connect(this.context.destination);
      this.node.port.onmessage = (e: MessageEvent<Float32Array>) =>
        this.receive(e.data);
      await this.context.resume();
    } catch (e) {
      this.stop();
      throw e;
    }
  }
  private receive(frame: Float32Array) {
    if (!this.enabled) {
      this.reset();
      return;
    }
    const level = Math.sqrt(
      frame.reduce((sum, x) => sum + x * x, 0) / frame.length,
    );
    this.onLevel(Math.min(1, level * 12));
    const ms = frame.length / 16;
    if (level > 0.014) {
      if (!this.frames.length) {
        this.frames.push(...this.preRoll);
        this.samples += this.preRoll.reduce((n, x) => n + x.length, 0);
      }
      this.voiced += ms;
      this.silence = 0;
      this.speechEnd = this.samples + frame.length;
      this.speechEndedAt = performance.now();
    } else this.silence += ms;
    if (this.voiced) {
      this.frames.push(frame);
      this.samples += frame.length;
    } else {
      this.preRoll.push(frame);
      if (this.preRoll.length > 6) this.preRoll.shift();
    }
    // Decode during speech at short pauses, or in six-second windows.
    // Keep 350 ms overlap so words crossing a boundary can be recovered.
    if (
      this.onSegment &&
      this.voiced > 250 &&
      this.speechEnd > this.emittedSpeechEnd &&
      this.samples - this.emittedSamples >= 16000 * 0.4 &&
      (this.silence >= 160 || this.samples - this.emittedSamples >= 16000 * 6)
    ) {
      this.onSegment(this.segment(this.samples));
      this.emittedSamples = this.samples;
      this.emittedSpeechEnd = this.speechEnd;
    }
    if (this.voiced && (this.silence >= 500 || this.samples > 16000 * 20)) {
      if (this.voiced > 250) {
        const tail =
          this.speechEnd > this.emittedSpeechEnd
            ? this.segment(this.samples)
            : new Float32Array();
        this.enabled = false;
        this.onUtterance(tail, this.speechEndedAt);
      }
      this.reset();
    }
  }
  private segment(end: number) {
    const start = Math.max(0, this.emittedSamples - 5600);
    const result = new Float32Array(end - start);
    let offset = 0;
    for (const frame of this.frames) {
      const from = Math.max(0, start - offset),
        to = Math.min(frame.length, end - offset);
      if (to > from)
        result.set(frame.subarray(from, to), Math.max(0, offset - start));
      offset += frame.length;
      if (offset >= end) break;
    }
    return result;
  }
  private reset() {
    this.frames = [];
    this.samples = 0;
    this.voiced = 0;
    this.silence = 0;
    this.preRoll = [];
    this.emittedSamples = 0;
    this.emittedSpeechEnd = 0;
    this.speechEnd = 0;
    this.speechEndedAt = 0;
  }
  stop() {
    this.enabled = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.node?.disconnect();
    this.node = null;
    void this.context?.close();
    this.context = null;
    this.reset();
    this.onLevel(0);
  }
}
