import { test } from "node:test";
import assert from "node:assert/strict";
import { Microphone } from "../src/lib/audio";
import {
  StreamingRecognition,
  mergeTranscript,
  speechOnly,
} from "../src/lib/streaming-recognition";
import {
  saveSession,
  readSavedSession,
  SESSION_KEY,
} from "../src/lib/session-storage";
import {
  setSession,
  restoreSession,
  getSession,
  splitSpeech,
} from "../src/lib/openai";

test("streaming transcription starts before the final turn and merges overlap once", async () => {
  const decoded: number[] = [],
    partial: string[] = [];
  const recognizer = new StreamingRecognition(
    async (pcm) => {
      decoded.push(pcm[0]);
      return pcm[0] === 1
        ? "Tell me about the country."
        : "the country. And its history.";
    },
    (text) => partial.push(text),
  );
  recognizer.push(new Float32Array([1]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(decoded.length, 1);
  assert.deepEqual(partial, ["Tell me about the country."]);
  assert.equal(
    await recognizer.finish(new Float32Array([2])),
    "Tell me about the country. And its history.",
  );
  assert.equal(await recognizer.finish(new Float32Array()), "");
});
test("cancelled recognition cannot leak text into the next turn", async () => {
  let release!: (text: string) => void;
  const partial: string[] = [];
  const recognizer = new StreamingRecognition(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    (text) => partial.push(text),
  );
  recognizer.push(new Float32Array([1]));
  await new Promise((resolve) => setImmediate(resolve));
  recognizer.reset();
  release("Old speech");
  assert.equal(await recognizer.finish(new Float32Array()), "");
  assert.deepEqual(partial, []);
});
test("microphone emits speech before end-of-turn and does not decode already emitted silence twice", () => {
  let segments = 0;
  const final: { current?: Float32Array } = {};
  const mic = new Microphone(
    (pcm) => {
      final.current = pcm;
    },
    () => {},
    (pcm) => {
      segments++;
      assert.ok(pcm.length >= 6400);
    },
  );
  mic.enabled = true;
  const feed = (
    mic as unknown as { receive: (frame: Float32Array) => void }
  ).receive.bind(mic);
  for (let i = 0; i < 20; i++) feed(new Float32Array(1024).fill(0.1));
  for (let i = 0; i < 3; i++) feed(new Float32Array(1024));
  assert.equal(segments, 1);
  assert.equal(Boolean(final.current), false);
  for (let i = 0; i < 5; i++) feed(new Float32Array(1024));
  assert.ok(final.current);
  assert.equal(final.current.length, 0);
  assert.equal(mic.enabled, false);
});
test("speech-only filtering suppresses noise annotations and small phrase chunks start earlier", () => {
  assert.equal(speechOnly("(keyboard clicking)"), "");
  assert.equal(speechOnly("[Music]"), "");
  assert.equal(
    speechOnly("I heard keyboard clicking."),
    "I heard keyboard clicking.",
  );
  assert.equal(
    mergeTranscript("Hello there", "there, how are you?"),
    "Hello there how are you?",
  );
  const text =
    "Let me think through your question and give you a brief answer that you can use in your next conversation without a long wait";
  const result = splitSpeech(text, false, 100);
  assert.ok(result.chunks.length > 0);
  assert.equal([...result.chunks, result.remaining].join(" "), text);
});
test("persistent session survives memory reset and malformed stored data is ignored", () => {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    },
  });
  try {
    const session = {
      accessToken: "fixture",
      refreshToken: "refresh",
      idToken: "id",
      clientId: "client",
      subject: "sub",
      email: "test@example.com",
      expiresAt: 1,
      scopes: [],
    };
    setSession(session);
    setSession(null, false);
    assert.equal(getSession(), null);
    assert.deepEqual(restoreSession(), session);
    saveSession(null);
    assert.equal(readSavedSession(), null);
    entries.set(SESSION_KEY, '{"accessToken":"incomplete"}');
    assert.equal(readSavedSession(), null);
    entries.set(SESSION_KEY, "not-json");
    assert.equal(readSavedSession(), null);
  } finally {
    setSession(null, false);
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});
