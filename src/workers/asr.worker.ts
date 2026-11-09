import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import type { WorkerRequest, WorkerReply } from "../lib/types";
env.allowLocalModels = false;
let model: AutomaticSpeechRecognitionPipeline | null = null;
// Narrow the all-task factory to avoid expanding every model union in TypeScript.
const createASR = pipeline as unknown as (
  task: "automatic-speech-recognition",
  name: string,
  options: {
    device: "wasm";
    dtype: "q8";
    progress_callback: (event: { status: string; progress: number }) => void;
  },
) => Promise<AutomaticSpeechRecognitionPipeline>;
const send = (message: WorkerReply) => self.postMessage(message);
let queue = Promise.resolve();
let warmed = false;
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  queue = queue.then(async () => {
    try {
      if (!model) {
        send({
          id: req.id,
          kind: "progress",
          message: "Downloading local speech recognition…",
        });
        model = await createASR(
          "automatic-speech-recognition",
          "onnx-community/whisper-tiny.en",
          {
            device: "wasm",
            dtype: "q8",
            progress_callback: (event) => {
              if (event.status === "progress")
                send({
                  id: req.id,
                  kind: "progress",
                  message: `Downloading speech recognition · ${Math.round(event.progress)}%`,
                });
            },
          },
        );
      }
      if (req.kind === "load") {
        if (!warmed) {
          send({
            id: req.id,
            kind: "progress",
            message: "Preparing local speech recognition…",
          });
          await model(new Float32Array(16000), { max_new_tokens: 8 });
          warmed = true;
        }
        send({ id: req.id, kind: "ready", engine: "Whisper · WebAssembly" });
      } else {
        const result = await model(req.audio!, {
          chunk_length_s: 25,
          stride_length_s: 3,
        });
        send({
          id: req.id,
          kind: "transcript",
          text: Array.isArray(result)
            ? result.map((x) => x.text).join(" ")
            : result.text,
        });
      }
    } catch {
      send({
        id: req.id,
        kind: "error",
        message:
          "Local speech recognition failed. You can still type a message.",
      });
    }
  });
};
