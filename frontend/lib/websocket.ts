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

export type ToolName = "generate_code" | "generate_image";

export type ToolLifecyclePayload = {
  jobId: string;
  toolName: ToolName;
  stage?: string;
  message?: string;
  summary?: string;
  reason?: string;
};

export type CodePayload = {
  jobId: string;
  files: CodeFile[];
};

export type GeneratedImagePayload = {
  jobId: string;
  url: string;
  name: string;
  mimeType?: string;
  data?: string;
};

function parseToolName(value: unknown): ToolName | null {
  if (value === "generate_code" || value === "generate_image") {
    return value;
  }
  return null;
}

function parseToolLifecyclePayload(
  msg: Record<string, unknown>,
): ToolLifecyclePayload | null {
  const toolName = parseToolName(msg.toolName);
  const jobId = typeof msg.jobId === "string" ? msg.jobId : "";
  if (!toolName || !jobId) {
    return null;
  }
  return {
    jobId,
    toolName,
    stage: typeof msg.stage === "string" ? msg.stage : undefined,
    message: typeof msg.message === "string" ? msg.message : undefined,
    summary: typeof msg.summary === "string" ? msg.summary : undefined,
    reason: typeof msg.reason === "string" ? msg.reason : undefined,
  };
}

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
  onCode?: (payload: CodePayload) => void;
  onToolStarted?: (payload: ToolLifecyclePayload) => void;
  onToolProgress?: (payload: ToolLifecyclePayload) => void;
  onToolResult?: (payload: ToolLifecyclePayload) => void;
  onToolFinished?: (payload: ToolLifecyclePayload) => void;
  onToolCancelled?: (payload: ToolLifecyclePayload) => void;
  onToolFailed?: (payload: ToolLifecyclePayload) => void;
  onGeneratedImage?: (image: GeneratedImagePayload) => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onSessionTimeout?: (reason: "idle" | "hard_limit") => void;
  onBackendError?: (message: string) => void;
  onTransportError?: (message: string) => void;
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
        const delay =
          Math.min(500 * 2 ** this.reconnectAttempts, 4000) +
          Math.random() * 1000;
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => {
          this.connect();
        }, delay);
      }
    };

    this.ws.onerror = () => {
      this.handlers.onTransportError?.("WebSocket connection error");
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
    switch (msg.type) {
      case "tool_started":
      case "tool_progress":
      case "tool_result":
      case "tool_finished":
      case "tool_cancelled":
      case "tool_failed": {
        const toolPayload = parseToolLifecyclePayload(msg);
        if (!toolPayload) return;
        const handlerMap: Record<string, keyof WSEventHandlers> = {
          tool_started: "onToolStarted",
          tool_progress: "onToolProgress",
          tool_result: "onToolResult",
          tool_finished: "onToolFinished",
          tool_cancelled: "onToolCancelled",
          tool_failed: "onToolFailed",
        };
        const handler = this.handlers[handlerMap[msg.type as string]];
        (handler as ((p: ToolLifecyclePayload) => void) | undefined)?.(
          toolPayload,
        );
        return;
      }

      case "generated_image":
        this.handlers.onGeneratedImage?.({
          jobId: typeof msg.jobId === "string" ? msg.jobId : "",
          url: typeof msg.url === "string" ? msg.url : "",
          name:
            typeof msg.name === "string" && msg.name.length > 0
              ? msg.name
              : "generated-image.png",
          mimeType:
            typeof msg.mimeType === "string" ? msg.mimeType : undefined,
          data: typeof msg.data === "string" ? msg.data : undefined,
        });
        return;

      case "session_timeout":
        this.handlers.onSessionTimeout?.(msg.reason as "idle" | "hard_limit");
        return;

      case "code":
        this.handlers.onCode?.({
          jobId: typeof msg.jobId === "string" ? msg.jobId : "",
          files: sanitizeCodeFiles(msg.files),
        });
        return;

      case "error":
        this.handlers.onBackendError?.(
          (msg.message as string) ||
            (msg.errorCode as string) ||
            "Unknown error",
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
          const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
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
