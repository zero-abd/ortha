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
  /** Data URLs for images attached to a user message (vision input). */
  images?: string[];
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

/** One tracked agent run (a chat turn or a batch row) shown in the Agents panel. */
export interface AgentRun {
  id: string;
  /** Short label, e.g. the user's prompt or the batch row's inputs. */
  title: string;
  kind: "chat" | "batch";
  status: "running" | "done" | "error";
  startedAt: number;
  endedAt?: number;
  /** Paid tool spend for this run, in cents. */
  costCents: number;
  /** The run's tool trace, same shape the inline chat trace uses. */
  steps: TraceStep[];
  /** Streamed answer text. */
  answer: string;
  error?: string;
}
