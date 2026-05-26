// Branded ID types. Prevents passing a ConversationId where a UserId is expected.
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type ConversationId = Brand<string, "ConversationId">;
export type MessageId = Brand<string, "MessageId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type RequestId = Brand<string, "RequestId">;
/** Deterministic key for at-least-once tool execution. Hash of api+path+body+stepId. */
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

export const asUserId = (s: string): UserId => s as UserId;
export const asWorkspaceId = (s: string): WorkspaceId => s as WorkspaceId;
export const asConversationId = (s: string): ConversationId => s as ConversationId;
export const asMessageId = (s: string): MessageId => s as MessageId;
export const asToolCallId = (s: string): ToolCallId => s as ToolCallId;
export const asRequestId = (s: string): RequestId => s as RequestId;
export const asIdempotencyKey = (s: string): IdempotencyKey => s as IdempotencyKey;
