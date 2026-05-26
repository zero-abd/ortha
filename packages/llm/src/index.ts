// @ortha/llm — LLMProvider adapters that normalize each provider's streaming +
// tool calling into the frozen LLMEvent union ({token}|{tool_call_request}|
// {usage}|{done}). Two adapter shapes cover all four providers:
//   - createAnthropicProvider          -> Anthropic Messages API (native SSE)
//   - createOpenAICompatProvider       -> OpenAI / OpenRouter / Gemini (compat)
// The network layer is injectable (`transport`) so tests feed canned streams
// with no real network. INVARIANT: each adapter is single-provider sufficient.
export { createAnthropicProvider, type AnthropicProviderConfig } from "./anthropic.js";
export {
  createOpenAICompatProvider,
  type OpenAICompatProviderConfig,
  type OpenAICompatQuirks,
  OPENAI_QUIRKS,
  OPENROUTER_QUIRKS,
  GEMINI_QUIRKS,
} from "./openai-compat.js";
export {
  createModelRegistry,
  defaultModelRegistry,
  type CreateModelRegistryOptions,
} from "./registry.js";
export {
  fetchSseTransport,
  decodeSse,
  type Transport,
  type TransportRequest,
} from "./transport.js";
