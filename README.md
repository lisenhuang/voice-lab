# Voice Lab

A local Next.js voice-chat experiment: sign in with an eligible ChatGPT subscription, stream text through a minimal Next.js relay, and speak it with browser-side Kokoro. English speech recognition runs locally with Whisper tiny.en. No microphone recordings or chat history are stored by the Next.js backend.

## Run

Requires Node.js 20.9+ and pnpm. Built with **Next.js 16.4.5**, the npm `latest` stable release checked on 9 November 2026, React 19.3.1 and TypeScript. Exact installed dependencies are captured in `pnpm-lock.yaml`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open **http://127.0.0.1:1455**, not `localhost`. Keep the terminal running. `pnpm dev` runs the development server on the same address. Stop another process using port 1455 first, if necessary. Do not run dev and production simultaneously.

1. Try **Preview voice** without signing in. The first preview downloads Kokoro; later loads can use the browser cache.
2. Choose **Continue with ChatGPT**. Complete sign-in and consent in the popup, which returns to this local Next.js server. The available model list is fetched from OpenAI through the relay for that account. Sign-in and model/reasoning choices are saved in this browser and restored on reload or server restart.
3. Type a message, or choose **Start conversation**. The first voice conversation downloads Whisper. Allow microphone access. Speak and pause for approximately 0.5 seconds to finish a turn.
4. Use headphones. The microphone waits while the assistant is replying; press **Interrupt reply** to return to listening. This is automatic turn-taking, not simultaneous full-duplex speech.

## Where work runs

| Operation                                                                 | Location                                     |
| ------------------------------------------------------------------------- | -------------------------------------------- |
| OAuth state, PKCE, callback, code exchange, ID-token signature validation | Next.js login routes                         |
| OAuth access/refresh/ID tokens after login                                | Browser localStorage + active module memory                   |
| Token refresh and revocation                                              | Browser → same-origin Next.js relay → OpenAI |
| Account model catalog and Responses streaming                             | Browser → same-origin Next.js relay → OpenAI |
| Conversation history                                                      | React/browser memory only                    |
| Kokoro generation                                                         | Browser Web Worker, WebGPU fp32 or WASM q8   |
| Whisper recognition                                                       | Separate browser Web Worker, WASM q8         |
| Nonsecret host ID and account registration labels                         | localStorage                                 |

The backend holds one-time login transactions in process memory for up to ten minutes. It exchanges the authorization code, validates the signed ID token, then places the result in a one-use in-memory handoff for the initiating tab. The tab collects it through a same-origin POST authenticated by its HttpOnly login cookie, then the backend deletes it. Unclaimed results expire after two minutes. This works even when OAuth severs the popup opener. The backend never writes subscription tokens to disk. As explicitly requested, the browser persists the OAuth session in localStorage under `voice-lab-session-v1`. Token responses are not cached or logged; callback query values are removed from history. Reloading restores the saved login and model preferences; chat history remains memory-only. Refresh-token rotation is serialized within a tab and, when Web Locks are available, across tabs. Rotated tokens are saved immediately. Clearing browser site data, revocation, or expiration of the refresh token can still require sign-in. There is no disconnect button in the connected UI.

## Experimental boundaries

- Browser-held subscription tokens are deliberate, as requested. OpenAI's documented guidance says to keep these tokens out of browser storage. This prototype does **not** establish approval for a public hosted integration.
- The current open-source subscription flow requires an HTTP loopback callback. This project runs locally so the Next.js server can receive that callback. Uploading it to Vercel or Oracle as-is will not make public-site OAuth work. Hosted integration requires a supported client registration/redirect arrangement with OpenAI.
- This is a single-process local server. Its ephemeral transaction map is not a distributed/serverless session store.
- **Live testing found that both authenticated direct browser requests (`/v1/models` and `/v1/responses`) were blocked by missing CORS response headers.** Unauthenticated preflight/error probes had been permissive. The app therefore uses a same-origin Next.js relay. The browser still owns the tokens; the relay forwards them only for each request and does not persist them. A real subscription reply was verified through the relay without another sign-in.
- A subscription is not unlimited access to every model. The picker uses the account's visible catalog; manual model-ID entry is not offered. Choices refresh on sign-in, window/dropdown focus (30-second freshness window), and every minute while idle. A refresh/retry button handles catalog errors. Reasoning levels come from each model’s live metadata, supplemented with the documented `none` capability for GPT-6-Luna, GPT-6-Sol and GPT-6.1-Terra because the subscription catalog currently omits it. A live Luna request verified that `none` is accepted. The selected level is sent as `reasoning.effort`; usage limits and unsupported features still apply.
- Browser audio needs a user gesture. GPU support, first download, compilation, device memory and model runtime affect latency. Auto tries WebGPU then falls back to WASM. WASM uses the browser's available threading; cross-origin isolation is intentionally not enabled because it would sever the OAuth popup opener.
- Voice models download from Hugging Face. Google Fonts provides the page typography. Neither receives subscription tokens or chat content from this app. Raw microphone audio is processed locally; recognized text goes through the local relay to OpenAI.
- Whisper tiny.en is English-only and can misrecognise or hallucinate on noisy audio. The simple volume-based end-of-turn detector is a prototype, not a production VAD.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
# With pnpm start running in another terminal:
pnpm test:browser
```

Core tests cover one-use OAuth state, callback substitution/expiry, safe script serialization, fragmented SSE/UTF-8, truncated and failed replies, speech chunking, account-specific model selection and token-refresh races. Browser tests cover desktop/mobile behaviour and callback guards. Live model downloads and subscription login are separate checks, not mocked proof of end-to-end performance.

## References

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://github.com/hexgrad/kokoro/tree/main/kokoro.js
- https://nextjs.org/docs/app/getting-started/installation

## Verified locally

- Production build and TypeScript pass.
- Live OAuth registration and returning sign-in succeed. The callback does not depend on `window.opener`.
- Real ChatGPT subscription inference through the relay returned “I can read your message.” A subsequent greeting completed with browser-side Kokoro generation.
- The authenticated model catalog returned HTTP 200 with eight visible models through the relay. The catalog advertises Low as the minimum for all eight, but this metadata is incomplete: live GPT-6-Luna inference accepted None, matching the official model documentation. A live request selected through the dropdown with GPT-6-Luna and Low reasoning returned “Model selection works.”
- Regression checks cover catalog retry, dropdown-only selection, documented None support, request payloads, persistent login/rotated tokens, incremental audio segmentation, cancellation and absence of the disconnect button. The opt-in live Whisper test passed separately.
- Kokoro WebGPU preview: 4.0 s generation for 4.8 s audio; WASM preview: 8.4 s generation for 4.9 s audio. A later real reply took 0.8 s to generate 2.6 s audio on WebGPU. These are individual trials, not repeated steady-state benchmarks.
- Local Whisper in an actual Chromium worker successfully transcribed the public JFK speech fixture. Run `RUN_LOCAL_MODELS=1 pnpm exec playwright test tests/browser/recognition.spec.ts` to repeat (downloads model files).
- The physical microphone conversation still needs the user's spoken test; synthetic recognition and text-to-speech checks do not establish that final device interaction.

## Voice latency and transport

The subscription flow does not accept audio input or the transcription API. A Responses WebSocket carries text/image inputs; switching to WSS does not make GPT-6-Luna accept live microphone audio. True audio streaming requires a compatible Realtime/Live integration and credentials. This prototype retains the requested subscription and local Kokoro architecture.

Microphone audio now goes to local Whisper in overlapping segments while the user is speaking: at short pauses or after six seconds. Transcripts are merged across a 350 ms overlap and shown live. End-of-turn detection uses 64 ms frames and approximately 500 ms of silence. Already decoded segments are reused at turn end, and only the remaining tail must finish. Whisper is warmed before the microphone starts. Kokoro receives bounded phrases (about 100 characters) instead of waiting for long complete sentences. These choices trade some transcription context and prosody for lower delay; Whisper remains an English-only prototype.

The UI reports end-of-turn pause, remaining transcription time, AI time to first text, and time to first audio. There is no speculative AI reply while the user is still talking. The final text turn is sent after end-of-turn detection; the response is already streamed over HTTP/SSE.

A live short-prompt trial through this subscription measured 3.83 s to first text with Luna/None and 4.16 s with Luna/Low. These are single trials, not a reliable speed comparison or a guarantee of end-to-end voice latency. OpenAI generation remains a substantial part of the wait.

References: [Luna capabilities](https://developers.openai.com/api/docs/models/gpt-6-luna), [subscription transport/input limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Final checks: production build/TypeScript and 18 unit tests passed. The live 11-second JFK fixture passed with incremental recognition: whole-utterance transcription took 1.275 s, and the two overlapping segments took 1.110 s and 1.141 s. This measures inference work only, not an actual microphone conversation; segmentation alone showed only a small final-tail reduction on this fixture. The real connected browser survived server restart and reload without reauthentication, restoring Luna/None.

Five browser regression tests passed; the opt-in live recognition test passed separately. After the final server restart and reload, the saved real session generated a spoken Luna/None reply without another sign-in. In that warm typed-message trial, first text arrived in 3.0 s and first audio in 3.6 s; Kokoro generated 2.1 s of audio in 0.5 s. Those timings exclude microphone/transcription time.
