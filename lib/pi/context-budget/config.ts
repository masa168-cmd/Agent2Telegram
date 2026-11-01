import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ModelBudget = { contextWindow: number; compactAtTokens: number };
export type BudgetConfig = { version: 1; models: Record<string, ModelBudget> };
export type BudgetSnapshot = { config: BudgetConfig; revision: string | null };
const MAX_BYTES = 64 * 1024;
export const emptyBudgetConfig = (): BudgetConfig => ({ version: 1, models: {} });
export const budgetPath = (cwd: string): string => join(cwd, ".pi", "context-budget.json");
const revision = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validateBudget(value: unknown): ModelBudget {
  if (!isObject(value) || !onlyKeys(value, ["contextWindow", "compactAtTokens"])) {
    throw new Error("预算必须且只能包含 contextWindow 和 compactAtTokens。");
  }
  const { contextWindow, compactAtTokens } = value;
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(compactAtTokens)
    || (compactAtTokens as number) <= 0 || (contextWindow as number) <= (compactAtTokens as number)) {
    throw new Error("窗口和阈值必须为安全整数，且 0 < 阈值 < 窗口。");
  }
  return { contextWindow: contextWindow as number, compactAtTokens: compactAtTokens as number };
}

export function parseBudgetConfig(value: unknown): BudgetConfig {
  if (!isObject(value) || !onlyKeys(value, ["version", "models"]) || value.version !== 1 || !isObject(value.models)) {
    throw new Error("不支持的上下文预算格式；要求 version=1 和 models，不自动覆盖未知字段。");
  }
  const models: Record<string, ModelBudget> = {};
  for (const [key, budget] of Object.entries(value.models)) {
    // Model IDs may contain slashes. No control characters or ambiguous whitespace.
    if (key.length > 512 || !/^[^/\s\x00-\x1f\x7f]+\/[^\s\x00-\x1f\x7f]+$/u.test(key)) {
      throw new Error("模型键必须为精确的 provider/model，不能含空白或控制字符。");
    }
    models[key] = validateBudget(budget);
  }
  return { version: 1, models };
}

function checkDirectory(cwd: string): boolean {
  try {
    const stat = lstatSync(join(cwd, ".pi"));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("拒绝通过符号链接或非目录的 .pi 读写预算。");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Exact cwd only. No ancestor search, settings/auth/session reads, or directory creation. */
export function readBudget(cwd: string): BudgetSnapshot {
  if (!checkDirectory(cwd)) return { config: emptyBudgetConfig(), revision: null };
  let fd: number;
  try { fd = openSync(budgetPath(cwd), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: emptyBudgetConfig(), revision: null };
    throw new Error("无法安全读取 context-budget.json；未应用或覆盖配置。", { cause: error });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("预算文件不是普通文件或超过 64 KiB。");
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_BYTES) throw new Error("预算文件超过 64 KiB。");
    let data: unknown;
    try { data = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("context-budget.json 不是有效 JSON；未覆盖原文件。"); }
    return { config: parseBudgetConfig(data), revision: revision(bytes) };
  } finally { closeSync(fd); }
}

/**
 * Cooperative mkdir lock + compare-and-swap + same-directory atomic rename.
 * apply/undo are synchronous: no user prompt or event-loop yield while holding the lock.
 * The file is published only after the runtime has verified both window and reserve.
 * No stale-lock guessing/removal. A crash may require inspecting the lock via SSH.
 */
export function saveBudget(
  cwd: string, expectedRevision: string | null, config: BudgetConfig,
  apply: () => (() => void),
): BudgetSnapshot & { cleanupWarning?: string } {
  const normalized = parseBudgetConfig(config);
  const bytes = JSON.stringify(normalized, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("预算配置超过 64 KiB。");
  if (!checkDirectory(cwd)) mkdirSync(join(cwd, ".pi"), { mode: 0o700 });
  checkDirectory(cwd);
  const path = budgetPath(cwd);
  const lock = `${path}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error("预算配置锁不可用；可能有另一操作或遗留锁。未改配置，请检查后重试。"); }
  const tmp = `${path}.${randomUUID()}.tmp`;
  let created = false;
  let undo: (() => void) | undefined;
  let committed = false;
  let failure: unknown;
  let cleanupWarning: string | undefined;
  try {
    if (readBudget(cwd).revision !== expectedRevision) throw new Error("预算配置已被另一操作修改，请重新打开菜单。");
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    // Recheck even for non-cooperating editors before touching live settings.
    if (readBudget(cwd).revision !== expectedRevision) throw new Error("预算配置已变化，请重新打开菜单。");
    undo = apply();
    renameSync(tmp, path);
    created = false;
    committed = true;
  } catch (error) {
    failure = error;
    if (undo && !committed) {
      try { undo(); }
      catch { failure = new Error("保存失败且运行参数回退未确认；停止使用新预算，请通过 SSH 检查并重载。"); }
    }
  } finally {
    try { if (created) unlinkSync(tmp); }
    catch { cleanupWarning = "临时预算文件清理失败，请通过 SSH 检查。"; }
    try { rmdirSync(lock); }
    catch { cleanupWarning = "预算锁释放失败，请通过 SSH 检查；不要盲目重复保存。"; }
  }
  if (failure) throw failure;
  return { config: normalized, revision: revision(bytes), ...(cleanupWarning ? { cleanupWarning } : {}) };
}
