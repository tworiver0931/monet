let typescriptModulePromise: Promise<typeof import("typescript")> | null = null;

const VALIDATABLE_PATH = /\.[cm]?[jt]sx?$/i;

function canValidate(path: string): boolean {
  return VALIDATABLE_PATH.test(path.trim());
}

function getTypeScriptModule() {
  if (!typescriptModulePromise) {
    typescriptModulePromise = import("typescript");
  }

  return typescriptModulePromise;
}

export async function getSandpackSyntaxError(
  files: Array<{ path: string; content: string }>,
): Promise<string | null> {
  const candidates = files.filter((file) => canValidate(file.path));
  if (candidates.length === 0) {
    return null;
  }

  const ts = await getTypeScriptModule();

  for (const file of candidates) {
    const result = ts.transpileModule(
      file.content,
      {
        fileName: file.path,
        reportDiagnostics: true,
        compilerOptions: {
          allowJs: true,
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ESNext,
        },
      },
    );
    const diagnostic = result.diagnostics?.find(
      (entry) => entry.category === ts.DiagnosticCategory.Error,
    );

    if (!diagnostic) {
      continue;
    }

    const start = typeof diagnostic.start === "number" ? diagnostic.start : 0;
    const sourceFile =
      diagnostic.file ??
      ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );
    const normalizedPath = `/${file.path.replace(/^\/+/, "")}`;

    return `${message}\n\n${normalizedPath}:${line + 1}:${character + 1}`;
  }

  return null;
}
