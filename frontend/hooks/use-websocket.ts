"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MonetWebSocket,
  type CodeFile,
  type GeneratedImagePayload,
  type WSEventHandlers,
} from "@/lib/websocket";

type ConnectionState = "disconnected" | "connecting" | "connected";

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
  codeFiles: CodeFile[];
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
  const [codeFiles, setCodeFiles] = useState<CodeFile[]>([]);
  const [streamText, setStreamText] = useState("");
  const [isCodeAgentGenerating, setIsCodeAgentGenerating] = useState(false);
  const [isImageGenerating, setIsImageGenerating] = useState(false);
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
      onError: (message) => {
        console.error("WebSocket error:", message);
        setConnectionState("disconnected");
      },
      onAudio: (pcmData) => {
        onAudioReceivedRef.current?.(pcmData);
      },
      onText: (text) => {
        setIsTurnComplete(false);
        setStreamText((prev) => prev + text);
      },
      onCodeAgentStarted: () => {
        setIsCodeAgentGenerating(true);
        setIsTurnComplete(false);
      },
      onCodeAgentFinished: () => {
        setIsCodeAgentGenerating(false);
      },
      onImageGenerationStarted: () => {
        setIsImageGenerating(true);
        setGeneratedImage(null);
        setIsTurnComplete(false);
      },
      onImageGenerationFinished: () => {
        setIsImageGenerating(false);
      },
      onGeneratedImage: (image) => {
        setGeneratedImage(image);
      },
      onCode: (files) => {
        setIsTurnComplete(false);
        setCodeFiles(files);
      },
      onTurnComplete: () => {
        setIsCodeAgentGenerating(false);
        setIsImageGenerating(false);
        setIsTurnComplete(true);
      },
      onSessionTimeout: (reason: "idle" | "hard_limit") => {
        setTimeoutReason(reason);
      },
      onInterrupted: () => {
        setIsCodeAgentGenerating(false);
        setIsImageGenerating(false);
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
    setIsCodeAgentGenerating(false);
    setIsImageGenerating(false);
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
    codeFiles,
    streamText,
    isCodeAgentGenerating,
    isImageGenerating,
    generatedImage,
    clearGeneratedImage,
    isTurnComplete,
    timeoutReason,
  };
}
