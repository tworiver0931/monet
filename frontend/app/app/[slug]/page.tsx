"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

const CodeRunner = dynamic(() => import("@/components/code-runner"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh w-full items-center justify-center bg-white">
      <p className="text-sm text-gray-400">Loading...</p>
    </div>
  ),
});

type DeploymentFile = {
  path: string;
  code: string;
  language: string;
};

export default function DeployedAppPage() {
  const params = useParams<{ slug: string }>();
  const [files, setFiles] = useState<DeploymentFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchDeployment() {
      try {
        const res = await fetch(`${BACKEND_URL}/api/deployments/${params.slug}`);
        if (!res.ok) {
          setError(res.status === 404 ? "App not found" : "Failed to load app");
          return;
        }
        const data = await res.json();
        setFiles(data.files);
      } catch {
        setError("Failed to load app");
      }
    }
    fetchDeployment();
  }, [params.slug]);

  if (error) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-white">
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    );
  }

  if (!files) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-white">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  const runnerFiles = files.map((f) => ({ path: f.path, content: f.code }));

  return (
    <div className="h-dvh w-full">
      <CodeRunner files={runnerFiles} />
    </div>
  );
}
