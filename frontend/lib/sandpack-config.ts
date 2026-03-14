import { REACT_TYPESCRIPT_TEMPLATE } from "@codesandbox/sandpack-react/unstyled";

const SANDBOX_ENTRY = "/index.tsx";

function normalizeSandpackPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function sanitizeSandpackFiles(
  files: Array<{ path: string; content: string }>,
): Array<{ path: string; content: string }> {
  return files.map((file, index) => {
    const rawPath = typeof file.path === "string" ? file.path.trim() : "";

    return {
      path: rawPath || `generated/file-${index + 1}.tsx`,
      content: typeof file.content === "string" ? file.content : "",
    };
  });
}

function getTemplateFileCode(path: string): string {
  const file =
    REACT_TYPESCRIPT_TEMPLATE.files[
      path as keyof typeof REACT_TYPESCRIPT_TEMPLATE.files
    ];

  if (typeof file === "string") {
    return file;
  }

  return file?.code ?? "";
}

const templatePackageJson = JSON.parse(getTemplateFileCode("/package.json"));
const templatePublicIndexHtml = getTemplateFileCode("/public/index.html");

type SandpackConfigOptions = {
  captureMode?: "off" | "settled";
  renderVersion?: number;
};

export function getSandpackConfig(
  files: Array<{ path: string; content: string }>,
  options: SandpackConfigOptions = {},
) {
  const sanitizedFiles = sanitizeSandpackFiles(files);
  const captureMode = options.captureMode ?? "settled";
  const renderVersion =
    typeof options.renderVersion === "number" &&
    Number.isFinite(options.renderVersion)
      ? Math.max(0, Math.floor(options.renderVersion))
      : 0;
  const sandpackFiles: Record<string, string> = {};
  let hasAppFile = false;

  // Add tsconfig
  sandpackFiles["/tsconfig.json"] = `{
    "include": [
      "./**/*"
    ],
    "compilerOptions": {
      "strict": true,
      "esModuleInterop": true,
      "lib": [ "dom", "es2015" ],
      "jsx": "react-jsx",
      "baseUrl": "./",
      "paths": {
        "@/components/*": ["components/*"],
        "@/lib/*": ["lib/*"],
        "@/utils/*": ["utils/*"],
        "@/types/*": ["types/*"]
      }
    }
  }`;

  // Add user files
  for (const file of sanitizedFiles) {
    // Normalize paths - remove leading slash if present, and ensure proper structure
    let normalizedPath = file.path.startsWith("/")
      ? file.path.slice(1)
      : file.path;

    // If path starts with src/, remove it to place files at root level
    if (normalizedPath.startsWith("src/")) {
      normalizedPath = normalizedPath.slice(4);
    }

    // Strip `@import "tailwindcss"` from CSS files — Tailwind is loaded via
    // CDN external resource; the import causes PostCSS path resolution errors.
    let content = file.content;
    if (normalizedPath.endsWith(".css")) {
      content = content.replace(/@import\s+['"]tailwindcss['"]\s*;?/g, "");
    }
    sandpackFiles[normalizedPath] = content;
    if (normalizedPath === "App.tsx") {
      hasAppFile = true;
    }
  }

  // Ensure App.tsx is the entry point, or if not present, create one that imports the first file
  if (!hasAppFile && sanitizedFiles.length > 0) {
    const mainFile =
      sanitizedFiles.find(
        (f) => f.path.endsWith(".tsx") || f.path.endsWith(".jsx"),
      ) || sanitizedFiles[0];

    // Normalize the path for import
    let importPath = mainFile.path.startsWith("/")
      ? mainFile.path.slice(1)
      : mainFile.path;
    if (importPath.startsWith("src/")) {
      importPath = importPath.slice(4);
    }
    importPath = importPath.replace(/\.tsx?$/, "");

    sandpackFiles["App.tsx"] = `import React from 'react';
import MainComponent from './${importPath}';

export default function App() {
  return <MainComponent />;
}`;
  }

  if (!sandpackFiles["App.tsx"]) {
    sandpackFiles["App.tsx"] = `export default function App() {
  return <div style={{ width: "100%", height: "100%", background: "#ffffff" }} />;
}`;
  }

  sandpackFiles["preview-capture.tsx"] =
    `import React, { useCallback, useEffect, useRef } from "react";
import { domToJpeg } from "modern-screenshot";

const FRAME_SOURCE = "sandpack-preview-capture";
const FRAME_CONTROL_SOURCE = "sandpack-preview-control";
const CAPTURE_DEBOUNCE_MS = 250;
const CAPTURE_INTERVAL_MS = 1000;
const PREVIEW_RENDER_VERSION = ${renderVersion};

export function PreviewCaptureRoot({
  children,
}: {
  children: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const isCapturingRef = useRef(false);
  const isPausedRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);

  const postToParent = useCallback((payload: Record<string, unknown>) => {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source: FRAME_SOURCE, ...payload }, "*");
    }
  }, []);

  const captureFrame = useCallback(async () => {
    if (isCapturingRef.current || isPausedRef.current || !rootRef.current) return;
    isCapturingRef.current = true;
    try {
      const dataUrl = await domToJpeg(rootRef.current, {
        quality: 0.85,
        scale: 1,
        backgroundColor: "#ffffff",
      });
      const data = dataUrl ? dataUrl.split(",")[1] : undefined;
      if (data && !isPausedRef.current) {
        postToParent({
          type: "frame",
          mimeType: "image/jpeg",
          data,
          renderVersion: PREVIEW_RENDER_VERSION,
        });
      }
    } catch (error) {
      postToParent({
        type: "capture-error",
        message: error instanceof Error ? error.message : "Preview capture failed.",
        renderVersion: PREVIEW_RENDER_VERSION,
      });
    } finally {
      isCapturingRef.current = false;
    }
  }, [postToParent]);

  const scheduleCapture = useCallback(() => {
    if (isPausedRef.current) return;
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void captureFrame();
    }, CAPTURE_DEBOUNCE_MS);
  }, [captureFrame]);

  useEffect(() => {
    postToParent({ type: "ready", renderVersion: PREVIEW_RENDER_VERSION });
    scheduleCapture();

    const root = rootRef.current;
    if (!root) return;

    const observer = new MutationObserver(() => {
      scheduleCapture();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    window.addEventListener("resize", scheduleCapture);
    window.addEventListener("scroll", scheduleCapture, true);

    const intervalId = window.setInterval(() => {
      if (!isPausedRef.current && !isCapturingRef.current) {
        void captureFrame();
      }
    }, CAPTURE_INTERVAL_MS);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleCapture);
      window.removeEventListener("scroll", scheduleCapture, true);
      window.clearInterval(intervalId);
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [postToParent, scheduleCapture]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (
        !payload ||
        typeof payload !== "object" ||
        payload.source !== FRAME_CONTROL_SOURCE ||
        payload.type !== "capture-state"
      ) {
        return;
      }

      isPausedRef.current = Boolean(payload.paused);
      if (!isPausedRef.current) {
        scheduleCapture();
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [scheduleCapture]);

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        width: "100%",
        minHeight: "100vh",
        overflow: "auto",
        background: "#ffffff",
      }}
    >
      <style>{\`
        html, body, #root {
          width: 100%;
          min-height: 100%;
          margin: 0;
          padding: 0;
          overflow: auto;
          background: #ffffff;
        }
      \`}</style>
      <div style={{ width: "100%", minHeight: "100%" }}>{children}</div>
    </div>
  );
}`;

  sandpackFiles["index.tsx"] =
    captureMode === "off"
      ? `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}`
      : `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { PreviewCaptureRoot } from "./preview-capture";

const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <PreviewCaptureRoot>
        <App />
      </PreviewCaptureRoot>
    </React.StrictMode>,
  );
}`;

  return {
    template: "react-ts" as const,
    files: sandpackFiles,
    options: {
      externalResources: [
        "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4",
      ],
    },
    customSetup: {
      entry: SANDBOX_ENTRY,
      dependencies,
      devDependencies,
    },
  };
}

export function getSandpackClientConfig(
  files: Array<{ path: string; content: string }>,
  showErrorScreen: boolean,
  options: SandpackConfigOptions = {},
) {
  const config = getSandpackConfig(files, options);
  const bundlerFiles: Record<string, { code: string }> = {};

  for (const [path, code] of Object.entries(config.files)) {
    bundlerFiles[normalizeSandpackPath(path)] = { code };
  }

  bundlerFiles["/public/index.html"] ??= {
    code: templatePublicIndexHtml,
  };

  bundlerFiles["/package.json"] = {
    code: JSON.stringify(
      {
        ...templatePackageJson,
        main: SANDBOX_ENTRY,
        dependencies,
        devDependencies,
      },
      null,
      2,
    ),
  };

  return {
    sandboxSetup: {
      template: "create-react-app-typescript" as const,
      entry: SANDBOX_ENTRY,
      files: bundlerFiles,
      dependencies,
      devDependencies,
    },
    clientOptions: {
      externalResources: config.options.externalResources,
      showOpenInCodeSandbox: false,
      showErrorScreen,
      showLoadingScreen: false,
    },
  };
}

const dependencies = {
  react: "^19.0.0",
  "react-dom": "^19.0.0",
  "react-scripts": "^4.0.0",
  "modern-screenshot": "^4.4.39",
  "lucide-react": "latest",
  recharts: "2.9.0",
  "react-router-dom": "latest",
  "framer-motion": "^11.15.0",
  "date-fns": "^3.6.0",
};

const devDependencies = {
  "@types/react": "^19.0.0",
  "@types/react-dom": "^19.0.0",
  typescript: "^4.0.0",
};
