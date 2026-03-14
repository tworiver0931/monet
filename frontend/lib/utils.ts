import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Helper function to parse fence tag for language and path
function parseFenceTag(tag: string): { language: string; path: string } {
  const raw = tag || "";
  const langMatch = raw.match(/^([A-Za-z0-9]+)/);
  const language = langMatch ? langMatch[1] : "text";
  const pathMatch = raw.match(/(?:\{\s*)?path\s*=\s*([^}\s]+)(?:\s*\})?/);
  const filenameMatch = raw.match(
    /(?:\{\s*)?filename\s*=\s*([^}\s]+)(?:\s*\})?/,
  );
  const path = pathMatch
    ? pathMatch[1]
    : filenameMatch
      ? filenameMatch[1]
      : `file.${getExtensionForLanguage(language)}`;
  return { language, path };
}

const CODE_BLOCK_REGEX = /```([^\n]*)\n([\s\S]*?)\n```/g;

export function extractAllCodeBlocks(input: string): Array<{
  code: string;
  language: string;
  path: string;
  fullMatch: string;
}> {
  const files: Array<{
    code: string;
    language: string;
    path: string;
    fullMatch: string;
  }> = [];

  for (const match of input.matchAll(CODE_BLOCK_REGEX)) {
    const fenceTag = match[1] || "";
    const code = match[2];
    const fullMatch = match[0];

    const { language, path } = parseFenceTag(fenceTag);

    files.push({ code, language, path, fullMatch });
  }

  return files;
}

export function getExtensionForLanguage(language: string): string {
  const extensions: Record<string, string> = {
    javascript: "js",
    js: "js",
    typescript: "tsx",
    ts: "ts",
    tsx: "tsx",
    jsx: "jsx",
    python: "py",
    py: "py",
    html: "html",
    css: "css",
    json: "json",
    markdown: "md",
    md: "md",
    sql: "sql",
    shell: "sh",
    bash: "sh",
    sh: "sh",
    yaml: "yaml",
    yml: "yml",
  };

  return extensions[language.toLowerCase()] || "txt";
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function toTitleCase(rawName: string): string {
  const parts = rawName.split(/[-_]+/);

  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}
