"use client";

import { Fragment, type ReactNode, useState, useRef, useEffect } from "react";

interface Message {
  role: string;
  content: string;
  created_at?: string;
}

interface Confirmation {
  toolCallId: string;
  toolName: string;
  message: string;
  args: Record<string, unknown>;
}

interface Props {
  agentName: string;
  initialMessages: Message[];
}

const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(([^)\s]+)\)/g;

function getSafeHref(url: string): string | null {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function getLinkLabel(label: string, url: string): string {
  const cleanLabel = label.trim();
  if (cleanLabel) return cleanLabel;
  return url.length > 60 ? "Ver enlace" : url;
}

function renderMessageContent(content: string): ReactNode {
  return content.split("\n").map((line, lineIndex, lines) => {
    const segments: ReactNode[] = [];
    let lastIndex = 0;

    for (const match of line.matchAll(MARKDOWN_LINK_REGEX)) {
      const start = match.index ?? 0;
      const fullMatch = match[0];
      const label = match[1] ?? "";
      const url = match[2] ?? "";

      if (start > lastIndex) {
        segments.push(line.slice(lastIndex, start));
      }

      const safeHref = getSafeHref(url);
      if (safeHref) {
        segments.push(
          <a
            key={`link-${lineIndex}-${start}`}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-blue-400/70 underline-offset-2 break-words [overflow-wrap:anywhere] hover:text-blue-500 dark:hover:text-blue-300"
          >
            {getLinkLabel(label, safeHref)}
          </a>
        );
      } else {
        segments.push(fullMatch);
      }

      lastIndex = start + fullMatch.length;
    }

    if (lastIndex < line.length) {
      segments.push(line.slice(lastIndex));
    }

    return (
      <Fragment key={`line-${lineIndex}`}>
        {segments}
        {lineIndex < lines.length - 1 ? <br /> : null}
      </Fragment>
    );
  });
}

export function ChatInterface({ agentName, initialMessages }: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<Confirmation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();

      if (data.pendingConfirmation) {
        setPendingConfirm(data.pendingConfirmation);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.pendingConfirmation.message,
          },
        ]);
      } else if (data.response) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error al procesar tu mensaje. Intenta de nuevo." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(action: "approve" | "reject") {
    if (!pendingConfirm) return;
    setConfirming(true);

    try {
      const res = await fetch("/api/chat/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolCallId: pendingConfirm.toolCallId,
          action,
        }),
      });
      const data = await res.json();

      if (action === "approve" && data.result) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Acción ejecutada: ${JSON.stringify(data.result)}`,
          },
        ]);
      } else if (action === "reject") {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "Acción cancelada." },
        ]);
      } else if (data.error) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${data.error}` },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error al confirmar la acción." },
      ]);
    } finally {
      setPendingConfirm(null);
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-sm text-neutral-400 py-20">
              <p className="text-lg font-medium text-neutral-600 dark:text-neutral-300">
                ¡Hola! Soy {agentName}
              </p>
              <p className="mt-1">Escribe un mensaje para comenzar.</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                }`}
              >
                <div className="break-words [overflow-wrap:anywhere]">
                  {renderMessageContent(msg.content)}
                </div>
              </div>
            </div>
          ))}

          {/* Confirmation buttons */}
          {pendingConfirm && (
            <div className="flex justify-start">
              <div className="flex gap-2 rounded-lg bg-neutral-100 px-4 py-3 dark:bg-neutral-800">
                <button
                  onClick={() => handleConfirm("approve")}
                  disabled={confirming}
                  className="rounded-md bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {confirming ? "Ejecutando..." : "Aprobar"}
                </button>
                <button
                  onClick={() => handleConfirm("reject")}
                  disabled={confirming}
                  className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm font-medium hover:bg-neutral-200 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-700"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {loading && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm dark:bg-neutral-800">
                <span className="animate-pulse">Pensando...</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <form
          onSubmit={handleSend}
          className="mx-auto flex max-w-2xl gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Escribe tu mensaje..."
            disabled={loading}
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
