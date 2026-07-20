import Anthropic from "@anthropic-ai/sdk";
import * as Sentry from "@sentry/nextjs";

// Single place that constructs the Anthropic client. Wrapped with Sentry AI
// monitoring so every Claude call (messages / beta.messages / stream) emits a
// gen_ai.* span carrying model, token counts, estimated cost, and latency.
//
// Manual wrapping (vs. relying on the auto anthropicAIIntegration) is deliberate:
// Next.js/Vercel server bundling can defeat the integration's import-time
// patching, so it silently captures nothing. The proxy wrapper here is
// bundling-proof — verified to emit a gen_ai.chat span end-to-end.
export function createAnthropic(): Anthropic {
  return Sentry.instrumentAnthropicAiClient(
    new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  );
}
