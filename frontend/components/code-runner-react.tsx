"use client";

import {
  loadSandpackClient,
  type SandpackClient,
  type SandpackMessage,
} from "@codesandbox/sandpack-client";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSandpackClientConfig } from "@/lib/sandpack-config";

function formatSandpackError(message: SandpackMessage): string | null {
  if (message.type === "action" && message.action === "show-error") {
    const location = message.path
      ? typeof message.line === "number" && typeof message.column === "number"
        ? `\n\n${message.path}:${message.line}:${message.column}`
        : `\n\n${message.path}`
      : "";

    return `${message.message}${location}`;
  }

  if (
    message.type === "action" &&
    message.action === "notification" &&
    message.notificationType === "error"
  ) {
    return message.title;
  }

  return null;
}

export default function ReactCodeRunner({
  files,
  onRequestFix,
  onRuntimeError,
  previewRenderVersion = 0,
  onPreviewRendered,
}: {
  files: Array<{ path: string; content: string }>;
  onRequestFix?: (e: string) => void;
  onRuntimeError?: (error: string) => void;
  previewRenderVersion?: number;
  onPreviewRendered?: (renderVersion: number) => void;
}) {
  const filesSignature = files
    .map((file) => `${file.path}\u0000${file.content}`)
    .join("\u0001");
  const showCustomErrorOverlay = Boolean(onRequestFix);
  // Use filesSignature (a string, compared by value) instead of files
  // (an array, compared by reference) so the memo actually caches.
  const clientConfig = useMemo(
    () =>
      getSandpackClientConfig(files, !showCustomErrorOverlay, {
        renderVersion: previewRenderVersion,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filesSignature, previewRenderVersion, showCustomErrorOverlay],
  );
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const clientRef = useRef<SandpackClient | null>(null);
  const latestConfigRef = useRef(clientConfig);
  const latestSignatureRef = useRef(filesSignature);
  const appliedSignatureRef = useRef<string | null>(null);
  const isClientReadyRef = useRef(false);
  const readyFallbackTimeoutRef = useRef<number | null>(null);
  const renderSettleTimeoutRef = useRef<number | null>(null);
  const latestOnPreviewRenderedRef = useRef(onPreviewRendered);
  const latestRenderVersionRef = useRef(0);
  const pendingRenderVersionRef = useRef(0);
  const completedRenderVersionRef = useRef(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const lastReportedErrorRef = useRef<string | null>(null);
  const onRuntimeErrorRef = useRef(onRuntimeError);
  onRuntimeErrorRef.current = onRuntimeError;

  // Auto-report runtime errors to the orchestrator (deduplicated)
  useEffect(() => {
    if (runtimeError && runtimeError !== lastReportedErrorRef.current) {
      lastReportedErrorRef.current = runtimeError;
      onRuntimeErrorRef.current?.(runtimeError);
    }
    if (!runtimeError) {
      lastReportedErrorRef.current = null;
    }
  }, [runtimeError]);

  latestConfigRef.current = clientConfig;
  latestSignatureRef.current = filesSignature;
  latestOnPreviewRenderedRef.current = onPreviewRendered;
  latestRenderVersionRef.current = previewRenderVersion;

  const clearRenderSettleTimeout = useCallback(() => {
    if (renderSettleTimeoutRef.current !== null) {
      window.clearTimeout(renderSettleTimeoutRef.current);
      renderSettleTimeoutRef.current = null;
    }
  }, []);

  const notifyPreviewRendered = useCallback(
    (renderVersion?: number) => {
      const nextVersion = renderVersion ?? pendingRenderVersionRef.current;
      if (nextVersion <= 0 || nextVersion <= completedRenderVersionRef.current) {
        clearRenderSettleTimeout();
        return;
      }

      completedRenderVersionRef.current = nextVersion;
      pendingRenderVersionRef.current = 0;
      clearRenderSettleTimeout();
      latestOnPreviewRenderedRef.current?.(nextVersion);
    },
    [clearRenderSettleTimeout],
  );

  const scheduleRenderSettle = useCallback(
    (renderVersion: number) => {
      if (renderVersion <= 0) return;
      pendingRenderVersionRef.current = renderVersion;
      clearRenderSettleTimeout();
      renderSettleTimeoutRef.current = window.setTimeout(() => {
        notifyPreviewRendered(renderVersion);
      }, 1800);
    },
    [clearRenderSettleTimeout, notifyPreviewRendered],
  );

  const syncSandbox = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;

    const nextSignature = latestSignatureRef.current;
    if (appliedSignatureRef.current === nextSignature) return;

    const nextConfig = latestConfigRef.current;
    client.updateOptions(nextConfig.clientOptions);
    client.updateSandbox(nextConfig.sandboxSetup);
    appliedSignatureRef.current = nextSignature;
    scheduleRenderSettle(latestRenderVersionRef.current);
  }, [scheduleRenderSettle]);

  useEffect(() => {
    if (!clientRef.current || !isClientReadyRef.current) return;
    syncSandbox();
  }, [filesSignature, syncSandbox]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    const markClientReady = () => {
      if (isClientReadyRef.current) return;
      isClientReadyRef.current = true;
      syncSandbox();
    };

    void (async () => {
      const initialConfig = latestConfigRef.current;
      const client = await loadSandpackClient(
        iframe,
        initialConfig.sandboxSetup,
        initialConfig.clientOptions,
      );

      if (disposed) {
        client.destroy();
        return;
      }

      clientRef.current = client;
      appliedSignatureRef.current = latestSignatureRef.current;
      scheduleRenderSettle(latestRenderVersionRef.current);

      unsubscribe = client.listen((message) => {
        if (
          message.type === "start" ||
          message.type === "status" ||
          message.type === "done" ||
          message.type === "success"
        ) {
          markClientReady();
        }

        if (
          message.type === "start" ||
          message.type === "success" ||
          (message.type === "done" && message.compilatonError === false)
        ) {
          setRuntimeError(null);
        }

        if (message.type === "success" || message.type === "done") {
          notifyPreviewRendered();
        }

        const nextError = formatSandpackError(message);
        if (nextError) {
          markClientReady();
          setRuntimeError(nextError);
          notifyPreviewRendered();
        }
      });

      readyFallbackTimeoutRef.current = window.setTimeout(
        markClientReady,
        1500,
      );
    })();

    return () => {
      disposed = true;
      isClientReadyRef.current = false;

      if (readyFallbackTimeoutRef.current !== null) {
        window.clearTimeout(readyFallbackTimeoutRef.current);
        readyFallbackTimeoutRef.current = null;
      }

      clearRenderSettleTimeout();

      unsubscribe?.();
      clientRef.current?.destroy();
      clientRef.current = null;
      appliedSignatureRef.current = null;
    };
  }, [clearRenderSettleTimeout, notifyPreviewRendered, scheduleRenderSettle, syncSandbox]);

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef}
        data-sandbox-preview="true"
        title="Sandpack Preview"
        className="h-full w-full border-0"
      />
      {onRequestFix && runtimeError && (
        <ErrorMessage errorMessage={runtimeError} onRequestFix={onRequestFix} />
      )}
    </div>
  );
}

function ErrorMessage({
  errorMessage,
  onRequestFix,
}: {
  errorMessage: string;
  onRequestFix: (e: string) => void;
}) {
  const [didCopy, setDidCopy] = useState(false);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-white/5 text-base backdrop-blur-sm">
      <div className="max-w-[400px] rounded-md bg-red-500 p-4 text-white shadow-xl shadow-black/20">
        <p className="text-lg font-medium">Error</p>

        <p className="mt-4 line-clamp-[10] overflow-x-auto whitespace-pre font-mono text-xs">
          {errorMessage}
        </p>

        <div className="mt-8 flex justify-between gap-4">
          <button
            onClick={async () => {
              setDidCopy(true);
              await window.navigator.clipboard.writeText(errorMessage);
              await new Promise((resolve) => setTimeout(resolve, 2000));
              setDidCopy(false);
            }}
            className="rounded border-red-300 px-2.5 py-1.5 text-sm font-semibold text-red-50"
          >
            {didCopy ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
          </button>
          <button
            onClick={() => {
              onRequestFix(errorMessage);
            }}
            className="rounded bg-white px-2.5 py-1.5 text-sm font-medium text-black"
          >
            Try to fix
          </button>
        </div>
      </div>
    </div>
  );
}
