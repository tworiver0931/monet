"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { domToPng } from "modern-screenshot";
import type {
  CodeFile,
  GeneratedImagePayload,
  UploadedImageRecord,
} from "@/lib/websocket";
import { AssetRecordType, type Editor, type TLShapeId } from "tldraw";
import {
  removeFrameWithContents,
  type TldrawTool,
  type UploadFileFn,
} from "@/components/tldraw-overlay";
import dynamic from "next/dynamic";
import {
  ImagePlus,
  MousePointer2,
  Pencil,
  Type,
  Eraser,
  Paperclip,
  Rocket,
} from "lucide-react";
import DeployModal from "@/components/deploy-modal";
import Grainient from "@/components/grainient";
import GlassSurface from "@/components/glass-surface";
import { cn, getExtensionForLanguage } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import AmbientEdgeGlow from "@/components/ambient-edge-glow";
import {
  cloneCanvas,
  cropCanvas,
  resizeCanvasToMaxDimension,
  getFrameCaptureRect,
  getFrameViewportRect,
  loadImageDimensions,
  MAX_PREVIEW_CAPTURE_DIM,
  MAX_GENERATION_FRAME_DIM,
  type FrameViewportRect,
} from "@/lib/canvas-utils";

const FRAME_SOURCE = "sandpack-preview-capture";
const FRAME_CONTROL_SOURCE = "sandpack-preview-control";
const GRAINIENT_ENTER_SETTLE_MS = 260;
const GRAINIENT_EXIT_SETTLE_MS = 760;
const AGENT_LEGEND_TITLE = "Agent note";
const AGENT_LEGEND_LINES = [
  "Freehand blue strokes and arrows = user annotations.",
  "Blue buttons, cards, and modals = app UI.",
];

type AnnotationMode = "interact" | TldrawTool;
type GrainientPhase = "hidden" | "entering" | "active" | "exiting";
type PreviewJobStatus = "running" | "finished" | "cancelled" | "failed";
type RunnerFile = { path: string; content: string };

function clearTimer(timerRef: { current: number | null }) {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

const TOOLS: {
  mode: Exclude<TldrawTool, "frame" | "select">;
  icon: React.ReactNode;
  title: string;
}[] = [
  { mode: "draw", icon: <Pencil size={14} />, title: "Draw" },
  { mode: "text", icon: <Type size={14} />, title: "Text" },
  { mode: "eraser", icon: <Eraser size={14} />, title: "Eraser" },
];

const BOTTOM_BAR_BUTTON_BASE_CLASS =
  "rounded-lg border border-white/45 bg-white/55 px-2 py-1.5 text-xs font-medium text-neutral-800 shadow-[0_1px_2px_rgba(15,23,42,0.08)] backdrop-blur-md transition-all hover:bg-white/72 hover:text-neutral-900";

const BOTTOM_BAR_BUTTON_ACTIVE_CLASS =
  "border-blue-400/40 bg-blue-500 text-white shadow-[0_6px_18px_rgba(59,130,246,0.32)] hover:bg-blue-500 hover:text-white";

const CodeRunner = dynamic(() => import("@/components/code-runner"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-transparent" />
  ),
});

const TldrawOverlay = dynamic(() => import("@/components/tldraw-overlay"), {
  ssr: false,
});

export default function CodeViewer({
  files,
  onClose,
  sendImage,
  sendImageGenerationFrame,
  sendText,
  sendImageUpload,
  pauseFrameStreaming = false,
  renderBottomBar = true,
  bottomBarVisible = true,
  showGenerationGlow = false,
  isImageGenerating = false,
  generatedImage,
  onGeneratedImageApplied,
  previewRenderVersion = 0,
  onPreviewRendered,
  onPreviewFailed,
  codeJobStatus,
  voiceControls,
  sessionId,
}: {
  files: CodeFile[];
  activeTab: string;
  onTabChange: (v: "code" | "preview") => void;
  onClose: () => void;
  sendImage?: (base64Data: string, mimeType?: string) => void;
  sendImageGenerationFrame?: (
    base64Data: string | null,
    mimeType?: string,
  ) => void;
  sendText?: (text: string) => void;
  sendImageUpload?: (image: UploadedImageRecord) => void;
  pauseFrameStreaming?: boolean;
  renderBottomBar?: boolean;
  bottomBarVisible?: boolean;
  showGenerationGlow?: boolean;
  isImageGenerating?: boolean;
  generatedImage?: GeneratedImagePayload | null;
  onGeneratedImageApplied?: () => void;
  previewRenderVersion?: number;
  onPreviewRendered?: (renderVersion: number) => void;
  onPreviewFailed?: (renderVersion: number) => void;
  codeJobStatus?: PreviewJobStatus | null;
  voiceControls?: React.ReactNode;
  sessionId?: string;
}) {
  const [annotationMode, setAnnotationMode] =
    useState<AnnotationMode>("interact");
  const [, setCaptureError] = useState<string | null>(null);
  const [, setIsPreviewReady] = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [generationFrameId, setGenerationFrameId] = useState<TLShapeId | null>(
    null,
  );
  const [frameViewportRect, setFrameViewportRect] =
    useState<FrameViewportRect | null>(null);
  const [grainientViewportRect, setGrainientViewportRect] =
    useState<FrameViewportRect | null>(null);
  const [grainientPhase, setGrainientPhase] =
    useState<GrainientPhase>("hidden");
  const reportedRenderVersionRef = useRef(0);
  const pendingFrameToolExitRef = useRef(false);
  const grainientEnterTimerRef = useRef<number | null>(null);
  const grainientExitTimerRef = useRef<number | null>(null);
  const hideGrainientImmediately = useCallback(() => {
    clearTimer(grainientEnterTimerRef);
    clearTimer(grainientExitTimerRef);
    setGrainientPhase("hidden");
    setGrainientViewportRect(null);
  }, []);

  const captureThumbnail = useCallback(async (): Promise<string | null> => {
    const iframe = previewIframeRef.current;
    if (!iframe) return null;
    // Use the compositing canvas to capture the current preview
    const canvas = compositingCanvasRef.current;
    if (!canvas) return null;
    try {
      const png = await domToPng(iframe, {
        scale: 0.5,
        backgroundColor: "#ffffff",
      });
      return png ? png.split(",")[1] : null;
    } catch {
      return null;
    }
  }, []);

  const editorRef = useRef<Editor | null>(null);
  const compositingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const tldrawContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadCounterRef = useRef(0);

  const uploadFile: UploadFileFn = useCallback(async (file: File) => {
    uploadCounterRef.current += 1;
    const image: UploadedImageRecord = {
      id: crypto.randomUUID(),
      label: `Image ${uploadCounterRef.current}`,
      name: file.name,
      url: "",
      source: "user_upload",
    };
    const formData = new FormData();
    formData.append("file", file);
    const backendUrl =
      process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
    const res = await fetch(`${backendUrl}/api/upload`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error("Upload failed");
    const { url } = await res.json();
    return { ...image, url };
  }, []);

  const safeFiles = useMemo(
    () =>
      files.map((file, index) => {
        const rawPath = typeof file.path === "string" ? file.path.trim() : "";
        const language =
          typeof file.language === "string" && file.language.trim().length > 0
            ? file.language
            : "tsx";

        return {
          ...file,
          language,
          path:
            rawPath ||
            `generated/file-${index + 1}.${getExtensionForLanguage(language)}`,
        };
      }),
    [files],
  );
  const mainFile =
    safeFiles.find((f) => f.path.endsWith("App.tsx")) ||
    safeFiles.find((f) => f.path.endsWith(".tsx")) ||
    safeFiles[0];
  const runnerFiles = useMemo<RunnerFile[]>(
    () =>
      safeFiles.map((file) => ({
        path: file.path,
        content: file.code,
      })),
    [safeFiles],
  );
  const committedPreviewVersionRef = useRef(0);
  const latestRequestedPreviewVersionRef = useRef(0);
  const candidateFilesByVersionRef = useRef<Map<number, RunnerFile[]>>(
    new Map(),
  );
  const lastReportedFailedVersionRef = useRef(0);
  const [committedRunnerFiles, setCommittedRunnerFiles] = useState<
    RunnerFile[]
  >([]);
  const [committedPreviewVersion, setCommittedPreviewVersion] = useState(0);
  const [lastFailedPreviewVersion, setLastFailedPreviewVersion] = useState<
    number | null
  >(null);
  const hasCommittedPreview = committedRunnerFiles.length > 0;
  const hasPendingPreviewCandidate =
    runnerFiles.length > 0 && previewRenderVersion > committedPreviewVersion;

  const previewTargetRef = useRef<HTMLDivElement | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);

  const reportRenderedVersion = useCallback(
    (renderVersion: unknown) => {
      if (
        typeof renderVersion !== "number" ||
        !Number.isFinite(renderVersion) ||
        renderVersion <= reportedRenderVersionRef.current
      ) {
        return;
      }

      reportedRenderVersionRef.current = renderVersion;
      onPreviewRendered?.(renderVersion);
    },
    [onPreviewRendered],
  );

  useEffect(() => {
    latestRequestedPreviewVersionRef.current = previewRenderVersion;

    if (previewRenderVersion <= 0 || runnerFiles.length === 0) {
      return;
    }

    const nextEntries = new Map(candidateFilesByVersionRef.current);
    nextEntries.set(previewRenderVersion, runnerFiles);

    for (const version of nextEntries.keys()) {
      if (
        version < committedPreviewVersionRef.current &&
        version !== committedPreviewVersionRef.current
      ) {
        nextEntries.delete(version);
      }
    }

    while (nextEntries.size > 8) {
      const oldestVersion = Math.min(...nextEntries.keys());
      if (oldestVersion === committedPreviewVersionRef.current) {
        break;
      }
      nextEntries.delete(oldestVersion);
    }

    candidateFilesByVersionRef.current = nextEntries;
  }, [previewRenderVersion, runnerFiles]);

  const handleStagedPreviewRendered = useCallback((renderVersion: number) => {
    if (
      renderVersion <= committedPreviewVersionRef.current ||
      renderVersion > latestRequestedPreviewVersionRef.current
    ) {
      return;
    }

    const nextFiles = candidateFilesByVersionRef.current.get(renderVersion);
    if (!nextFiles) {
      return;
    }

    committedPreviewVersionRef.current = renderVersion;
    setCommittedRunnerFiles(nextFiles);
    setCommittedPreviewVersion(renderVersion);
    setLastFailedPreviewVersion((current) =>
      current !== null && current <= renderVersion ? null : current,
    );
  }, []);

  const handleStagedPreviewError = useCallback(
    (renderVersion: number) => {
      if (renderVersion > latestRequestedPreviewVersionRef.current) {
        return;
      }

      setLastFailedPreviewVersion((current) =>
        current === null || renderVersion > current ? renderVersion : current,
      );

      if (renderVersion > lastReportedFailedVersionRef.current) {
        lastReportedFailedVersionRef.current = renderVersion;
        onPreviewFailed?.(renderVersion);
      }
    },
    [onPreviewFailed],
  );

  const handleCursorClick = useCallback(() => {
    if (isImageGenerating) {
      setAnnotationMode("select");
      return;
    }

    if (!generationFrameId) {
      setAnnotationMode("interact");
      return;
    }

    setAnnotationMode((current) =>
      current === "select" ? "interact" : "select",
    );
  }, [generationFrameId, isImageGenerating]);

  const handleGenerationFrameClick = useCallback(() => {
    if (isImageGenerating) {
      return;
    }

    setAnnotationMode("frame");
  }, [isImageGenerating]);

  const handleGenerationFrameChange = useCallback(
    (frameId: TLShapeId | null) => {
      setGenerationFrameId(frameId);
      if (frameId === null) {
        setAnnotationMode((current) =>
          current === "select" || current === "frame" ? "interact" : current,
        );
      }
    },
    [],
  );

  const handleGenerationFrameCreated = useCallback((frameId: TLShapeId) => {
    setGenerationFrameId(frameId);
    pendingFrameToolExitRef.current = true;
  }, []);

  useEffect(() => {
    if (annotationMode !== "frame") {
      pendingFrameToolExitRef.current = false;
      return;
    }

    const handlePointerUp = () => {
      if (!pendingFrameToolExitRef.current) {
        return;
      }

      pendingFrameToolExitRef.current = false;
      setAnnotationMode("draw");
    };

    window.addEventListener("pointerup", handlePointerUp, true);
    return () => {
      window.removeEventListener("pointerup", handlePointerUp, true);
    };
  }, [annotationMode]);

  useEffect(() => {
    if (isImageGenerating && generationFrameId) {
      setAnnotationMode("select");
    }
  }, [generationFrameId, isImageGenerating]);

  useEffect(() => {
    if (!isImageGenerating || !generationFrameId) {
      setFrameViewportRect(null);
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    // Keep the last good rect if tldraw briefly reports no bounds mid-drag.
    setFrameViewportRect(
      (current) => getFrameViewportRect(editor, generationFrameId) ?? current,
    );

    // Re-compute only when the store changes (shape moved, viewport panned, etc.)
    const unsub = editor.store.listen(
      () => {
        setFrameViewportRect(
          (current) =>
            getFrameViewportRect(editor, generationFrameId) ?? current,
        );
      },
      { scope: "document", source: "all" },
    );

    return () => {
      unsub();
    };
  }, [generationFrameId, isImageGenerating]);

  useEffect(() => {
    return () => {
      clearTimer(grainientEnterTimerRef);
      clearTimer(grainientExitTimerRef);
    };
  }, []);

  useEffect(() => {
    if (frameViewportRect) {
      setGrainientViewportRect(frameViewportRect);
    }
  }, [frameViewportRect]);

  useEffect(() => {
    if (isImageGenerating && frameViewportRect) {
      clearTimer(grainientExitTimerRef);
      setGrainientPhase((current) => {
        if (current === "active") {
          return current;
        }

        if (current === "hidden") {
          clearTimer(grainientEnterTimerRef);
          grainientEnterTimerRef.current = window.setTimeout(() => {
            setGrainientPhase("active");
            grainientEnterTimerRef.current = null;
          }, GRAINIENT_ENTER_SETTLE_MS);
          return "entering";
        }

        return "active";
      });
      return;
    }

    if (!isImageGenerating && generatedImage && grainientViewportRect) {
      clearTimer(grainientEnterTimerRef);
      clearTimer(grainientExitTimerRef);
      setGrainientPhase("active");
      return;
    }

    clearTimer(grainientEnterTimerRef);
    setGrainientPhase((current) =>
      current === "hidden" ? current : "exiting",
    );
    clearTimer(grainientExitTimerRef);
    grainientExitTimerRef.current = window.setTimeout(() => {
      setGrainientPhase("hidden");
      setGrainientViewportRect(null);
      grainientExitTimerRef.current = null;
    }, GRAINIENT_EXIT_SETTLE_MS);
  }, [
    frameViewportRect,
    generatedImage,
    grainientViewportRect,
    isImageGenerating,
  ]);

  useEffect(() => {
    if (generationFrameId) {
      return;
    }

    sendImageGenerationFrame?.(null);
  }, [generationFrameId, sendImageGenerationFrame]);

  useEffect(() => {
    if (!generatedImage || isImageGenerating) {
      return;
    }

    const editor = editorRef.current;
    const frameId = generationFrameId;
    if (!editor || !frameId) {
      hideGrainientImmediately();
      onGeneratedImageApplied?.();
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const frameBounds = editor.getShapePageBounds(frameId);
        if (!frameBounds) {
          hideGrainientImmediately();
          return;
        }

        const imageSrc = generatedImage.data
          ? `data:${generatedImage.mimeType ?? "image/png"};base64,${generatedImage.data}`
          : generatedImage.url;
        if (!imageSrc) {
          hideGrainientImmediately();
          return;
        }

        const { width, height } = await loadImageDimensions(imageSrc);
        if (cancelled) {
          return;
        }

        const assetId = AssetRecordType.createId();
        hideGrainientImmediately();
        editor.run(
          () => {
            removeFrameWithContents(editor, frameId);
            editor.createAssets([
              {
                id: assetId,
                type: "image",
                typeName: "asset",
                props: {
                  name: generatedImage.name || "generated-image.png",
                  src: imageSrc,
                  w: width,
                  h: height,
                  mimeType: generatedImage.mimeType ?? "image/png",
                  isAnimated: false,
                },
                meta: {},
              },
            ]);
            editor.createShape({
              type: "image",
              x: frameBounds.x,
              y: frameBounds.y,
              props: {
                assetId,
                w: frameBounds.w,
                h: frameBounds.h,
              },
            });
          },
          { ignoreShapeLock: true },
        );

        if (cancelled) {
          return;
        }

        setGenerationFrameId(null);
        setAnnotationMode("interact");
      } catch (error) {
        hideGrainientImmediately();
        console.error("Failed to apply generated image:", error);
      } finally {
        if (!cancelled) {
          onGeneratedImageApplied?.();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    generatedImage,
    generationFrameId,
    hideGrainientImmediately,
    isImageGenerating,
    onGeneratedImageApplied,
  ]);

  const syncPreviewIframe = useCallback(() => {
    const iframe = previewTargetRef.current?.querySelector("iframe");
    if (
      iframe instanceof HTMLIFrameElement &&
      previewIframeRef.current !== iframe
    ) {
      previewIframeRef.current = iframe;
      setIsPreviewReady(false);
      iframe.contentWindow?.postMessage(
        {
          source: FRAME_CONTROL_SOURCE,
          type: "capture-state",
          paused: pauseFrameStreaming,
        },
        "*",
      );
    }
  }, [pauseFrameStreaming]);

  useEffect(() => {
    syncPreviewIframe();
    const target = previewTargetRef.current;
    if (!target) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(syncPreviewIframe, 16);
    });

    observer.observe(target, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  }, [syncPreviewIframe]);

  useEffect(() => {
    previewIframeRef.current?.contentWindow?.postMessage(
      {
        source: FRAME_CONTROL_SOURCE,
        type: "capture-state",
        paused: pauseFrameStreaming,
      },
      "*",
    );
  }, [pauseFrameStreaming]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const annotateUploadedImageLabels = useCallback(
    (canvas: HTMLCanvasElement) => {
      const editor = editorRef.current;
      const container = tldrawContainerRef.current;
      if (
        !editor ||
        !container ||
        container.clientWidth === 0 ||
        container.clientHeight === 0
      ) {
        return;
      }

      const imageShapes = editor
        .getCurrentPageShapes()
        .filter((shape) => shape.type === "image");
      if (imageShapes.length === 0) {
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      const sx = canvas.width / container.clientWidth;
      const sy = canvas.height / container.clientHeight;
      imageShapes.forEach((shape, index) => {
        const bounds = editor.getShapePageBounds(shape.id);
        if (!bounds) {
          return;
        }

        const topLeft = editor.pageToViewport({ x: bounds.x, y: bounds.y });
        const cx = topLeft.x * sx;
        const cy = topLeft.y * sy;
        const label = `Image ${index + 1}`;
        ctx.font = "bold 20px sans-serif";
        const textWidth = ctx.measureText(label).width;
        const padding = 6;
        ctx.fillStyle = "rgba(255, 0, 100, 0.85)";
        ctx.fillRect(cx, cy, textWidth + padding * 2, 28);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, cx + padding, cy + 21);
      });
    },
    [],
  );

  const annotateAgentLegend = useCallback((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const titleFontSize = Math.max(15, Math.round(canvas.width * 0.017));
    const bodyFontSize = Math.max(12, Math.round(canvas.width * 0.013));
    const lineGap = Math.max(6, Math.round(bodyFontSize * 0.55));
    const paddingX = Math.max(12, Math.round(canvas.width * 0.012));
    const paddingY = Math.max(10, Math.round(canvas.height * 0.016));
    const margin = Math.max(14, Math.round(canvas.width * 0.014));

    ctx.save();
    ctx.font = `700 ${titleFontSize}px sans-serif`;
    const titleWidth = ctx.measureText(AGENT_LEGEND_TITLE).width;
    ctx.font = `600 ${bodyFontSize}px sans-serif`;
    const bodyWidth = Math.max(
      ...AGENT_LEGEND_LINES.map((line) => ctx.measureText(line).width),
    );
    const boxWidth = Math.min(
      canvas.width - margin * 2,
      Math.max(titleWidth, bodyWidth) + paddingX * 2,
    );
    const boxHeight =
      paddingY * 2 +
      titleFontSize +
      lineGap +
      AGENT_LEGEND_LINES.length * bodyFontSize +
      (AGENT_LEGEND_LINES.length - 1) * lineGap;

    ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
    ctx.fillRect(margin, margin, boxWidth, boxHeight);

    ctx.strokeStyle = "rgba(236, 72, 153, 0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(margin, margin, boxWidth, boxHeight);

    let textY = margin + paddingY + titleFontSize;
    ctx.font = `700 ${titleFontSize}px sans-serif`;
    ctx.fillStyle = "#fdf2f8";
    ctx.fillText(AGENT_LEGEND_TITLE, margin + paddingX, textY);

    ctx.font = `600 ${bodyFontSize}px sans-serif`;
    ctx.fillStyle = "#ffffff";
    for (const line of AGENT_LEGEND_LINES) {
      textY += lineGap + bodyFontSize;
      ctx.fillText(line, margin + paddingX, textY);
    }
    ctx.restore();
  }, []);

  const captureGenerationFrame = useCallback(
    (canvas: HTMLCanvasElement) => {
      const editor = editorRef.current;
      const container = tldrawContainerRef.current;
      if (
        !sendImageGenerationFrame ||
        !editor ||
        !container ||
        !generationFrameId
      ) {
        return;
      }

      const rect = getFrameCaptureRect(
        editor,
        generationFrameId,
        container,
        canvas,
      );
      if (!rect) {
        return;
      }

      const croppedCanvas = resizeCanvasToMaxDimension(
        cropCanvas(canvas, rect),
        MAX_GENERATION_FRAME_DIM,
      );
      const cropped = croppedCanvas.toDataURL("image/png").split(",")[1];
      if (cropped) {
        sendImageGenerationFrame(cropped, "image/png");
      }
    },
    [generationFrameId, sendImageGenerationFrame],
  );

  // Compositing: merge iframe frame + tldraw annotations
  const isCompositingRef = useRef(false);
  const compositeAndSend = useCallback(
    async (iframeBase64: string) => {
      // Drop frames if a previous composite is still in progress
      if (isCompositingRef.current) return;
      isCompositingRef.current = true;

      try {
        const canvas = compositingCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const previewImage = new Image();
        previewImage.src = `data:image/jpeg;base64,${iframeBase64}`;
        try {
          await previewImage.decode();
        } catch {
          return;
        }

        canvas.width = previewImage.width;
        canvas.height = previewImage.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(previewImage, 0, 0);

        const editor = editorRef.current;
        const container = tldrawContainerRef.current;
        const hasShapes = editor && editor.getCurrentPageShapeIds().size > 0;
        const hasUserAnnotations =
          !!editor &&
          editor
            .getCurrentPageShapes()
            .some((shape) => shape.type !== "image" && shape.type !== "frame");
        const hasScribbles =
          container && container.querySelector("svg.tl-overlays__item");

        if (editor && container && (hasShapes || hasScribbles)) {
          try {
            const overlayDataUrl = await domToPng(container, {
              scale: 1,
              backgroundColor: null,
              filter: (node: Node) => {
                if (node instanceof Element) {
                  const cls = node.getAttribute("class") ?? "";
                  if (cls.includes("tl-selection")) return false;
                }
                return true;
              },
            });

            if (overlayDataUrl) {
              const overlayImg = new Image();
              overlayImg.src = overlayDataUrl;
              await overlayImg.decode();
              ctx.drawImage(overlayImg, 0, 0, canvas.width, canvas.height);
            }
          } catch {
            // DOM capture failed, continue without annotations
          }
        }

        captureGenerationFrame(canvas);

        // Only clone + label if there are uploaded images to annotate
        const hasUploadedImages =
          editor &&
          editor.getCurrentPageShapes().some((shape) => shape.type === "image");
        let finalCanvas: HTMLCanvasElement;
        if (hasUploadedImages) {
          const labeledCanvas = cloneCanvas(canvas);
          annotateUploadedImageLabels(labeledCanvas);
          if (hasUserAnnotations || hasScribbles) {
            annotateAgentLegend(labeledCanvas);
          }
          finalCanvas = resizeCanvasToMaxDimension(
            labeledCanvas,
            MAX_PREVIEW_CAPTURE_DIM,
          );
        } else {
          finalCanvas = resizeCanvasToMaxDimension(
            canvas,
            MAX_PREVIEW_CAPTURE_DIM,
          );
          if (hasUserAnnotations || hasScribbles) {
            annotateAgentLegend(finalCanvas);
          }
        }
        const composited = finalCanvas
          .toDataURL("image/jpeg", 0.85)
          .split(",")[1];
        if (composited) {
          sendImage?.(composited, "image/jpeg");
        }
      } finally {
        isCompositingRef.current = false;
      }
    },
    [
      annotateAgentLegend,
      annotateUploadedImageLabels,
      captureGenerationFrame,
      sendImage,
    ],
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const previewWindow = previewIframeRef.current?.contentWindow;
      if (previewWindow && event.source !== previewWindow) {
        return;
      }

      const payload = event.data;
      if (
        !payload ||
        typeof payload !== "object" ||
        payload.source !== FRAME_SOURCE
      ) {
        return;
      }

      if (payload.type === "ready") {
        setIsPreviewReady(true);
        setCaptureError(null);
        return;
      }

      if (payload.type === "frame") {
        reportRenderedVersion(payload.renderVersion);
        if (pauseFrameStreaming) {
          return;
        }
        const base64Data =
          typeof payload.data === "string" ? payload.data : undefined;
        if (base64Data) {
          compositeAndSend(base64Data);
        }
        return;
      }

      if (payload.type === "capture-error") {
        setCaptureError(
          typeof payload.message === "string"
            ? payload.message
            : "Preview capture failed.",
        );
        reportRenderedVersion(payload.renderVersion);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [compositeAndSend, pauseFrameStreaming, reportRenderedVersion]);

  const onAssetUpload = useCallback(
    (image: UploadedImageRecord) => {
      sendText?.(
        `[User uploaded ${image.label}: "${image.name}" — URL: ${image.url} . Do NOT generate code yet. Wait for the user to tell you what to do with this image.]`,
      );
      sendImageUpload?.(image);
    },
    [sendText, sendImageUpload],
  );

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const editor = editorRef.current;
      if (!editor || !e.target.files?.length) return;
      const files = Array.from(e.target.files);
      for (const file of files) {
        await editor.putExternalContent({
          type: "files",
          files: [file],
          point: editor.getViewportPageBounds().center,
          ignoreParent: false,
        });
      }
      e.target.value = "";
      // putExternalContent switches tldraw to select tool internally;
      // switch to interact mode so the stale tldraw tool state doesn't matter
      // (interact mode disables pointer events on the overlay).
      await new Promise((r) => setTimeout(r, 0));
      editor.selectNone();
      setAnnotationMode("interact");
    },
    [],
  );

  const isAnnotating = annotationMode !== "interact";
  const isCursorActive =
    generationFrameId !== null
      ? annotationMode === "interact" || annotationMode === "select"
      : annotationMode === "interact";
  const cursorTooltip = isImageGenerating
    ? "Move frame"
    : generationFrameId
      ? annotationMode === "select"
        ? "Return to preview"
        : "Move frame"
      : "Cursor";
  const isCanvasEditLocked = isImageGenerating;

  return (
    <div className="relative h-full w-full">
      {/* Bottom bar with glass surface */}
      {renderBottomBar ? (
        <div
          className={`pointer-events-auto absolute bottom-6 left-1/2 z-30 -translate-x-1/2 transform-gpu transition-all duration-500 ease-out ${
            bottomBarVisible
              ? "translate-y-0 opacity-100 blur-0"
              : "translate-y-4 opacity-0 blur-sm"
          }`}
        >
          <GlassSurface
            width={360}
            height={65}
            borderRadius={999}
            blur={16}
            brightness={40}
            opacity={0.92}
            backgroundOpacity={0.82}
            saturation={1.2}
            style={{
              boxShadow:
                "0 10px 30px rgba(15,23,42,0.16), inset 0 0.5px 0 rgba(255,255,255,0.45)",
              border: "1px solid rgba(255,255,255,0.24)",
            }}
          >
            <div className="flex items-center gap-2">
              <Tooltip label={cursorTooltip}>
                <button
                  type="button"
                  className={cn(
                    BOTTOM_BAR_BUTTON_BASE_CLASS,
                    isCursorActive && BOTTOM_BAR_BUTTON_ACTIVE_CLASS,
                  )}
                  onClick={handleCursorClick}
                >
                  <MousePointer2 size={14} />
                </button>
              </Tooltip>
              {TOOLS.map(({ mode, icon, title }) => (
                <Tooltip key={mode} label={title}>
                  <button
                    type="button"
                    className={cn(
                      BOTTOM_BAR_BUTTON_BASE_CLASS,
                      annotationMode === mode && BOTTOM_BAR_BUTTON_ACTIVE_CLASS,
                      isCanvasEditLocked && "cursor-not-allowed opacity-40",
                    )}
                    onClick={() => setAnnotationMode(mode)}
                    disabled={isCanvasEditLocked}
                  >
                    {icon}
                  </button>
                </Tooltip>
              ))}
              <Tooltip label="Create image">
                <button
                  type="button"
                  onClick={handleGenerationFrameClick}
                  disabled={isCanvasEditLocked}
                  className={cn(
                    BOTTOM_BAR_BUTTON_BASE_CLASS,
                    annotationMode === "frame" &&
                      BOTTOM_BAR_BUTTON_ACTIVE_CLASS,
                    isCanvasEditLocked && "cursor-not-allowed opacity-40",
                  )}
                >
                  <ImagePlus size={14} />
                </button>
              </Tooltip>
              <Tooltip label="Upload image">
                <button
                  type="button"
                  onClick={handleUploadClick}
                  disabled={isCanvasEditLocked}
                  className={cn(
                    BOTTOM_BAR_BUTTON_BASE_CLASS,
                    isCanvasEditLocked && "cursor-not-allowed opacity-40",
                  )}
                >
                  <Paperclip size={14} />
                </button>
              </Tooltip>
              {sessionId && files.length > 0 && (
                <Tooltip label="Deploy & share">
                  <button
                    type="button"
                    onClick={() => setShowDeployModal(true)}
                    className={BOTTOM_BAR_BUTTON_BASE_CLASS}
                  >
                    <Rocket size={14} />
                  </button>
                </Tooltip>
              )}
              {voiceControls && (
                <>
                  <div className="mx-1 h-6 w-px bg-white/35" />
                  <div className="flex items-center gap-2">{voiceControls}</div>
                </>
              )}
            </div>
          </GlassSurface>
        </div>
      ) : null}

      {/* Sandpack iframe */}
      <div className="h-full w-full">
        <div
          ref={previewTargetRef}
          className="relative isolate h-full w-full overflow-auto bg-transparent"
        >
          <CodeRunner
            language={mainFile?.language || "tsx"}
            files={committedRunnerFiles}
            previewRenderVersion={committedPreviewVersion}
            captureMode="settled"
            showBuiltInErrorScreen={false}
            reportRuntimeErrors={false}
          />
        </div>
      </div>

      {hasPendingPreviewCandidate ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-[200vw] top-0 h-px w-px overflow-hidden opacity-0"
        >
          <CodeRunner
            language={mainFile?.language || "tsx"}
            files={runnerFiles}
            previewRenderVersion={previewRenderVersion}
            onPreviewRendered={handleStagedPreviewRendered}
            onPreviewError={handleStagedPreviewError}
            captureMode="off"
            showBuiltInErrorScreen={false}
            reportRuntimeErrors={false}
          />
        </div>
      ) : null}

      <AmbientEdgeGlow isActive={showGenerationGlow && !isImageGenerating} />

      {grainientPhase !== "hidden" && grainientViewportRect ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-[20] overflow-hidden"
          style={{
            left: grainientViewportRect.x,
            top: grainientViewportRect.y,
            width: grainientViewportRect.width,
            height: grainientViewportRect.height,
            opacity:
              grainientPhase === "active"
                ? 1
                : grainientPhase === "entering"
                  ? 0.92
                  : grainientPhase === "exiting"
                    ? 0
                    : 0,
            transition:
              grainientPhase === "exiting"
                ? "opacity 760ms cubic-bezier(0.2, 0.7, 0.2, 1)"
                : "opacity 620ms cubic-bezier(0.16, 1, 0.3, 1)",
            willChange: "opacity",
          }}
        >
          <Grainient
            color1="#FF9FFC"
            color2="#5227FF"
            color3="#B19EEF"
            timeSpeed={1}
            colorBalance={0}
            warpStrength={1}
            warpFrequency={5}
            warpSpeed={2}
            warpAmplitude={50}
            blendAngle={0}
            blendSoftness={0.05}
            rotationAmount={500}
            noiseScale={2}
            grainAmount={0.1}
            grainScale={2}
            grainAnimated={false}
            contrast={1.5}
            gamma={1}
            saturation={1}
            centerX={0}
            centerY={0}
            zoom={0.9}
          />
        </div>
      ) : null}

      {/* tldraw overlay */}
      <div
        ref={tldrawContainerRef}
        className="absolute inset-0 z-10"
        style={{ pointerEvents: isAnnotating ? "auto" : "none" }}
      >
        <TldrawOverlay
          onMount={(editor) => {
            editorRef.current = editor;
            editor.setCurrentTool(
              annotationMode === "interact" ? "select" : annotationMode,
            );
          }}
          tool={annotationMode === "interact" ? "select" : annotationMode}
          uploadFile={uploadFile}
          onAssetUpload={onAssetUpload}
          generationFrameId={generationFrameId}
          isImageGenerationActive={isImageGenerating}
          onGenerationFrameChange={handleGenerationFrameChange}
          onGenerationFrameCreated={handleGenerationFrameCreated}
        />
      </div>

      {/* Hidden file input for upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={handleFileSelected}
        style={{ display: "none" }}
      />

      {/* Hidden compositing canvas */}
      <canvas ref={compositingCanvasRef} style={{ display: "none" }} />

      {/* Deploy modal */}
      {showDeployModal && sessionId && (
        <DeployModal
          files={files}
          sessionId={sessionId}
          onClose={() => setShowDeployModal(false)}
          captureThumbnail={captureThumbnail}
        />
      )}
    </div>
  );
}
