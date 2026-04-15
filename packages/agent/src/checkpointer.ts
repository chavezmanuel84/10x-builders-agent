import { MemorySaver } from "@langchain/langgraph";

let postgresSaverPromise: Promise<unknown> | null = null;

/**
 * LangGraph checkpointer: Postgres when DATABASE_URL (or LANGGRAPH_DATABASE_URL) is set,
 * otherwise MemorySaver (single-process only; HITL will not survive restarts).
 */
export async function getLangGraphCheckpointer(): Promise<unknown> {
  const conn =
    process.env.LANGGRAPH_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    "";

  if (!conn) {
    console.error(
      "[checkpointer] WARNING: Neither LANGGRAPH_DATABASE_URL nor DATABASE_URL is set. " +
        "Falling back to MemorySaver (in-process only). " +
        "HITL confirmations will NOT survive process restarts — resumeAgent() will return 409 " +
        "in any environment where requests are served by separate processes (e.g. serverless). " +
        "Set LANGGRAPH_DATABASE_URL or DATABASE_URL to enable persistent HITL."
    );
    return new MemorySaver();
  }

  if (!postgresSaverPromise) {
    postgresSaverPromise = (async () => {
      const { PostgresSaver } = await import(
        "@langchain/langgraph-checkpoint-postgres"
      );
      const schema =
        process.env.LANGGRAPH_CHECKPOINT_SCHEMA?.trim() || "langgraph";
      const saver = PostgresSaver.fromConnString(conn, { schema });
      try {
        await saver.setup();
      } catch (e) {
        const setupErr = e instanceof Error ? e.message : String(e);
        throw new Error(setupErr || "PostgresSaver.setup failed");
      }
      return saver;
    })();
  }

  return postgresSaverPromise;
}
