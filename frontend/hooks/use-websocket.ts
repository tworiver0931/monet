"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MonetWebSocket,
  type CodePayload,
  type GeneratedImagePayload,
  type ToolLifecyclePayload,
  type ToolName,
  type WSEventHandlers,
} from "@/lib/websocket";

type ConnectionState = "disconnected" | "connecting" | "connected";
type ToolJobStatus = "running" | "finished" | "cancelled" | "failed";

export type ToolJobState = {
  jobId: string;
  toolName: ToolName;
  status: ToolJobStatus;
  stage?: string;
  message?: string;
  summary?: string;
  reason?: string;
};

function buildToolJob(
  payload: ToolLifecyclePayload,
  status: ToolJobStatus,
  previous: ToolJobState | null = null,
): ToolJobState {
  return {
    jobId: payload.jobId,
    toolName: payload.toolName,
    status,
    stage: payload.stage ?? previous?.stage,
    message: payload.message ?? previous?.message,
    summary: payload.summary ?? previous?.summary,
    reason: payload.reason ?? previous?.reason,
  };
}

function patchToolJob(
  previous: ToolJobState | null,
  payload: ToolLifecyclePayload,
  status?: ToolJobStatus,
): ToolJobState | null {
  if (previous && previous.jobId !== payload.jobId) {
    return previous;
  }
  return buildToolJob(payload, status ?? previous?.status ?? "running", previous);
}

export type UseWebSocketReturn = {
  connect: () => void;
  disconnect: () => void;
  sendText: (text: string) => void;
  sendAudio: (pcmData: ArrayBuffer) => void;
  sendImage: (base64Data: string, mimeType?: string) => void;
  sendImageGenerationFrame: (
    base64Data: string | null,
    mimeType?: string,
  ) => void;
  sendImageUpload: (url: string, name: string) => void;
  sendRuntimeError: (error: string) => void;
  connectionState: ConnectionState;
  codeJob: ToolJobState | null;
  imageJob: ToolJobState | null;
  codeResult: CodePayload | null;
  streamText: string;
  isCodeAgentGenerating: boolean;
  isImageGenerating: boolean;
  generatedImage: GeneratedImagePayload | null;
  clearGeneratedImage: () => void;
  isTurnComplete: boolean;
  timeoutReason: "idle" | "hard_limit" | null;
};

export function useWebSocket(
  userId: string,
  sessionId: string,
  onAudioReceived?: (pcmData: ArrayBuffer) => void,
  onInterrupted?: () => void,
): UseWebSocketReturn {
  const wsRef = useRef<MonetWebSocket | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [codeJob, setCodeJob] = useState<ToolJobState | null>(null);
  const [imageJob, setImageJob] = useState<ToolJobState | null>(null);
  const [codeResult, setCodeResult] = useState<CodePayload | null>(null);
  const [streamText, setStreamText] = useState("");
  const [generatedImage, setGeneratedImage] =
    useState<GeneratedImagePayload | null>(null);
  const [isTurnComplete, setIsTurnComplete] = useState(true);
  const [timeoutReason, setTimeoutReason] = useState<
    "idle" | "hard_limit" | null
  >(null);

  const onAudioReceivedRef = useRef(onAudioReceived);
  onAudioReceivedRef.current = onAudioReceived;
  const onInterruptedRef = useRef(onInterrupted);
  onInterruptedRef.current = onInterrupted;
  const codeJobRef = useRef<ToolJobState | null>(null);
  const imageJobRef = useRef<ToolJobState | null>(null);

  useEffect(() => {
    codeJobRef.current = codeJob;
  }, [codeJob]);

  useEffect(() => {
    imageJobRef.current = imageJob;
  }, [imageJob]);

  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.connect();
      return;
    }

    setConnectionState("connecting");

    const handlers: WSEventHandlers = {
      onOpen: () => {
        setConnectionState("connected");
        setTimeoutReason(null);
      },
      onClose: () => {
        setConnectionState("disconnected");
      },
      onTransportError: (message) => {
        console.error("WebSocket transport error:", message);
        setConnectionState("disconnected");
      },
      onBackendError: (message) => {
        console.error("WebSocket backend error:", message);
      },
      onAudio: (pcmData) => {
        onAudioReceivedRef.current?.(pcmData);
      },
      onText: (text) => {
        setIsTurnComplete(false);
        setStreamText((prev) => prev + text);
      },
      onToolStarted: (payload) => {
        setIsTurnComplete(false);
        if (payload.toolName === "generate_code") {
          setCodeJob(buildToolJob(payload, "running"));
          return;
        }
        setGeneratedImage(null);
        setImageJob(buildToolJob(payload, "running"));
      },
      onToolProgress: (payload) => {
        if (payload.toolName === "generate_code") {
          setCodeJob((previous) => patchToolJob(previous, payload));
          return;
        }
        setImageJob((previous) => patchToolJob(previous, payload));
      },
      onToolResult: (payload) => {
        if (payload.toolName === "generate_code") {
          setCodeJob((previous) => patchToolJob(previous, payload));
          return;
        }
        setImageJob((previous) => patchToolJob(previous, payload));
      },
      onToolFinished: (payload) => {
        if (payload.toolName === "generate_code") {
          setCodeJob((previous) => patchToolJob(previous, payload, "finished"));
          return;
        }
        setImageJob((previous) => patchToolJob(previous, payload, "finished"));
      },
      onToolCancelled: (payload) => {
        if (payload.toolName === "generate_code") {
          setCodeJob((previous) => patchToolJob(previous, payload, "cancelled"));
          return;
        }
        setImageJob((previous) => patchToolJob(previous, payload, "cancelled"));
        setGeneratedImage(null);
      },
      onToolFailed: (payload) => {
        if (payload.toolName === "generate_code") {
          setCodeJob((previous) => patchToolJob(previous, payload, "failed"));
          return;
        }
        setImageJob((previous) => patchToolJob(previous, payload, "failed"));
        setGeneratedImage(null);
      },
      onGeneratedImage: (image) => {
        const activeImageJob = imageJobRef.current;
        if (
          activeImageJob?.jobId &&
          image.jobId &&
          activeImageJob.jobId !== image.jobId
        ) {
          return;
        }
        if (
          activeImageJob?.status === "cancelled" ||
          activeImageJob?.status === "failed"
        ) {
          return;
        }
        setGeneratedImage(image);
      },
      onCode: (payload) => {
        const activeCodeJob = codeJobRef.current;
        if (
          activeCodeJob?.jobId &&
          payload.jobId &&
          activeCodeJob.jobId !== payload.jobId
        ) {
          return;
        }
        if (
          activeCodeJob?.status === "cancelled" ||
          activeCodeJob?.status === "failed"
        ) {
          return;
        }
        setIsTurnComplete(false);
        setCodeResult(payload);
      },
      onTurnComplete: () => {
        setIsTurnComplete(true);
      },
      onSessionTimeout: (reason: "idle" | "hard_limit") => {
        setTimeoutReason(reason);
      },
      onInterrupted: () => {
        setIsTurnComplete(true);
        setStreamText("");
        onInterruptedRef.current?.();
      },
    };

    const ws = new MonetWebSocket(userId, sessionId, handlers);
    wsRef.current = ws;
    ws.connect();
  }, [userId, sessionId]);

  const disconnect = useCallback(() => {
    wsRef.current?.disconnect();
    wsRef.current = null;
    setConnectionState("disconnected");
    setCodeJob(null);
    setImageJob(null);
    setCodeResult(null);
    setGeneratedImage(null);
    setStreamText("");
    setTimeoutReason(null);
  }, []);

  const sendText = useCallback((text: string) => {
    setIsTurnComplete(false);
    setStreamText("");
    wsRef.current?.sendText(text);
  }, []);

  const sendAudio = useCallback((pcmData: ArrayBuffer) => {
    wsRef.current?.sendAudio(pcmData);
  }, []);

  const sendImage = useCallback(
    (base64Data: string, mimeType: string = "image/jpeg") => {
      wsRef.current?.sendImage(base64Data, mimeType);
    },
    [],
  );

  const sendImageGenerationFrame = useCallback(
    (base64Data: string | null, mimeType: string = "image/png") => {
      wsRef.current?.sendImageGenerationFrame(base64Data, mimeType);
    },
    [],
  );

  const sendImageUpload = useCallback((url: string, name: string) => {
    wsRef.current?.sendImageUpload(url, name);
  }, []);

  const sendRuntimeError = useCallback((error: string) => {
    wsRef.current?.sendRuntimeError(error);
  }, []);

  const clearGeneratedImage = useCallback(() => {
    setGeneratedImage(null);
  }, []);

  const isCodeAgentGenerating = codeJob?.status === "running";
  const isImageGenerating = imageJob?.status === "running";

  useEffect(() => {
    return () => {
      wsRef.current?.disconnect();
    };
  }, []);

  return {
    connect,
    disconnect,
    sendText,
    sendAudio,
    sendImage,
    sendImageGenerationFrame,
    sendImageUpload,
    sendRuntimeError,
    connectionState,
    codeJob,
    imageJob,
    codeResult,
    streamText,
    isCodeAgentGenerating,
    isImageGenerating,
    generatedImage,
    clearGeneratedImage,
    isTurnComplete,
    timeoutReason,
  };
}
