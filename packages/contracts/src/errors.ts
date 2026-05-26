// Error taxonomy. Every failure in the system maps to one of these codes so the
// frontend can render a consistent, non-silent state for each.
export const ErrorCode = {
  /** Provider key out of credits (Orthogonal 402). */
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  /** Upstream provider 5xx / unreachable. */
  PROVIDER_DOWN: "PROVIDER_DOWN",
  /** Call exceeded our timeout. */
  TIMEOUT: "TIMEOUT",
  /** Orthogonal api/path not found (404). */
  NOT_FOUND: "NOT_FOUND",
  /** Spend would cross the configured cap and was not approved. */
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  /** Auth/session failure (401). */
  AUTH: "AUTH",
  /** Malformed request (400). */
  BAD_REQUEST: "BAD_REQUEST",
  /** A tool call's outcome could not be determined (crash mid-call); needs reconciliation. */
  TOOL_UNKNOWN_STATE: "TOOL_UNKNOWN_STATE",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface OrthaErrorOptions {
  /** Provider slug involved, if any (e.g. "apollo"). */
  readonly providerSlug?: string;
  /** Whether retrying (possibly via self-heal) could succeed. */
  readonly retryable?: boolean;
  /**
   * Whether the upstream provider MAY have executed and charged despite this failure.
   * `false` for input-rejected 4xx (the gateway never ran the paid call — safe to fix
   * the input and retry). `true` for ambiguous outcomes (5xx after the request landed,
   * or a timeout on a paid call) — the local hold is released, but the charge may have
   * happened server-side and needs reconciliation. Lets callers decide refund/retry safety.
   */
  readonly maybeBilled?: boolean;
  readonly cause?: unknown;
}

/** The single error type thrown across module boundaries. */
export class OrthaError extends Error {
  readonly code: ErrorCode;
  readonly providerSlug: string | undefined;
  readonly retryable: boolean;
  readonly maybeBilled: boolean;

  constructor(code: ErrorCode, message: string, options: OrthaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OrthaError";
    this.code = code;
    this.providerSlug = options.providerSlug;
    this.retryable = options.retryable ?? false;
    this.maybeBilled = options.maybeBilled ?? false;
  }
}

export const isOrthaError = (e: unknown): e is OrthaError => e instanceof OrthaError;
