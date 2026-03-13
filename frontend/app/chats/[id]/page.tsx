"use client";

import { extractAllCodeBlocks } from "@/lib/utils";
import { AudioPlayer } from "@/lib/audio-player";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useParams, useSearchParams } from "next/navigation";
import CodeViewer from "@/components/code-viewer";
import {
  BottomBarVoiceControls,
  type BottomBarVoiceControlsHandle,
} from "@/components/bottom-bar-voice-controls";
import { useWebSocket } from "@/hooks/use-websocket";
import type { CodeFile } from "@/lib/websocket";
import { useHomeScreenTransition } from "@/components/home-screen-transition";

function areCodeFilesEqual(prev: CodeFile[], next: CodeFile[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;

  for (let i = 0; i < prev.length; i += 1) {
    const prevFile = prev[i];
    const nextFile = next[i];
    if (
      prevFile.path !== nextFile.path ||
      prevFile.code !== nextFile.code ||
      prevFile.language !== nextFile.language
    ) {
      return false;
    }
  }

  return true;
}

export default function Page() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const sessionId = params.id;
  const userId = searchParams.get("userId") || `user-${sessionId}`;

  const { phase: homeTransitionPhase, revealHomeTransition } =
    useHomeScreenTransition();
  const [activeTab, setActiveTab] = useState<"code" | "preview">("preview");
  const [allFiles, setAllFiles] = useState<CodeFile[]>([]);
  const [, setIsAgentPlaybackActive] = useState(false);
  const [isRecordingActive, setIsRecordingActive] = useState(false);
  const [shouldRenderBottomBar, setShouldRenderBottomBar] = useState(
    homeTransitionPhase === "idle",
  );
  const [isBottomBarVisible, setIsBottomBarVisible] = useState(
    homeTransitionPhase === "idle",
  );
  const recorderRef = useRef<any>(null);
  const mountedRef = useRef(false);
  const allFilesRef = useRef<CodeFile[]>([]);
  const previewRenderVersionRef = useRef(0);

  // Direct ref to AudioPlayer -- avoids stale closure issues
  const playerRef = useRef<AudioPlayer | null>(null);
  const voiceControlsRef = useRef<BottomBarVoiceControlsHandle | null>(null);

  const handleAudioReceived = useCallback((pcmData: ArrayBuffer) => {
    playerRef.current?.play(pcmData);
  }, []);

  const handleInterrupted = useCallback(() => {
    setIsAgentPlaybackActive(false);
    voiceControlsRef.current?.resetAgentAudio();
    playerRef.current?.stop();
  }, []);

  const {
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
    timeoutReason,
  } = useWebSocket(userId, sessionId, handleAudioReceived, handleInterrupted);
  const [previewRenderVersion, setPreviewRenderVersion] = useState(0);
  const [renderedPreviewVersion, setRenderedPreviewVersion] = useState(0);
  const [pendingPreviewVersion, setPendingPreviewVersion] = useState<
    number | null
  >(null);

  const activeCodeResult =
    codeResult &&
    codeJob?.jobId === codeResult.jobId &&
    codeJob.status !== "cancelled" &&
    codeJob.status !== "failed"
      ? codeResult
      : null;

  const activeGeneratedImage =
    generatedImage &&
    imageJob?.jobId === generatedImage.jobId &&
    imageJob.status !== "cancelled" &&
    imageJob.status !== "failed"
      ? generatedImage
      : null;

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setIsRecordingActive(false);
    voiceControlsRef.current?.resetUserAudio();
  }, []);

  const startRecording = useCallback(async () => {
    if (recorderRef.current) return;

    const { AudioRecorder } = await import("@/lib/audio-recorder");
    const recorder = new AudioRecorder();
    recorderRef.current = recorder;

    try {
      await recorder.start(
        (pcmBuffer: ArrayBuffer) => {
          sendAudio(pcmBuffer);
        },
        (level: number) => {
          voiceControlsRef.current?.pushUserAudioLevel(level);
        },
      );
      setIsRecordingActive(true);
    } catch (err) {
      if (recorderRef.current === recorder) {
        recorderRef.current = null;
      }
      recorder.stop();
      voiceControlsRef.current?.resetUserAudio();
      console.error("Mic access denied:", err);
    }
  }, [sendAudio]);

  const handleRuntimeError = useCallback(
    (error: string) => {
      sendRuntimeError(error);
    },
    [sendRuntimeError],
  );

  const applyFiles = useCallback(
    (
      nextFiles: CodeFile[],
      options: {
        awaitPreview?: boolean;
      } = {},
    ) => {
      if (
        nextFiles.length === 0 ||
        areCodeFilesEqual(allFilesRef.current, nextFiles)
      ) {
        return;
      }

      allFilesRef.current = nextFiles;
      setAllFiles(nextFiles);
      setActiveTab((prev) => (prev === "preview" ? prev : "preview"));

      const nextRenderVersion = previewRenderVersionRef.current + 1;
      previewRenderVersionRef.current = nextRenderVersion;
      setPreviewRenderVersion(nextRenderVersion);

      if (options.awaitPreview) {
        setPendingPreviewVersion(nextRenderVersion);
      }
    },
    [],
  );

  useEffect(() => {
    if (homeTransitionPhase !== "holding") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      revealHomeTransition();
    }, 500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [homeTransitionPhase, revealHomeTransition]);

  useEffect(() => {
    let showTimeoutId = 0;
    let fadeFrameId = 0;

    if (homeTransitionPhase !== "idle") {
      setIsBottomBarVisible(false);
      setShouldRenderBottomBar(false);
      return;
    }

    if (shouldRenderBottomBar && isBottomBarVisible) {
      return;
    }

    showTimeoutId = window.setTimeout(() => {
      setShouldRenderBottomBar(true);
      fadeFrameId = window.requestAnimationFrame(() => {
        setIsBottomBarVisible(true);
      });
    }, 140);

    return () => {
      window.clearTimeout(showTimeoutId);
      window.cancelAnimationFrame(fadeFrameId);
    };
  }, [homeTransitionPhase, isBottomBarVisible, shouldRenderBottomBar]);

  // When code files arrive from WebSocket
  useLayoutEffect(() => {
    if (!activeCodeResult) {
      return;
    }
    applyFiles(activeCodeResult.files, { awaitPreview: true });
  }, [activeCodeResult, applyFiles]);

  // Extract code from streamed text — only parse when at least one
  // complete fenced block exists (opening + closing ```).
  const lastExtractedStreamRef = useRef("");
  useLayoutEffect(() => {
    if (!streamText || !streamText.includes("```")) return;

    // Count fence markers; need at least 2 for one complete block.
    const fenceCount = streamText.split("```").length - 1;
    if (fenceCount < 2) return;

    // Skip re-extraction if no new closing fence appeared since last run.
    const lastClosing = streamText.lastIndexOf("```");
    const marker = streamText.slice(0, lastClosing + 3);
    if (marker === lastExtractedStreamRef.current) return;
    lastExtractedStreamRef.current = marker;

    const extracted = extractAllCodeBlocks(streamText);
    if (extracted.length === 0) return;

    const nextFiles: CodeFile[] = extracted.map((file) => ({
      path: file.path,
      code: file.code,
      language: file.language,
    }));

    applyFiles(nextFiles);
  }, [applyFiles, streamText]);

  // Connect WebSocket on mount
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
    };
  }, [connect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRecording();
      void playerRef.current?.close();
      playerRef.current = null;
      disconnect();
    };
  }, [disconnect, stopRecording]);

  // Init player and start mic once connected
  useEffect(() => {
    if (connectionState !== "connected") {
      setIsAgentPlaybackActive(false);
      stopRecording();
      return;
    }

    if (recorderRef.current) return;

    void (async () => {
      try {
        if (!playerRef.current) {
          const player = new AudioPlayer();
          await player.init(
            (level: number) => {
              voiceControlsRef.current?.pushAgentAudioLevel(level);
            },
            (isPlaying: boolean) => {
              setIsAgentPlaybackActive(isPlaying);
            },
          );
          playerRef.current = player;
        }

        await startRecording();
      } catch (err) {
        console.error("Audio initialization failed:", err);
      }
    })();
  }, [connectionState, startRecording, stopRecording]);

  const handlePreviewRendered = useCallback((renderVersion: number) => {
    setRenderedPreviewVersion((current) => Math.max(current, renderVersion));
    setPendingPreviewVersion((current) =>
      current !== null && renderVersion >= current ? null : current,
    );
  }, []);

  const showGenerationGlow =
    isCodeAgentGenerating ||
    (pendingPreviewVersion !== null &&
      pendingPreviewVersion > renderedPreviewVersion);

  return (
    <div className="relative h-dvh overflow-hidden">
      {timeoutReason && (
        <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center bg-red-600 px-4 py-3 text-white text-sm font-medium">
          {timeoutReason === "idle"
            ? "Session ended due to inactivity."
            : "Session ended — maximum duration reached."}
        </div>
      )}
      {/* Full-screen preview background */}
      <div className="absolute inset-0">
        <CodeViewer
          files={allFiles}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onClose={() => {}}
          pauseFrameStreaming={false}
          sendImage={sendImage}
          sendImageGenerationFrame={sendImageGenerationFrame}
          sendText={sendText}
          sendImageUpload={sendImageUpload}
          onRuntimeError={handleRuntimeError}
          bottomBarVisible={isBottomBarVisible}
          renderBottomBar={shouldRenderBottomBar}
          showGenerationGlow={showGenerationGlow}
          isImageGenerating={isImageGenerating}
          generatedImage={activeGeneratedImage}
          onGeneratedImageApplied={clearGeneratedImage}
          previewRenderVersion={previewRenderVersion}
          onPreviewRendered={handlePreviewRendered}
          sessionId={sessionId}
          voiceControls={
            <BottomBarVoiceControls
              ref={voiceControlsRef}
              isConnected={connectionState === "connected"}
              isRecording={isRecordingActive}
            />
          }
        />
      </div>
    </div>
  );
}
