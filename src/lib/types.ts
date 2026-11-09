export type Session = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  clientId: string;
  subject: string;
  email: string;
  expiresAt: number;
  scopes: string[];
};
export type Registration = { clientId: string; subject: string; email: string };
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  failed?: boolean;
};
export type ReasoningLevel = { effort: string; description: string };
export type Model = {
  slug: string;
  display_name: string;
  default_reasoning_level?: string;
  supported_reasoning_levels: ReasoningLevel[];
};
export type Engine = "auto" | "webgpu" | "wasm";
export type WorkerRequest = {
  id: number;
  kind: "load" | "speak" | "transcribe";
  engine?: Engine;
  text?: string;
  voice?: string;
  audio?: Float32Array;
};
export type WorkerReply = {
  id: number;
  kind: "progress" | "ready" | "audio" | "transcript" | "error";
  message?: string;
  text?: string;
  audio?: Float32Array;
  sampleRate?: number;
  engine?: string;
  seconds?: number;
};
