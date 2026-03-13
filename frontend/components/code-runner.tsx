import CodeRunnerReact from "./code-runner-react";

export default function CodeRunner({
  language,
  code,
  files,
  onRequestFix,
  onRuntimeError,
  previewRenderVersion,
  onPreviewRendered,
}: {
  language?: string;
  code?: string;
  files?: Array<{ path: string; content: string }>;
  onRequestFix?: (e: string) => void;
  onRuntimeError?: (error: string) => void;
  previewRenderVersion?: number;
  onPreviewRendered?: (renderVersion: number) => void;
}) {
  const actualFiles =
    files || (code ? [{ path: "App.tsx", content: code }] : []);
  return (
    <CodeRunnerReact
      files={actualFiles}
      onRequestFix={onRequestFix}
      onRuntimeError={onRuntimeError}
      previewRenderVersion={previewRenderVersion}
      onPreviewRendered={onPreviewRendered}
    />
  );
}
