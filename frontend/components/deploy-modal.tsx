"use client";

import { useState, useCallback } from "react";
import { X, Rocket, Check, Copy, ExternalLink } from "lucide-react";
import type { CodeFile } from "@/lib/websocket";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

export default function DeployModal({
  files,
  sessionId,
  onClose,
  captureThumbnail,
}: {
  files: CodeFile[];
  sessionId: string;
  onClose: () => void;
  captureThumbnail?: () => Promise<string | null>;
}) {
  const [title, setTitle] = useState("Untitled App");
  const [description, setDescription] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [deployedUrl, setDeployedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleDeploy = useCallback(async () => {
    setDeploying(true);
    setError(null);

    try {
      let thumbnail: string | null = null;
      if (captureThumbnail) {
        try {
          thumbnail = await captureThumbnail();
        } catch {
          // Continue without thumbnail
        }
      }

      const res = await fetch(`${BACKEND_URL}/api/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          title: title.trim() || "Untitled App",
          description: description.trim() || null,
          files: files.map((f) => ({
            path: f.path,
            code: f.code,
            language: f.language,
          })),
          thumbnail,
        }),
      });

      if (!res.ok) {
        throw new Error(`Deploy failed: ${res.status}`);
      }

      const data = await res.json();
      const fullUrl = `${window.location.origin}${data.url}`;
      setDeployedUrl(fullUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setDeploying(false);
    }
  }, [files, sessionId, title, description, captureThumbnail]);

  const handleCopy = useCallback(async () => {
    if (!deployedUrl) return;
    await navigator.clipboard.writeText(deployedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [deployedUrl]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <X size={18} />
        </button>

        {!deployedUrl ? (
          <>
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-gray-900">
                Deploy your app
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                Get a shareable link anyone can use
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="My awesome app"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Description{" "}
                  <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="A brief description of your app"
                />
              </div>

              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}

              <button
                onClick={handleDeploy}
                disabled={deploying || files.length === 0}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Rocket size={16} />
                {deploying ? "Deploying..." : "Deploy"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-5 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                <Check size={24} className="text-green-600" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900">
                App deployed!
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                Share this link with anyone
              </p>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <input
                type="text"
                value={deployedUrl}
                readOnly
                className="flex-1 truncate bg-transparent text-sm text-gray-800 focus:outline-none"
              />
              <button
                onClick={handleCopy}
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-200"
                title="Copy link"
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
              <a
                href={deployedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-200"
                title="Open in new tab"
              >
                <ExternalLink size={16} />
              </a>
            </div>

            <button
              onClick={onClose}
              className="mt-4 w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
