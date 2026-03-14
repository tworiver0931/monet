"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
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
  return buildToolJob(
    payload,
    status ?? previous?.status ?? "running",
    previous,
  );
}

// ---------------------------------------------------------------------------
// Consolidated state & reducer to batch updates from WebSocket events
// ---------------------------------------------------------------------------

type WSState = {
  connectionState: ConnectionState;
  codeJob: ToolJobState | null;
  imageJob: ToolJobState | null;
  codeResult: CodePayload | null;
  streamText: string;
  generatedImage: GeneratedImagePayload | null;
  isTurnComplete: boolean;
  timeoutReason: "idle" | "hard_limit" | null;
};

const initialState: WSState = {
  connectionState: "disconnected",
  codeJob: null,
  imageJob: null,
  codeResult: null,
  streamText: "",
  generatedImage: null,
  isTurnComplete: true,
  timeoutReason: null,
};

type WSAction =
  | { type: "SET_CONNECTION"; state: ConnectionState }
  | { type: "CLEAR_TIMEOUT" }
  | { type: "SET_TIMEOUT"; reason: "idle" | "hard_limit" }
  | { type: "APPEND_TEXT"; text: string }
  | { type: "TOOL_STARTED"; payload: ToolLifecyclePayload }
  | { type: "TOOL_PROGRESS"; payload: ToolLifecyclePayload }
  | { type: "TOOL_RESULT"; payload: ToolLifecyclePayload }
  | { type: "TOOL_FINISHED"; payload: ToolLifecyclePayload }
  | { type: "TOOL_CANCELLED"; payload: ToolLifecyclePayload }
  | { type: "TOOL_FAILED"; payload: ToolLifecyclePayload }
  | { type: "SET_GENERATED_IMAGE"; image: GeneratedImagePayload }
  | { type: "CLEAR_GENERATED_IMAGE" }
  | { type: "SET_CODE_RESULT"; payload: CodePayload }
  | { type: "TURN_COMPLETE" }
  | { type: "INTERRUPTED" }
  | { type: "SEND_TEXT" }
  | { type: "DISCONNECT" };

function wsReducer(state: WSState, action: WSAction): WSState {
  switch (action.type) {
    case "SET_CONNECTION":
      return {
        ...state,
        connectionState: action.state,
        ...(action.state === "connected" ? { timeoutReason: null } : {}),
      };
    case "CLEAR_TIMEOUT":
      return { ...state, timeoutReason: null };
    case "SET_TIMEOUT":
      return { ...state, timeoutReason: action.reason };
    case "APPEND_TEXT":
      return {
        ...state,
        isTurnComplete: false,
        streamText: state.streamText + action.text,
      };
    case "TOOL_STARTED":
      if (action.payload.toolName === "generate_code") {
        return {
          ...state,
          isTurnComplete: false,
          codeJob: buildToolJob(action.payload, "running"),
        };
      }
      return {
        ...state,
        isTurnComplete: false,
        generatedImage: null,
        imageJob: buildToolJob(action.payload, "running"),
      };
    case "TOOL_PROGRESS":
      if (action.payload.toolName === "generate_code") {
        return {
          ...state,
          codeJob: patchToolJob(state.codeJob, action.payload),
        };
      }
      return {
        ...state,
        imageJob: patchToolJob(state.imageJob, action.payload),
      };
    case "TOOL_RESULT":
      if (action.payload.toolName === "generate_code") {
        return {
          ...state,
          codeJob: patchToolJob(state.codeJob, action.payload),
        };
      }
      return {
        ...state,
        imageJob: patchToolJob(state.imageJob, action.payload),
      };
    case "TOOL_FINISHED":
      if (action.payload.toolName === "generate_code") {
        return {
          ...state,
          codeJob: patchToolJob(state.codeJob, action.payload, "finished"),
        };
      }
      return {
        ...state,
        imageJob: patchToolJob(state.imageJob, action.payload, "finished"),
      };
    case "TOOL_CANCELLED":
      if (action.payload.toolName === "generate_code") {
        return {
          ...state,
          codeJob: patchToolJob(state.codeJob, action.payload, "cancelled"),
        };
      }
      return {
        ...state,
        imageJob: patchToolJob(state.imageJob, action.payload, "cancelled"),
        generatedImage: null,
      };
    case "TOOL_FAILED":
      if (action.payload.toolName === "generate_code") {
        return {
          ...state,
          codeJob: patchToolJob(state.codeJob, action.payload, "failed"),
        };
      }
      return {
        ...state,
        imageJob: patchToolJob(state.imageJob, action.payload, "failed"),
        generatedImage: null,
      };
    case "SET_GENERATED_IMAGE":
      return { ...state, generatedImage: action.image };
    case "CLEAR_GENERATED_IMAGE":
      return { ...state, generatedImage: null };
    case "SET_CODE_RESULT":
      return {
        ...state,
        isTurnComplete: false,
        codeResult: action.payload,
      };
    case "TURN_COMPLETE":
      return { ...state, isTurnComplete: true };
    case "INTERRUPTED":
      return { ...state, isTurnComplete: true, streamText: "" };
    case "SEND_TEXT":
      return { ...state, isTurnComplete: false, streamText: "" };
    case "DISCONNECT":
      return {
        ...initialState,
      };
    default:
      return state;
  }
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
  const [state, dispatch] = useReducer(wsReducer, initialState);

  const onAudioReceivedRef = useRef(onAudioReceived);
  onAudioReceivedRef.current = onAudioReceived;
  const onInterruptedRef = useRef(onInterrupted);
  onInterruptedRef.current = onInterrupted;
  const codeJobRef = useRef<ToolJobState | null>(null);
  const imageJobRef = useRef<ToolJobState | null>(null);

  // Keep refs in sync with reducer state for use in non-React callbacks
  codeJobRef.current = state.codeJob;
  imageJobRef.current = state.imageJob;

  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.connect();
      return;
    }

    dispatch({ type: "SET_CONNECTION", state: "connecting" });

    const handlers: WSEventHandlers = {
      onOpen: () => {
        dispatch({ type: "SET_CONNECTION", state: "connected" });
      },
      onClose: () => {
        dispatch({ type: "SET_CONNECTION", state: "disconnected" });
      },
      onTransportError: (message) => {
        console.error("WebSocket transport error:", message);
        dispatch({ type: "SET_CONNECTION", state: "disconnected" });
      },
      onBackendError: (message) => {
        console.error("WebSocket backend error:", message);
      },
      onAudio: (pcmData) => {
        onAudioReceivedRef.current?.(pcmData);
      },
      onText: (text) => {
        dispatch({ type: "APPEND_TEXT", text });
      },
      onToolStarted: (payload) => {
        dispatch({ type: "TOOL_STARTED", payload });
      },
      onToolProgress: (payload) => {
        dispatch({ type: "TOOL_PROGRESS", payload });
      },
      onToolResult: (payload) => {
        dispatch({ type: "TOOL_RESULT", payload });
      },
      onToolFinished: (payload) => {
        dispatch({ type: "TOOL_FINISHED", payload });
      },
      onToolCancelled: (payload) => {
        dispatch({ type: "TOOL_CANCELLED", payload });
      },
      onToolFailed: (payload) => {
        dispatch({ type: "TOOL_FAILED", payload });
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
        dispatch({ type: "SET_GENERATED_IMAGE", image });
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
        dispatch({ type: "SET_CODE_RESULT", payload });
      },
      onTurnComplete: () => {
        dispatch({ type: "TURN_COMPLETE" });
      },
      onSessionTimeout: (reason: "idle" | "hard_limit") => {
        dispatch({ type: "SET_TIMEOUT", reason });
      },
      onInterrupted: () => {
        dispatch({ type: "INTERRUPTED" });
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
    dispatch({ type: "DISCONNECT" });
  }, []);

  const sendText = useCallback((text: string) => {
    dispatch({ type: "SEND_TEXT" });
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
    dispatch({ type: "CLEAR_GENERATED_IMAGE" });
  }, []);

  const isCodeAgentGenerating = state.codeJob?.status === "running";
  const isImageGenerating = state.imageJob?.status === "running";

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
    connectionState: state.connectionState,
    codeJob: state.codeJob,
    imageJob: state.imageJob,
    codeResult: state.codeResult,
    streamText: state.streamText,
    isCodeAgentGenerating,
    isImageGenerating,
    generatedImage: state.generatedImage,
    clearGeneratedImage,
    isTurnComplete: state.isTurnComplete,
    timeoutReason: state.timeoutReason,
  };
}
