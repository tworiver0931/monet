"use client";

import {
  loadSandpackClient,
  type SandpackClient,
  type SandpackMessage,
} from "@codesandbox/sandpack-client";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSandpackClientConfig } from "@/lib/sandpack-config";
import { getSandpackSyntaxError } from "@/lib/sandpack-syntax";

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
  onPreviewError,
  previewRenderVersion = 0,
  onPreviewRendered,
  captureMode = "settled",
  showBuiltInErrorScreen,
  reportRuntimeErrors = Boolean(onRuntimeError),
}: {
  files: Array<{ path: string; content: string }>;
  onRequestFix?: (e: string) => void;
  onRuntimeError?: (error: string) => void;
  onPreviewError?: (renderVersion: number, error: string) => void;
  previewRenderVersion?: number;
  onPreviewRendered?: (renderVersion: number) => void;
  captureMode?: "off" | "settled";
  showBuiltInErrorScreen?: boolean;
  reportRuntimeErrors?: boolean;
}) {
  const filesSignature = useMemo(
    () =>
      files
        .map((file) => `${file.path}\u0000${file.content}`)
        .join("\u0001"),
    [files],
  );
  const showCustomErrorOverlay = Boolean(onRequestFix);
  const shouldShowErrorScreen =
    showBuiltInErrorScreen ?? !showCustomErrorOverlay;
  // Use filesSignature (a string, compared by value) instead of files
  // (an array, compared by reference) so the memo actually caches.
  const clientConfig = useMemo(
    () =>
      getSandpackClientConfig(files, shouldShowErrorScreen, {
        captureMode,
        renderVersion: previewRenderVersion,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      captureMode,
      filesSignature,
      previewRenderVersion,
      shouldShowErrorScreen,
    ],
  );
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const clientRef = useRef<SandpackClient | null>(null);
  const latestConfigRef = useRef(clientConfig);
  const latestSignatureRef = useRef(filesSignature);
  const appliedSignatureRef = useRef<string | null>(null);
  const isClientReadyRef = useRef(false);
  const readyFallbackTimeoutRef = useRef<number | null>(null);
  const latestOnPreviewRenderedRef = useRef(onPreviewRendered);
  const latestOnPreviewErrorRef = useRef(onPreviewError);
  const latestRenderVersionRef = useRef(0);
  const completedRenderVersionRef = useRef(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isValidationPending, setIsValidationPending] = useState(true);
  const lastReportedErrorRef = useRef<string | null>(null);
  const lastPreviewErrorKeyRef = useRef<string | null>(null);
  const onRuntimeErrorRef = useRef(onRuntimeError);
  const currentError = validationError ?? runtimeError;
  onRuntimeErrorRef.current = onRuntimeError;

  // Auto-report runtime errors to the orchestrator (deduplicated)
  useEffect(() => {
    if (!reportRuntimeErrors) {
      lastReportedErrorRef.current = null;
      return;
    }
    if (currentError && currentError !== lastReportedErrorRef.current) {
      lastReportedErrorRef.current = currentError;
      onRuntimeErrorRef.current?.(currentError);
    }
    if (!currentError) {
      lastReportedErrorRef.current = null;
    }
  }, [currentError, reportRuntimeErrors]);

  latestConfigRef.current = clientConfig;
  latestSignatureRef.current = filesSignature;
  latestOnPreviewRenderedRef.current = onPreviewRendered;
  latestOnPreviewErrorRef.current = onPreviewError;
  latestRenderVersionRef.current = previewRenderVersion;

  const notifyPreviewRendered = useCallback(
    (renderVersion?: number) => {
      const nextVersion = renderVersion ?? latestRenderVersionRef.current;
      if (nextVersion <= 0 || nextVersion <= completedRenderVersionRef.current) {
        return;
      }

      completedRenderVersionRef.current = nextVersion;
      latestOnPreviewRenderedRef.current?.(nextVersion);
    },
    [],
  );

  const reportPreviewError = useCallback((error: string, renderVersion?: number) => {
    const nextVersion = renderVersion ?? latestRenderVersionRef.current;
    if (nextVersion <= 0) {
      return;
    }

    const errorKey = `${nextVersion}\u0000${error}`;
    if (lastPreviewErrorKeyRef.current === errorKey) {
      return;
    }

    lastPreviewErrorKeyRef.current = errorKey;
    latestOnPreviewErrorRef.current?.(nextVersion, error);
  }, []);

  useEffect(() => {
    let cancelled = false;

    setIsValidationPending(true);

    void getSandpackSyntaxError(files)
      .then((error) => {
        if (cancelled) return;
        setValidationError(error);
        setIsValidationPending(false);
        if (error) {
          setRuntimeError(null);
          reportPreviewError(error, previewRenderVersion);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setValidationError(null);
        setIsValidationPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [files, previewRenderVersion, reportPreviewError]);

  const syncSandbox = useCallback(() => {
    const client = clientRef.current;
    if (!client || isValidationPending || validationError) return;

    const nextSignature = latestSignatureRef.current;
    if (appliedSignatureRef.current === nextSignature) return;

    const nextConfig = latestConfigRef.current;
    client.updateOptions(nextConfig.clientOptions);
    client.updateSandbox(nextConfig.sandboxSetup);
    appliedSignatureRef.current = nextSignature;
  }, [isValidationPending, validationError]);

  useEffect(() => {
    if (
      !clientRef.current ||
      !isClientReadyRef.current ||
      isValidationPending ||
      validationError
    ) {
      return;
    }
    syncSandbox();
  }, [filesSignature, isValidationPending, syncSandbox, validationError]);

  useEffect(() => {
    if (isValidationPending || validationError) {
      return;
    }

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

        if (
          message.type === "success" ||
          (message.type === "done" && message.compilatonError === false)
        ) {
          notifyPreviewRendered();
        }

        const nextError = formatSandpackError(message);
        if (nextError) {
          markClientReady();
          setRuntimeError(nextError);
          reportPreviewError(nextError);
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

      unsubscribe?.();
      clientRef.current?.destroy();
      clientRef.current = null;
      appliedSignatureRef.current = null;
    };
  }, [
    isValidationPending,
    notifyPreviewRendered,
    reportPreviewError,
    syncSandbox,
    validationError,
  ]);

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={iframeRef}
        data-sandbox-preview="true"
        title="Sandpack Preview"
        className="h-full w-full border-0"
      />
      {onRequestFix && currentError && (
        <ErrorMessage errorMessage={currentError} onRequestFix={onRequestFix} />
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
