// UI view-models derived from the TraceEvent contract stream.
export type StepStatus = "searching" | "running" | "success" | "failed" | "skipped";

export interface TraceStep {
  stepId: string;
  api?: string;
  path?: string;
  estCents?: number;
  status: StepStatus;
  summary?: string;
  requestId?: string;
  priceCents?: number;
  latencyMs?: number;
  heal?: { failed: string; alt: string };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps: TraceStep[];
  streaming: boolean;
  error?: { code: string; message: string };
}

export interface CostState {
  sessionCents: number;
  capCents: number;
  remainingCents: number;
}

export interface RawArtifact {
  title: string;
  requestId: string;
  data: unknown;
}
