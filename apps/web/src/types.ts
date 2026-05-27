// UI view-models derived from the TraceEvent contract stream.
import type { PermissionResponse, TraceEvent } from "@ortha/contracts";

/** Callbacks a transport drives as it streams one turn from the worker. */
export interface TurnDeps {
  onEvent: (e: TraceEvent) => void;
  requestPermission: (e: Extract<TraceEvent, { type: "permission_required" }>) => Promise<PermissionResponse>;
  rawStore: Map<string, unknown>;
  startCents: number;
  capCents: number;
}

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
