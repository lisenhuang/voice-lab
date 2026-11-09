"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Headphones,
  Mic,
  MicOff,
  Plus,
  Send,
  SlidersHorizontal,
  Square,
  Volume2,
  Waves,
  X,
  LoaderCircle,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
import { VoiceAudio, Microphone } from "@/lib/audio";
import { StreamingRecognition } from "@/lib/streaming-recognition";
import {
  getSession,
  models,
  reasoningFor,
  reasoningLabel,
  respond,
  setSession,
  restoreSession,
  splitSpeech,
} from "@/lib/openai";
import type {
  ChatMessage,
  Engine,
  Model,
  Registration,
  Session,
} from "@/lib/types";

type Phase =
  "idle" | "loading" | "listening" | "transcribing" | "thinking" | "speaking";
const labels: Record<Phase, string> = {
  idle: "Ready when you are",
  loading: "Getting things ready",
  listening: "I’m listening",
  transcribing: "Finding your words",
  thinking: "A moment to think",
  speaking: "Let’s talk",
};
const HOST = "voice-lab-host";
const ACCOUNTS = "voice-lab-registrations";
function readRegistrations(): Registration[] {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNTS) ?? "[]");
  } catch {
    return [];
  }
}
export default function VoiceLab() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [account, setAccount] = useState("");
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [catalog, setCatalog] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [partialSpeech, setPartialSpeech] = useState("");
  const [latency, setLatency] = useState<{
    recognition?: number;
    firstText?: number;
    firstAudio?: number;
    endpoint?: number;
  }>({});
  const speechStarted = useRef(0);
  const requestStarted = useRef(0);
  const heardAudio = useRef(false);
  const streamingRecognition = useRef<StreamingRecognition | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const modelRequest = useRef(false);
  const modelsLoadedAt = useRef(0);
  const selectedModel = catalog.find((item) => item.slug === model);
  const reasoningEffort = reasoningFor(selectedModel, reasoning);
  const [voice, setVoice] = useState("af_heart");
  const [engine, setEngine] = useState<Engine>("auto");
  const [actualEngine, setActualEngine] = useState("Not loaded");
  const [voiceReady, setVoiceReady] = useState(false);
  const [loadingVoice, setLoadingVoice] = useState(false);
  const [hasGPU, setHasGPU] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [call, setCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [audioOn, setAudioOn] = useState(true);
  const [metric, setMetric] = useState<{
    generation: number;
    duration: number;
  } | null>(null);
  const [settings, setSettings] = useState(false);
  const audio = useRef<VoiceAudio | null>(null);
  const mic = useRef<Microphone | null>(null);
  const history = useRef<ChatMessage[]>([]);
  const controller = useRef<AbortController | null>(null);
  const popup = useRef<Window | null>(null);
  const popupTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);
  const callRef = useRef(false);
  const busyRef = useRef(false);
  const mutedRef = useRef(false);
  const turnId = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const utteranceRef = useRef<
    (pcm: Float32Array, speechEndedAt: number) => Promise<void>
  >(async () => {});
  function getAudio() {
    audio.current ??= new VoiceAudio(
      setNotice,
      (generation, duration) => setMetric({ generation, duration }),
      () => {
        if (!heardAudio.current && requestStarted.current) {
          heardAudio.current = true;
          const start = speechStarted.current || requestStarted.current;
          setLatency((previous) => ({
            ...previous,
            firstAudio: (performance.now() - start) / 1000,
          }));
        }
        if (busyRef.current) setPhase("speaking");
      },
    );
    return audio.current;
  }
  function listen() {
    if (callRef.current && mic.current && !mutedRef.current) {
      mic.current.enabled = true;
      setPhase("listening");
    } else setPhase("idle");
  }
  function interrupt() {
    streamingRecognition.current?.reset();
    setPartialSpeech("");
    const wasBusy = busyRef.current;
    turnId.current++;
    controller.current?.abort();
    audio.current?.stop();
    busyRef.current = false;
    setBusy(false);
    if (mic.current) mic.current.enabled = false;
    history.current = history.current.map((m) =>
      m.role === "assistant" && m.id === history.current.at(-1)?.id
        ? { ...m, failed: wasBusy || m.failed }
        : m,
    );
    setMessages([...history.current]);
    listen();
  }
  function endCall() {
    streamingRecognition.current?.reset();
    setPartialSpeech("");
    callRef.current = false;
    setCall(false);
    interrupt();
    mic.current?.stop();
    mic.current = null;
    setPhase("idle");
  }
  function clearChat() {
    endCall();
    history.current = [];
    setMessages([]);
    setError("");
    setMetric(null);
  }
  useEffect(() => {
    alive.current = true;
    setRegistrations(readRegistrations());
    setHasGPU("gpu" in navigator);
    const restored = restoreSession();
    if (restored) {
      setAccount(restored.email);
      setSelectedAccount(restored.clientId);
    }
    try {
      const saved = JSON.parse(
        localStorage.getItem("voice-lab-preferences") ?? "null",
      );
      if (typeof saved?.model === "string") setModel(saved.model);
      if (typeof saved?.reasoning === "string") setReasoning(saved.reasoning);
    } catch {
      /* Ignore malformed nonsecret preferences. */
    }
    setPreferencesReady(true);
    return () => {
      alive.current = false;
      callRef.current = false;
      turnId.current++;
      controller.current?.abort();
      mic.current?.stop();
      audio.current?.close();
      if (popupTimer.current) clearInterval(popupTimer.current);
      popup.current?.close();
      streamingRecognition.current?.reset();
      setSession(null, false);
    };
  }, []);
  useEffect(() => {
    if (!preferencesReady || !selectedModel) return;
    localStorage.setItem(
      "voice-lab-preferences",
      JSON.stringify({ model, reasoning: reasoningEffort }),
    );
  }, [preferencesReady, selectedModel, model, reasoningEffort]);
  useEffect(() => {
    if (messages.length)
      transcriptEnd.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
  }, [messages]);
  async function receiveLogin(data: { error?: string; session?: Session }) {
    if (popupTimer.current) clearInterval(popupTimer.current);
    popup.current = null;
    setLoggingIn(false);
    if (data.error) {
      setError(data.error);
      return;
    }
    const s = data.session;
    if (!s?.accessToken || !s?.clientId || !s?.subject) return;
    setSession(s);
    setAccount(s.email);
    clearChat();
    const list = readRegistrations().filter((x) => x.clientId !== s.clientId);
    list.push({ clientId: s.clientId, subject: s.subject, email: s.email });
    localStorage.setItem(ACCOUNTS, JSON.stringify(list));
    setRegistrations(list);
    setSelectedAccount(s.clientId);
  }
  const refreshModels = useCallback(async (force = false) => {
    const session = getSession();
    if (!session || modelRequest.current) return;
    if (!force && Date.now() - modelsLoadedAt.current < 30_000) return;
    modelRequest.current = true;
    setLoadingModels(true);
    setModelError("");
    try {
      const items = await models();
      if (!alive.current || getSession()?.clientId !== session.clientId) return;
      setCatalog(items);
      setModel((previous) =>
        items.some((item) => item.slug === previous)
          ? previous
          : (items.find((item) => item.slug === "gpt-6-luna")?.slug ??
            items[0]?.slug ??
            ""),
      );
      modelsLoadedAt.current = Date.now();
      if (!items.length)
        setModelError(
          "No conversation models are available for this account yet. Refresh to check again.",
        );
    } catch (e) {
      if (alive.current)
        setModelError(
          e instanceof Error && !(e instanceof TypeError)
            ? e.message
            : "Could not load models. Check the connection and try again.",
        );
    } finally {
      modelRequest.current = false;
      if (alive.current) setLoadingModels(false);
    }
  }, []);
  useEffect(() => {
    if (!account) return;
    void refreshModels(true);
    const refreshWhenIdle = () => {
      if (
        !busyRef.current &&
        !callRef.current &&
        document.visibilityState === "visible"
      )
        void refreshModels();
    };
    const timer = setInterval(refreshWhenIdle, 60_000);
    window.addEventListener("focus", refreshWhenIdle);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshWhenIdle);
    };
  }, [account, refreshModels]);
  async function cancelSignIn() {
    if (popupTimer.current) clearInterval(popupTimer.current);
    setLoggingIn(false);
    popup.current = null;
    await fetch("/api/auth/result", { method: "DELETE" }).catch(() => {});
  }
  async function signIn() {
    setError("");
    if (window.location.origin !== "http://127.0.0.1:1455") {
      setError("For this local experiment, open http://127.0.0.1:1455.");
      return;
    }
    popup.current = window.open(
      "about:blank",
      "voice-lab-login",
      "popup,width=540,height=760",
    );
    if (!popup.current) {
      setError("Allow pop-ups for this page, then try again.");
      return;
    }
    setLoggingIn(true);
    try {
      let hostId = localStorage.getItem(HOST);
      if (!hostId) {
        hostId = `urn:uuid:${crypto.randomUUID()}`;
        localStorage.setItem(HOST, hostId);
      }
      const registration = registrations.find(
        (x) => x.clientId === selectedAccount,
      );
      const response = await fetch("/api/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId, registration }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      popup.current!.location.href = data.url;
      const started = Date.now();
      let polling = false;
      popupTimer.current = setInterval(async () => {
        if (polling || !alive.current) return;
        if (Date.now() - started > 600_000) {
          await cancelSignIn();
          setError("Sign-in timed out. Please try again.");
          return;
        }
        polling = true;
        try {
          const response = await fetch("/api/auth/result", {
            method: "POST",
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) {
            const result = await response.json();
            if (alive.current && result.status === "complete")
              await receiveLogin(result);
          }
        } catch {
          /* Retry transient transport errors until the login transaction expires. */
        } finally {
          polling = false;
        }
      }, 1000);
    } catch (e) {
      popup.current?.close();
      popup.current = null;
      setLoggingIn(false);
      setError(e instanceof Error ? e.message : "Could not open sign-in.");
    }
  }
  async function prepareVoice() {
    setLoadingVoice(true);
    setError("");
    try {
      const a = getAudio();
      await a.unlock();
      const r = await a.loadVoice(engine);
      setVoiceReady(true);
      setActualEngine(r.engine ?? engine);
      setNotice("Voice ready on this device");
      return a;
    } finally {
      setLoadingVoice(false);
    }
  }
  async function preview() {
    if (busyRef.current) return;
    const id = ++turnId.current;
    setBusy(true);
    busyRef.current = true;
    setPhase("loading");
    try {
      const a = await prepareVoice();
      if (id !== turnId.current) return;
      setPhase("speaking");
      await a.speak(
        "Hello. Take a breath, and make yourself comfortable. What would you like to talk about?",
        voice,
      );
      await a.drain();
    } catch (e) {
      if (id === turnId.current)
        setError(e instanceof Error ? e.message : "Could not play voice.");
    } finally {
      if (id === turnId.current) {
        busyRef.current = false;
        setBusy(false);
        listen();
      }
    }
  }
  async function sendText(value: string, fromSpeech = false) {
    const text = value.trim();
    if (!text || busyRef.current) return;
    if (!getSession()) {
      setError("Connect your ChatGPT account to start a conversation.");
      return;
    }
    if (!selectedModel) {
      setError("Choose an available model first.");
      return;
    }
    if (!fromSpeech) {
      speechStarted.current = 0;
      setLatency({});
    }
    heardAudio.current = false;
    requestStarted.current = performance.now();
    const id = ++turnId.current;
    const abort = new AbortController();
    controller.current = abort;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setDraft("");
    if (mic.current) mic.current.enabled = false;
    setPhase("thinking");
    const user: ChatMessage = { id: crypto.randomUUID(), role: "user", text };
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "",
    };
    const input = [...history.current, user];
    history.current = [...input, assistant];
    setMessages([...history.current]);
    let pending = "";
    let firstText = true;
    const speechFailure: { current: Error | null } = { current: null };
    try {
      const a = getAudio();
      if (audioOn) {
        await a.unlock();
        if (!voiceReady) {
          setPhase("loading");
          await prepareVoice();
          setPhase("thinking");
        }
      }
      if (id !== turnId.current) return;
      await respond(
        input,
        model,
        abort.signal,
        (delta) => {
          if (id !== turnId.current) return;
          if (firstText) {
            firstText = false;
            setLatency((previous) => ({
              ...previous,
              firstText: (performance.now() - requestStarted.current) / 1000,
            }));
          }
          assistant.text += delta;
          setMessages([...history.current]);
          if (audioOn) {
            const result = splitSpeech(pending + delta, false, 100);
            pending = result.remaining;
            for (const chunk of result.chunks)
              void a.speak(chunk, voice).catch((e) => {
                speechFailure.current = e;
                abort.abort();
              });
          }
        },
        reasoningEffort,
      );
      if (audioOn && id === turnId.current) {
        for (const chunk of splitSpeech(pending, true).chunks)
          await a.speak(chunk, voice);
        await a.drain();
      }
      if (speechFailure.current) throw speechFailure.current;
    } catch (e) {
      if (id === turnId.current) {
        assistant.failed = true;
        audiostop();
        setMessages([...history.current]);
        setError(
          speechFailure.current?.message ??
            (e instanceof Error && e.name !== "AbortError"
              ? e.message
              : "Reply interrupted."),
        );
      }
    } finally {
      if (id === turnId.current) {
        busyRef.current = false;
        setBusy(false);
        listen();
      }
    }
  }
  function audiostop() {
    audio.current?.stop();
  }
  utteranceRef.current = async (pcm, speechEndedAt) => {
    const id = turnId.current;
    speechStarted.current = speechEndedAt;
    const recognitionStarted = performance.now();
    setLatency({ endpoint: (recognitionStarted - speechEndedAt) / 1000 });
    setPhase("transcribing");
    busyRef.current = true;
    setBusy(true);
    try {
      const text = (await streamingRecognition.current!.finish(pcm)).trim();
      if (id !== turnId.current || !callRef.current) return;
      busyRef.current = false;
      setBusy(false);
      setLatency((previous) => ({
        ...previous,
        recognition: (performance.now() - recognitionStarted) / 1000,
      }));
      setPartialSpeech("");
      if (text) await sendText(text, true);
      else listen();
    } catch (e) {
      if (id === turnId.current) {
        setError(
          e instanceof Error ? e.message : "Could not understand speech.",
        );
        busyRef.current = false;
        setBusy(false);
        listen();
      }
    }
  };
  async function startCall() {
    if (!getSession()) {
      setError(
        "Connect your ChatGPT account first, then start a conversation.",
      );
      return;
    }
    if (!selectedModel) {
      setError("Wait for your available models to load.");
      return;
    }
    setError("");
    setPhase("loading");
    setBusy(true);
    busyRef.current = true;
    const id = ++turnId.current;
    try {
      const a = await prepareVoice();
      await a.loadRecognition();
      if (id !== turnId.current) return;
      streamingRecognition.current = new StreamingRecognition(
        (pcm) => a.transcribe(pcm),
        setPartialSpeech,
      );
      mic.current = new Microphone(
        (pcm, speechEndedAt) => {
          void utteranceRef.current(pcm, speechEndedAt);
        },
        setLevel,
        (pcm) => streamingRecognition.current?.push(pcm),
      );
      await mic.current.start();
      if (id !== turnId.current) {
        mic.current?.stop();
        return;
      }
      callRef.current = true;
      setCall(true);
      setMuted(false);
      mutedRef.current = false;
      setAudioOn(true);
      setNotice("Transcribing as you speak. Pause briefly for a reply.");
      listen();
    } catch (e) {
      mic.current?.stop();
      mic.current = null;
      setError(
        e instanceof Error ? e.message : "Could not start your microphone.",
      );
      setPhase("idle");
    } finally {
      if (id === turnId.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function toggleMute() {
    const next = !mutedRef.current;
    if (next) {
      streamingRecognition.current?.reset();
      setPartialSpeech("");
    }
    mutedRef.current = next;
    setMuted(next);
    if (mic.current) mic.current.enabled = !next && !busyRef.current;
    if (!busyRef.current) setPhase(next ? "idle" : "listening");
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-symbol">
            <Waves size={22} />
          </span>
          <span>
            voice<span className="brand-light">lab</span>
            <sup>β</sup>
          </span>
        </a>
        <button className="new-chat" onClick={clearChat}>
          <Plus size={17} /> New conversation <span>↗</span>
        </button>
        <div className="side-section">
          <span className="eyebrow">YOUR SPACE</span>
          <button className="nav-active">
            <Headphones size={17} /> Conversation <span className="live-dot" />
          </button>
          <button className="nav-item" onClick={() => setSettings((x) => !x)}>
            <SlidersHorizontal size={17} /> Voice & preferences
          </button>
        </div>
        <div className="setup-card">
          <span className="eyebrow">MAKE YOURSELF AT HOME</span>
          <h3>
            One connection.
            <br />A new conversation.
          </h3>
          <p>Bring your ChatGPT plan. Choose a voice that feels right.</p>
          <div className="setup-row">
            <span className={account ? "step checked" : "step"}>
              {account ? <Check size={12} /> : 1}
            </span>
            <div>
              <strong>Connect ChatGPT</strong>
              <small>
                {account ? "Account connected" : "Use your subscription"}
              </small>
            </div>
          </div>
          <div className="setup-row">
            <span className={voiceReady ? "step checked" : "step"}>
              {voiceReady ? <Check size={12} /> : 2}
            </span>
            <div>
              <strong>Find your voice</strong>
              <small>
                {voiceReady
                  ? "Ready on this device"
                  : "Preview before you begin"}
              </small>
            </div>
          </div>
          <div className="setup-row">
            <span className={call ? "step checked" : "step"}>
              {call ? <Check size={12} /> : 3}
            </span>
            <div>
              <strong>Start talking</strong>
              <small>English · headphones welcome</small>
            </div>
          </div>
        </div>
        <div className="account-area">
          {account ? (
            <>
              <div className="account-avatar">{account[0]?.toUpperCase()}</div>
              <div className="account-name">
                <strong>ChatGPT connected</strong>
                <span>{account}</span>
              </div>
            </>
          ) : (
            <>
              <div className="account-avatar">
                <ShieldCheck size={17} />
              </div>
              <div className="account-name">
                <strong>Your account, your session</strong>
                <span>Sign in to begin</span>
              </div>
            </>
          )}
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            Your space <span>/</span>
            <strong>Conversation</strong>
          </div>
          <div className="top-actions">
            <span className="local-badge">
              <span /> Voice runs on your device
            </span>
            <button
              className="icon-button settings-toggle"
              aria-label="Preferences"
              onClick={() => setSettings((x) => !x)}
            >
              <SlidersHorizontal size={19} />
            </button>
          </div>
        </header>
        <div className="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">A SPACE TO THINK OUT LOUD</span>
              <h1>A little more human.</h1>
              <p>
                Follow a thought. Practise a conversation. See where it goes.
              </p>
            </div>
            <span className="experiment">
              LOCAL EXPERIMENT <span>01</span>
            </span>
          </div>
          <div className="workspace-grid">
            <section className="conversation-card">
              <div className="card-toolbar">
                <span className="session-label">
                  <span className={call ? "status-dot active" : "status-dot"} />
                  {call ? "Conversation in progress" : "Your next conversation"}
                </span>
                <button
                  className="icon-button"
                  aria-label={
                    audioOn
                      ? "Turn spoken replies off"
                      : "Turn spoken replies on"
                  }
                  title="Spoken replies"
                  onClick={() => {
                    if (call) return;
                    setAudioOn((x) => !x);
                    audio.current?.stop();
                  }}
                >
                  <Volume2 size={18} opacity={audioOn ? 1 : 0.35} />
                </button>
              </div>
              <div className={`voice-stage ${phase}`}>
                <div className="orb-halo" />
                <div className="orb-ring ring-one" />
                <div className="orb-ring ring-two" />
                <div className="orb">
                  <div className="waveform">
                    {Array.from({ length: 9 }, (_, i) => (
                      <span
                        key={i}
                        style={{
                          height: `${14 + Math.sin((i + 1) * 0.65) ** 2 * (phase === "listening" ? 24 + level * 45 : 40)}px`,
                          animationDelay: `${i * 0.12}s`,
                        }}
                      />
                    ))}
                  </div>
                </div>
                <span className="orb-caption">
                  {phase === "listening"
                    ? "YOUR TURN"
                    : phase === "speaking"
                      ? "KOKORO VOICE"
                      : "HERE, WITH YOU"}
                </span>
              </div>
              <div className="call-copy">
                <h2>{labels[phase]}</h2>
                <p>
                  {phase === "idle"
                    ? "A good conversation starts with a simple hello."
                    : phase === "listening"
                      ? "Speak naturally. Pause when you’re ready for a reply."
                      : phase === "loading"
                        ? notice || "Preparing your voice on this device…"
                        : phase === "transcribing"
                          ? "Your microphone audio stays on this device."
                          : phase === "thinking"
                            ? "Your message is on its way to ChatGPT."
                            : "You can interrupt whenever you like."}
                </p>
              </div>
              {partialSpeech && (
                <p className="live-transcript" aria-live="polite">
                  {partialSpeech}
                </p>
              )}
              {latency.firstText !== undefined && (
                <p className="latency-summary" role="status">
                  {latency.endpoint !== undefined &&
                    `Pause ${latency.endpoint.toFixed(1)}s · `}
                  {latency.recognition !== undefined &&
                    `Transcription tail ${latency.recognition.toFixed(1)}s · `}
                  AI first text {latency.firstText.toFixed(1)}s
                  {latency.firstAudio !== undefined &&
                    ` · First audio ${latency.firstAudio.toFixed(1)}s`}
                </p>
              )}
              <div className="call-controls">
                {call ? (
                  <>
                    <button
                      className="round-button"
                      aria-label={
                        muted ? "Unmute microphone" : "Mute microphone"
                      }
                      onClick={toggleMute}
                    >
                      {muted ? <MicOff size={20} /> : <Mic size={20} />}
                    </button>
                    <button className="end-button" onClick={endCall}>
                      <Square size={14} fill="currentColor" /> End conversation
                    </button>
                    {busy && (
                      <button
                        className="round-button"
                        aria-label="Interrupt reply"
                        onClick={interrupt}
                      >
                        <X size={20} />
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    className="primary-button start-button"
                    onClick={() => void startCall()}
                    disabled={busy}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <Mic size={18} />
                    )}{" "}
                    Start conversation <ArrowRight size={17} />
                  </button>
                )}
              </div>
              <div className="stage-footer">
                <span>
                  <span
                    className={voiceReady ? "tiny-dot ready" : "tiny-dot"}
                  />{" "}
                  {voiceReady ? "Voice ready" : "Voice not loaded"}
                </span>
                <span>
                  {metric
                    ? `${metric.generation.toFixed(1)}s to generate ${metric.duration.toFixed(1)}s audio`
                    : "Kokoro · Heart & friends"}
                </span>
              </div>
            </section>
            <aside className={`preferences ${settings ? "expanded" : ""}`}>
              <div className="preferences-heading">
                <h2>Your setup</h2>
                <SlidersHorizontal size={17} />
              </div>
              <section className="preference-block">
                <label className="field-label">
                  ACCOUNT <span>{account ? "CONNECTED" : "01"}</span>
                </label>
                {!account ? (
                  <>
                    {registrations.length > 0 && (
                      <select
                        aria-label="Saved ChatGPT account"
                        value={selectedAccount}
                        onChange={(e) => setSelectedAccount(e.target.value)}
                      >
                        <option value="">Add an account or workspace</option>
                        {registrations.map((x) => (
                          <option key={x.clientId} value={x.clientId}>
                            {x.email}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      className="connect-button"
                      onClick={() => void signIn()}
                      disabled={loggingIn}
                    >
                      {loggingIn ? (
                        <LoaderCircle size={17} className="spin" />
                      ) : (
                        <span className="openai-mark">✳</span>
                      )}
                      {loggingIn
                        ? "Waiting for sign-in…"
                        : "Continue with ChatGPT"}
                      <ArrowUpRight size={16} />
                    </button>
                    {loggingIn && (
                      <button
                        className="text-link cancel-login"
                        onClick={() => void cancelSignIn()}
                      >
                        Cancel sign-in
                      </button>
                    )}
                    <p className="field-hint">
                      Uses your eligible ChatGPT plan and its usage limits.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="connected-note">
                      <Check size={16} /> Your plan is connected
                    </div>
                    <a
                      className="text-link"
                      href="https://chatgpt.com/settings/usage"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Manage plan usage <ArrowUpRight size={12} />
                    </a>
                  </>
                )}
              </section>
              <section className="preference-block">
                <label className="field-label" htmlFor="model">
                  CONVERSATION MODEL <span>02</span>
                </label>
                <div className="select-wrap">
                  <select
                    id="model"
                    value={model}
                    onChange={(e) => {
                      clearChat();
                      setModel(e.target.value);
                      setReasoning("");
                    }}
                    onFocus={() => void refreshModels()}
                    disabled={!catalog.length || busy || call}
                  >
                    {!catalog.length && (
                      <option value="">
                        {loadingModels
                          ? "Loading your models…"
                          : account
                            ? "Models unavailable"
                            : "Connect to see your models"}
                      </option>
                    )}
                    {catalog.map((x) => (
                      <option key={x.slug} value={x.slug}>
                        {x.display_name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </div>
                {account && (
                  <div className="model-status">
                    <p className="field-hint" role="status">
                      {loadingModels
                        ? "Updating available models…"
                        : modelError ||
                          `${catalog.length} models available for your account`}
                    </p>
                    <button
                      type="button"
                      className="text-link refresh-models"
                      disabled={loadingModels || busy || call}
                      onClick={() => void refreshModels(true)}
                    >
                      {modelError ? "Retry model list" : "Refresh models"}
                    </button>
                  </div>
                )}
                <div className="reasoning-control">
                  <label className="field-label" htmlFor="reasoning">
                    REASONING LEVEL
                  </label>
                  <div className="select-wrap">
                    <select
                      id="reasoning"
                      value={reasoningEffort}
                      onChange={(e) => setReasoning(e.target.value)}
                      disabled={
                        !selectedModel?.supported_reasoning_levels.length ||
                        busy ||
                        call
                      }
                      aria-describedby="reasoning-description"
                    >
                      {!selectedModel?.supported_reasoning_levels.length && (
                        <option value="">
                          {selectedModel
                            ? "Model default"
                            : "Choose a model first"}
                        </option>
                      )}
                      {selectedModel?.supported_reasoning_levels.map(
                        (level) => (
                          <option key={level.effort} value={level.effort}>
                            {reasoningLabel(level.effort)}
                          </option>
                        ),
                      )}
                    </select>
                    <ChevronDown size={15} />
                  </div>
                  <p id="reasoning-description" className="field-hint">
                    {selectedModel?.supported_reasoning_levels.find(
                      (level) => level.effort === reasoningEffort,
                    )?.description ||
                      (selectedModel
                        ? "This model does not offer adjustable reasoning."
                        : "Available levels depend on the selected model.")}
                  </p>
                </div>
              </section>
              <section className="preference-block">
                <label className="field-label" htmlFor="voice">
                  VOICE <span>03</span>
                </label>
                <div className="select-wrap">
                  <select
                    id="voice"
                    value={voice}
                    disabled={busy || call}
                    onChange={(e) => setVoice(e.target.value)}
                  >
                    <option value="af_heart">Heart · American English</option>
                    <option value="af_bella">Bella · American English</option>
                    <option value="am_adam">Adam · American English</option>
                    <option value="bf_emma">Emma · British English</option>
                    <option value="bm_george">George · British English</option>
                  </select>
                  <ChevronDown size={15} />
                </div>
                <button
                  className="preview-button"
                  onClick={() => void preview()}
                  disabled={busy || call}
                >
                  {loadingVoice ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Volume2 size={15} />
                  )}{" "}
                  {loadingVoice ? "Loading voice…" : "Preview voice"}{" "}
                  <span>↗</span>
                </button>
              </section>
              <section className="preference-block engine-block">
                <label className="field-label" htmlFor="engine">
                  RUN VOICE WITH
                </label>
                <div className="select-wrap">
                  <select
                    id="engine"
                    value={engine}
                    disabled={busy || call}
                    onChange={(e) => {
                      setEngine(e.target.value as Engine);
                      audio.current?.resetVoice();
                      setVoiceReady(false);
                      setActualEngine("Not loaded");
                    }}
                  >
                    <option value="auto">Auto · best available</option>
                    <option value="webgpu" disabled={!hasGPU}>
                      WebGPU · device GPU
                    </option>
                    <option value="wasm">WebAssembly · device CPU</option>
                  </select>
                  <ChevronDown size={15} />
                </div>
                <p className="field-hint">
                  {voiceReady
                    ? `Running with ${actualEngine}.`
                    : "The first preview downloads the voice model."}
                </p>
              </section>
              <div className="session-note">
                <ShieldCheck size={16} />
                <p>
                  Sign-in is saved in this browser and renewed automatically.
                  <span>Audio is transcribed locally as you speak.</span>
                </p>
              </div>
            </aside>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          <section className="transcript-card">
            <div className="transcript-heading">
              <h2>The conversation</h2>
              <span>
                {messages.length ? "THIS SESSION ONLY" : "A CLEAN SLATE"}
              </span>
            </div>
            <div
              className="transcript"
              aria-live="polite"
              aria-relevant="additions text"
            >
              {messages.length ? (
                messages.map((m) => (
                  <article key={m.id} className={`message ${m.role}`}>
                    <span className="message-avatar">
                      {m.role === "user" ? "Y" : <Waves size={15} />}
                    </span>
                    <div>
                      <span className="message-author">
                        {m.role === "user" ? "You" : "Voice Lab"}
                        {m.failed && <small> · interrupted</small>}
                      </span>
                      <p>{m.text || "Thinking…"}</p>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-transcript">
                  <span className="empty-icon">
                    <Waves size={21} />
                  </span>
                  <div>
                    <strong>Room for whatever’s on your mind.</strong>
                    <p>
                      Your conversation will appear here. You can talk or type.
                    </p>
                  </div>
                </div>
              )}
              <div ref={transcriptEnd} />
            </div>
            {!messages.length && (
              <div className="suggestions">
                {[
                  "Let’s practise an interview",
                  "Help me think through an idea",
                  "Tell me something surprising",
                ].map((x) => (
                  <button
                    key={x}
                    disabled={busy}
                    onClick={() => void sendText(x)}
                  >
                    {x}
                    <ArrowUpRight size={12} />
                  </button>
                ))}
              </div>
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void sendText(draft);
              }}
            >
              <input
                aria-label="Message"
                placeholder="Or, start with a message…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={busy}
              />
              {busy ? (
                <button
                  type="button"
                  aria-label="Stop response"
                  onClick={interrupt}
                >
                  <Square size={15} />
                </button>
              ) : (
                <button
                  type="submit"
                  aria-label="Send message"
                  disabled={!draft.trim()}
                >
                  <Send size={17} />
                </button>
              )}
            </form>
          </section>
          <footer className="page-footer">
            <span>Made for conversations, not recordings.</span>
            <span>
              Local speech recognition <span>·</span> OpenAI via local relay{" "}
              <span>·</span> Browser voice
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}
