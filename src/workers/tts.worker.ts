import { KokoroTTS } from "kokoro-js";
import type { WorkerRequest, WorkerReply, Engine } from "../lib/types";
let tts: KokoroTTS | null = null;
let selected = "";
const send = (message: WorkerReply) => self.postMessage(message);
async function load(id: number, engine: Engine = "auto") {
  if (tts) return;
  const gpu =
    engine === "webgpu" ||
    (engine === "auto" && !!(navigator as Navigator & { gpu?: unknown }).gpu);
  const progress = (event: { status?: string; progress?: number }) => {
    if (event.status === "progress")
      send({
        id,
        kind: "progress",
        message: `Downloading voice model${event.progress ? ` · ${Math.round(event.progress)}%` : ""}`,
      });
  };
  if (gpu) {
    try {
      tts = await KokoroTTS.from_pretrained(
        "onnx-community/Kokoro-82M-v1.0-ONNX",
        { device: "webgpu", dtype: "fp32", progress_callback: progress },
      );
      selected = "WebGPU";
    } catch {
      if (engine === "webgpu")
        throw new Error("WebGPU could not load. Choose WebAssembly or Auto.");
      send({
        id,
        kind: "progress",
        message: "WebGPU unavailable. Loading WebAssembly…",
      });
    }
  }
  if (!tts) {
    tts = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      { device: "wasm", dtype: "q8", progress_callback: progress },
    );
    selected = "WebAssembly";
  }
}
// Serialize inference. Terminating this worker is the hard cancellation path.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  queue = queue.then(async () => {
    try {
      await load(req.id, req.engine);
      if (req.kind === "load")
        send({ id: req.id, kind: "ready", engine: selected });
      else if (req.kind === "speak") {
        const start = performance.now();
        const audio = await tts!.generate(req.text!, {
          voice: (req.voice ?? "af_heart") as "af_heart",
        });
        send({
          id: req.id,
          kind: "audio",
          audio: audio.audio,
          sampleRate: audio.sampling_rate,
          engine: selected,
          seconds: (performance.now() - start) / 1000,
        });
      }
    } catch {
      send({
        id: req.id,
        kind: "error",
        message:
          "Voice model could not run. Check your connection, or switch to WebAssembly and reload the voice.",
      });
    }
  });
};
