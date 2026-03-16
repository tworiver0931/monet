import CodeRunnerReact from "./code-runner-react";

export default function CodeRunner({
  code,
  files,
  onRequestFix,
  onRuntimeError,
  onPreviewError,
  previewRenderVersion,
  onPreviewRendered,
  captureMode,
  showBuiltInErrorScreen,
  reportRuntimeErrors,
}: {
  code?: string;
  files?: Array<{ path: string; content: string }>;
  onRequestFix?: (e: string) => void;
  onRuntimeError?: (error: string) => void;
  onPreviewError?: (renderVersion: number, error: string) => void;
  previewRenderVersion?: number;
  onPreviewRendered?: (renderVersion: number) => void;
  captureMode?: "off" | "settled";
  showBuiltInErrorScreen?: boolean;
  reportRuntimeErrors?: boolean;
}) {
  const actualFiles =
    files || (code ? [{ path: "App.tsx", content: code }] : []);
  return (
    <CodeRunnerReact
      files={actualFiles}
      onRequestFix={onRequestFix}
      onRuntimeError={onRuntimeError}
      onPreviewError={onPreviewError}
      previewRenderVersion={previewRenderVersion}
      onPreviewRendered={onPreviewRendered}
      captureMode={captureMode}
      showBuiltInErrorScreen={showBuiltInErrorScreen}
      reportRuntimeErrors={reportRuntimeErrors}
    />
  );
}
