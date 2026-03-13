/**
 * WebSocket client for communicating with the FastAPI + ADK backend.
 * Follows the bidi-demo protocol: binary frames for PCM audio,
 * JSON text frames for text/image messages.
 */
export type CodeFile = {
  path: string;
  code: string;
  language: string;
};

import { getExtensionForLanguage } from "@/lib/utils";

export type GeneratedImagePayload = {
  url: string;
  name: string;
  mimeType?: string;
  data?: string;
};

function inferLanguageFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  const languages: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    tsx: "tsx",
    jsx: "jsx",
    py: "python",
    html: "html",
    css: "css",
    json: "json",
    md: "markdown",
    sql: "sql",
    sh: "shell",
  };

  return languages[extension || ""] || "text";
}

function sanitizeCodeFiles(input: unknown): CodeFile[] {
  if (!Array.isArray(input)) return [];

  return input
    .filter((file): file is Record<string, unknown> =>
      Boolean(file && typeof file === "object"),
    )
    .map((file, index) => {
      const rawPath = typeof file.path === "string" ? file.path.trim() : "";
      const language =
        typeof file.language === "string" && file.language.trim().length > 0
          ? file.language
          : inferLanguageFromPath(rawPath);
      const path =
        rawPath ||
        `generated/file-${index + 1}.${getExtensionForLanguage(language)}`;

      if (!rawPath) {
        console.warn(
          "[WS] Received code file without a valid path; using fallback:",
          file,
        );
      }

      return {
        path,
        code: typeof file.code === "string" ? file.code : "",
        language,
      };
    });
}

export type WSEventHandlers = {
  onAudio?: (pcmData: ArrayBuffer) => void;
  onText?: (text: string, partial: boolean) => void;
  onCode?: (files: CodeFile[]) => void;
  onCodeAgentStarted?: () => void;
  onCodeAgentFinished?: () => void;
  onImageGenerationStarted?: () => void;
  onImageGenerationFinished?: () => void;
  onGeneratedImage?: (image: GeneratedImagePayload) => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onSessionTimeout?: (reason: "idle" | "hard_limit") => void;
  onError?: (message: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

const BACKEND_WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://localhost:8000";

export class MonetWebSocket {
  private ws: WebSocket | null = null;
  private handlers: WSEventHandlers;
  private userId: string;
  private sessionId: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 8;

  constructor(userId: string, sessionId: string, handlers: WSEventHandlers) {
    this.userId = userId;
    this.sessionId = sessionId;
    this.handlers = handlers;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.ws?.readyState === WebSocket.CONNECTING) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const url = `${BACKEND_WS_URL}/ws/${this.userId}/${this.sessionId}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.handlers.onOpen?.();
    };

    this.ws.onclose = (event: CloseEvent) => {
      if (event.code === 4000 || event.code === 4001) {
        this.shouldReconnect = false;
      }
      this.handlers.onClose?.();
      this.ws = null;

      if (
        this.shouldReconnect &&
        this.reconnectAttempts < this.maxReconnectAttempts
      ) {
        const delay = Math.min(500 * 2 ** this.reconnectAttempts, 4000) + Math.random() * 1000;
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => {
          this.connect();
        }, delay);
      }
    };

    this.ws.onerror = () => {
      this.handlers.onError?.("WebSocket connection error");
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.handlers.onAudio?.(event.data);
        return;
      }

      try {
        const msg = JSON.parse(event.data as string);
        try {
          this.handleMessage(msg);
        } catch (err) {
          console.error("[WS] Error in handleMessage:", err);
        }
      } catch {
        // Not JSON, ignore
      }
    };
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Custom code event from our backend
    if (msg.type === "code_agent_started") {
      this.handlers.onCodeAgentStarted?.();
      return;
    }

    if (msg.type === "code_agent_finished") {
      this.handlers.onCodeAgentFinished?.();
      return;
    }

    if (msg.type === "image_generation_started") {
      this.handlers.onImageGenerationStarted?.();
      return;
    }

    if (msg.type === "image_generation_finished") {
      this.handlers.onImageGenerationFinished?.();
      return;
    }

    if (msg.type === "generated_image") {
      this.handlers.onGeneratedImage?.({
        url: typeof msg.url === "string" ? msg.url : "",
        name:
          typeof msg.name === "string" && msg.name.length > 0
            ? msg.name
            : "generated-image.png",
        mimeType: typeof msg.mimeType === "string" ? msg.mimeType : undefined,
        data: typeof msg.data === "string" ? msg.data : undefined,
      });
      return;
    }

    if (msg.type === "session_timeout") {
      this.handlers.onSessionTimeout?.(msg.reason as "idle" | "hard_limit");
      return;
    }

    if (msg.type === "code") {
      this.handlers.onCode?.(sanitizeCodeFiles(msg.files));
      return;
    }

    // Error event from backend
    if (msg.type === "error") {
      this.handlers.onError?.(
        (msg.message as string) || (msg.errorCode as string) || "Unknown error",
      );
      return;
    }

    // ADK Event fields are at the top level (not nested under serverContent)
    if (msg.turnComplete) {
      this.handlers.onTurnComplete?.();
    }

    if (msg.interrupted) {
      this.handlers.onInterrupted?.();
    }

    // Content with parts (text and audio)
    const content = msg.content as
      | { parts?: Array<Record<string, unknown>> }
      | undefined;
    const isPartial = Boolean(msg.partial);

    if (content?.parts) {
      for (const part of content.parts) {
        if (part.text) {
          this.handlers.onText?.(part.text as string, isPartial);
        }

        const inlineData = part.inlineData as
          | { mimeType?: string; data?: string }
          | undefined;
        if (inlineData?.data && inlineData.mimeType?.startsWith("audio/")) {
          let b64 = inlineData.data;
          b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
          const pad = b64.length % 4;
          if (pad) b64 += "=".repeat(4 - pad);

          const binaryStr = atob(b64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          this.handlers.onAudio?.(bytes.buffer);
        }
      }
    }
  }

  sendAudio(pcmData: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcmData);
    }
  }

  sendText(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "text", text }));
    }
  }

  sendImage(base64Data: string, mimeType: string = "image/jpeg"): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ type: "image", data: base64Data, mimeType }),
      );
    }
  }

  sendImageGenerationFrame(
    base64Data: string | null,
    mimeType: string = "image/png",
  ): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "image_generation_frame",
          data: base64Data,
          mimeType,
        }),
      );
    }
  }

  sendImageUpload(url: string, name: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "image_upload", url, name }));
    }
  }

  sendRuntimeError(error: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "runtime_error",
          error,
        }),
      );
    }
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
