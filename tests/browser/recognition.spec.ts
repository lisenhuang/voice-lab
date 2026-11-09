import { test, expect } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
test("live browser Whisper transcribes a public speech fixture without a backend", async ({
  page,
}) => {
  test.skip(
    process.env.RUN_LOCAL_MODELS !== "1",
    "Opt-in: downloads the local speech model.",
  );
  test.setTimeout(240_000);
  const directory = ".next/static/chunks";
  let filename = "";
  for (const candidate of await readdir(directory)) {
    if (
      candidate.endsWith(".js") &&
      (await readFile(`${directory}/${candidate}`, "utf8")).includes(
        "onnx-community/whisper-tiny.en",
      )
    ) {
      filename = candidate;
      break;
    }
  }
  expect(filename).not.toBe("");
  await page.goto("/");
  const result = await page.evaluate(async (workerPath) => {
    const context = new AudioContext({ sampleRate: 16000 });
    const response = await fetch(
      "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav",
    );
    if (!response.ok) throw new Error("Speech fixture unavailable.");
    const decoded = await context.decodeAudioData(await response.arrayBuffer());
    const pcm = decoded.getChannelData(0);
    const worker = new Worker(workerPath);
    try {
      let serial = 0;
      const request = (kind: string, audio?: Float32Array) =>
        new Promise<string>((resolve, reject) => {
          const id = ++serial;
          worker.onerror = () => reject(new Error("Speech worker failed."));
          worker.onmessage = (e) => {
            if (e.data.id !== id || e.data.kind === "progress") return;
            if (e.data.kind === "error") reject(new Error(e.data.message));
            else resolve(e.data.text ?? "");
          };
          worker.postMessage({ id, kind, audio });
        });
      await request("load");
      const fullStart = performance.now();
      const fullText = await request("transcribe", pcm);
      const fullMs = performance.now() - fullStart;
      const segments = [];
      for (let start = 0; start < pcm.length; start += 96000) {
        const begin = performance.now();
        const text = await request(
          "transcribe",
          pcm.slice(
            Math.max(0, start - 5600),
            Math.min(pcm.length, start + 96000),
          ),
        );
        segments.push({ text, ms: performance.now() - begin });
      }
      return { fullText, fullMs, duration: pcm.length / 16000, segments };
    } finally {
      worker.terminate();
      await context.close();
    }
  }, `/_next/static/chunks/${filename}`);
  expect(result.fullText.toLowerCase()).toContain("ask not");
  const text = result.segments
    .map((segment) => segment.text)
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ");
  expect(text).toContain("ask not");
  expect(text).toContain("country");
  console.log(
    JSON.stringify({
      fixtureSeconds: result.duration,
      fullUtteranceMs: Math.round(result.fullMs),
      segmentMs: result.segments.map((segment) => Math.round(segment.ms)),
      lastSegmentMs: Math.round(result.segments.at(-1)!.ms),
    }),
  );
});
