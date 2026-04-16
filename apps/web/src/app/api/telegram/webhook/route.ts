import { NextResponse } from "next/server";
import {
  addMessage,
  createServerClient,
  decrypt,
  getActiveSession,
  getOrCreateSession,
  getRecentPendingContexts,
  startNewSession,
  updateMessageContextStatus,
} from "@agents/db";
import { buildSystemPrompt, resolvePendingContextReply, resumeAgent, runAgent } from "@agents/agent";
import type { HitlResumeDecision, UserIntegration, UserToolSetting } from "@agents/types";
import { sendTelegramMessage as sendTelegramMessageRaw } from "@/lib/telegram";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string };
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { chat: { id: number }; message_id: number };
    data: string;
  };
}

async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
) {
  try {
    await sendTelegramMessageRaw(chatId, text, replyMarkup);
  } catch (error) {
    console.error("Telegram sendMessage failed:", error);
  }
}

/** Telegram sends "/cmd@BotName args" when the user picks a command from the menu. */
function parseBotCommand(messageText: string): { command: string; args: string } {
  const trimmed = messageText.trim();
  const i = trimmed.indexOf(" ");
  const head = i === -1 ? trimmed : trimmed.slice(0, i);
  const tail = i === -1 ? "" : trimmed.slice(i + 1).trim();
  const at = head.indexOf("@");
  const command = (at === -1 ? head : head.slice(0, at)).toLowerCase();
  return { command, args: tail };
}

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function resumeHitlForTelegramUser(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  sessionId: string,
  decision: HitlResumeDecision
) {
  const { data: profile } = await db
    .from("profiles")
    .select("agent_system_prompt, timezone")
    .eq("id", userId)
    .single();
  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);
  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  let githubToken: string | undefined;
  const ghIntegration = (integrations ?? []).find(
    (i: Record<string, unknown>) => i.provider === "github"
  );
  if (ghIntegration && (ghIntegration as Record<string, unknown>).encrypted_tokens) {
    try {
      githubToken = decrypt(
        (ghIntegration as Record<string, unknown>).encrypted_tokens as string
      );
    } catch {
      console.error("Failed to decrypt GitHub token for Telegram user", userId);
    }
  }
  let googleCalendarToken: string | undefined;
  const gcalIntegration = (integrations ?? []).find(
    (i: Record<string, unknown>) => i.provider === "google_calendar"
  );
  if (gcalIntegration && (gcalIntegration as Record<string, unknown>).encrypted_tokens) {
    try {
      googleCalendarToken = decrypt(
        (gcalIntegration as Record<string, unknown>).encrypted_tokens as string
      );
    } catch {
      console.error("Failed to decrypt GCal token for Telegram user", userId);
    }
  }

  return resumeAgent({
    userId,
    sessionId,
    systemPrompt: buildSystemPrompt(
      profile?.agent_system_prompt ?? "Eres un asistente útil.",
      (profile?.timezone as string) ?? "America/Bogota"
    ),
    db,
    enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
      id: t.id as string,
      user_id: t.user_id as string,
      tool_id: t.tool_id as string,
      enabled: t.enabled as boolean,
      config_json: (t.config_json as Record<string, unknown>) ?? {},
    })) as UserToolSetting[],
    integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
      id: i.id as string,
      user_id: i.user_id as string,
      provider: i.provider as string,
      scopes: (i.scopes as string[]) ?? [],
      status: i.status as "active" | "revoked" | "expired",
      created_at: i.created_at as string,
    })) as UserIntegration[],
    githubToken,
    googleCalendarToken,
    userTimezone: (profile?.timezone as string) ?? "UTC",
    decision,
  });
}

const hitlKeyboard = {
  inline_keyboard: [
    [
      { text: "Aprobar", callback_data: "hitl_approve" },
      { text: "Cancelar", callback_data: "hitl_reject" },
    ],
  ],
};

export async function POST(request: Request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const update: TelegramUpdate = await request.json();
  const db = createServerClient();

  // Handle callback queries (confirmation buttons)
  if (update.callback_query) {
    const cb = update.callback_query;
    const action = cb.data;
    const { data: telegramAccount } = await db
      .from("telegram_accounts")
      .select("user_id")
      .eq("telegram_user_id", cb.from.id)
      .maybeSingle();
    if (!telegramAccount) {
      await answerCallbackQuery(cb.id, "Cuenta no vinculada");
      await sendTelegramMessage(
        cb.message.chat.id,
        "No tienes una cuenta vinculada. Usa /link TU_CODIGO."
      );
      return NextResponse.json({ ok: true });
    }
    const expectedSession = await getActiveSession(db, telegramAccount.user_id, "telegram");
    if (!expectedSession) {
      await answerCallbackQuery(cb.id, "Sesion no activa");
      await sendTelegramMessage(
        cb.message.chat.id,
        "No hay una sesion activa para confirmar esta accion. Envia /new y vuelve a intentarlo."
      );
      return NextResponse.json({ ok: true });
    }
    const expectedSessionId = expectedSession.id;

    if (action === "hitl_approve") {
      await answerCallbackQuery(cb.id, "Aprobado");
      const result = await resumeHitlForTelegramUser(
        db,
        telegramAccount.user_id,
        expectedSessionId,
        { decision: "approve" }
      );
      if (result.error) {
        await sendTelegramMessage(cb.message.chat.id, result.error);
      } else if (result.pendingConfirmation) {
        await sendTelegramMessage(cb.message.chat.id, result.pendingConfirmation.message, hitlKeyboard);
      } else {
        await sendTelegramMessage(cb.message.chat.id, result.response);
      }
    } else if (action === "hitl_reject") {
      await answerCallbackQuery(cb.id, "Rechazado");
      const result = await resumeHitlForTelegramUser(
        db,
        telegramAccount.user_id,
        expectedSessionId,
        {
          decision: "reject",
          message: "Acción cancelada desde Telegram.",
        }
      );
      if (result.error) {
        await sendTelegramMessage(cb.message.chat.id, result.error);
      } else {
        await sendTelegramMessage(cb.message.chat.id, result.response || "Accion cancelada.");
      }
    }

    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message?.text) {
    return NextResponse.json({ ok: true });
  }

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();
  const { command, args } = parseBotCommand(text);

  // Handle /start (/start@BotName optional)
  if (command === "/start") {
    await sendTelegramMessage(
      chatId,
      "¡Hola! Soy tu agente personal.\n\nSi ya tienes cuenta web, ve a Ajustes → Telegram en la web, genera un código de vinculación y envíamelo así:\n/link TU_CODIGO"
    );
    return NextResponse.json({ ok: true });
  }

  // Handle /link CODE (/link@BotName CODE when chosen from the command list)
  if (command === "/link") {
    const code = args.trim().toUpperCase();
    if (!code) {
      await sendTelegramMessage(
        chatId,
        "Indica el código que generaste en la web, por ejemplo:\n/link ABC123"
      );
      return NextResponse.json({ ok: true });
    }

    const { data: linkRecord } = await db
      .from("telegram_link_codes")
      .select("*")
      .eq("code", code)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (!linkRecord) {
      await sendTelegramMessage(chatId, "Código inválido o expirado. Genera uno nuevo desde la web.");
      return NextResponse.json({ ok: true });
    }

    await db.from("telegram_accounts").upsert(
      {
        user_id: linkRecord.user_id,
        telegram_user_id: telegramUserId,
        chat_id: chatId,
        linked_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    await db
      .from("telegram_link_codes")
      .update({ used: true })
      .eq("id", linkRecord.id);

    await sendTelegramMessage(chatId, "¡Cuenta vinculada correctamente! Ya puedes chatear conmigo.");
    return NextResponse.json({ ok: true });
  }

  // Resolve user from telegram_user_id
  const { data: telegramAccount } = await db
    .from("telegram_accounts")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .single();

  if (!telegramAccount) {
    await sendTelegramMessage(
      chatId,
      "No tienes una cuenta vinculada. Usa /link TU_CODIGO (código desde Ajustes en la web)."
    );
    return NextResponse.json({ ok: true });
  }

  const userId = telegramAccount.user_id;

  if (command === "/new") {
    await startNewSession(db, userId, "telegram");
    await sendTelegramMessage(chatId, "Nueva sesion iniciada.");
    return NextResponse.json({ ok: true });
  }

  // Get or create session
  const session = await getOrCreateSession(db, userId, "telegram");

  if (!session) {
    await sendTelegramMessage(chatId, "Error interno creando sesión.");
    return NextResponse.json({ ok: true });
  }

  // Load profile, tools, integrations
  const { data: profile } = await db
    .from("profiles")
    .select("agent_system_prompt, timezone")
    .eq("id", userId)
    .single();

  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);

  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  // Decrypt GitHub token if available
  let githubToken: string | undefined;
  const ghIntegration = (integrations ?? []).find(
    (i: Record<string, unknown>) => i.provider === "github"
  );
  if (ghIntegration && (ghIntegration as Record<string, unknown>).encrypted_tokens) {
    try {
      githubToken = decrypt((ghIntegration as Record<string, unknown>).encrypted_tokens as string);
    } catch {
      console.error("Failed to decrypt GitHub token for Telegram user", userId);
    }
  }

  // Decrypt Google Calendar token if available
  let googleCalendarToken: string | undefined;
  const gcalIntegration = (integrations ?? []).find(
    (i: Record<string, unknown>) => i.provider === "google_calendar"
  );
  if (gcalIntegration && (gcalIntegration as Record<string, unknown>).encrypted_tokens) {
    try {
      googleCalendarToken = decrypt((gcalIntegration as Record<string, unknown>).encrypted_tokens as string);
    } catch {
      console.error("Failed to decrypt Google Calendar token for Telegram user", userId);
    }
  }

  try {
    const pendingContexts = await getRecentPendingContexts(db, session.id);
    const pendingResolution = resolvePendingContextReply(text, session.id, pendingContexts);

    if (pendingResolution.kind === "no_match" || pendingResolution.kind === "ambiguous") {
      await addMessage(db, session.id, "user", text);
      await addMessage(db, session.id, "assistant", pendingResolution.clarification);
      await sendTelegramMessage(chatId, pendingResolution.clarification);
      return NextResponse.json({ ok: true });
    }

    let contextInstruction: string | undefined;
    let messageForAgent = text;
    if (pendingResolution.kind === "resolve_pending_input") {
      await updateMessageContextStatus(db, session.id, pendingResolution.messageId, "resolved");
      messageForAgent = pendingResolution.rewrittenMessage;
      contextInstruction =
        "Solo continua el contexto activo indicado por el ultimo mensaje del usuario y evita reutilizar acciones viejas.";
    }

    const result = await runAgent({
      message: messageForAgent,
      userId,
      sessionId: session.id,
      systemPrompt: buildSystemPrompt(
        profile?.agent_system_prompt ?? "Eres un asistente útil.",
        (profile?.timezone as string) ?? "America/Bogota"
      ),
      db,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })),
      integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
        id: i.id as string,
        user_id: i.user_id as string,
        provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [],
        status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })),
      githubToken,
      googleCalendarToken,
      userTimezone: (profile?.timezone as string) ?? "UTC",
      contextInstruction,
    });

    if (result.pendingConfirmation) {
      const pc = result.pendingConfirmation;
      await sendTelegramMessage(chatId, pc.message, hitlKeyboard);
    } else {
      await sendTelegramMessage(chatId, result.response);
    }
  } catch (error) {
    console.error("Telegram agent error:", error);
    await sendTelegramMessage(chatId, "Hubo un error procesando tu mensaje. Intenta de nuevo.");
  }

  return NextResponse.json({ ok: true });
}
