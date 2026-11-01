/** Test-only loader, using the existing devDependency; no Node native TS support required. */
import { readFile } from "node:fs/promises";
import ts from "typescript";

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !url.endsWith(".ts") || url.includes("/node_modules/")) {
    return nextLoad(url, context);
  }
  const source = await readFile(new URL(url), "utf8");
  const result = ts.transpileModule(source, { fileName: new URL(url).pathname,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return { format: "module", source: result.outputText, shortCircuit: true };
}
