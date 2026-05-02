export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // LangChain >=0.3 backgrounds callbacks by default; force them blocking
  // so Langfuse OTel spans flush before short-lived Next.js API routes return.
  process.env.LANGCHAIN_CALLBACKS_BACKGROUND ??= "false";

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { LangfuseSpanProcessor } = await import("@langfuse/otel");

  const sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  sdk.start();
}
