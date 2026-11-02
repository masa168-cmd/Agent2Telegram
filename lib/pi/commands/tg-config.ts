import type { TgConfigDeps } from "./register.ts";
import type { TelegramConfig, TelegramRenderLevel } from "../../core/types.ts";
import { RENDER_LEVELS } from "../../core/types.ts";
import type { MenuUi } from "./telegram-commands.ts";

const KEY_LABELS: Record<string, string> = {
  tool: "🔧 Tool rendering",
  retry: "🔄 Retry count",
};

// ── Reusable config flow functions (used by the /tg Config submenu) ───────

export async function configToolFlow(
  ui: MenuUi,
  deps: TgConfigDeps,
  value?: string,
): Promise<void> {
  const config = deps.getConfig();
  const current = config.tool ?? "brief";
  let selectedValue: TelegramRenderLevel | undefined;
  if (value && (RENDER_LEVELS as readonly string[]).includes(value)) {
    selectedValue = value as TelegramRenderLevel;
  } else if (!value) {
    selectedValue = await pickRenderLevel(ui, KEY_LABELS.tool, current);
  } else {
    ui.notify("Invalid. Use: hidden, brief, or full", "error");
    return;
  }
  if (!selectedValue) return;
  const next: TelegramConfig = { ...config, tool: selectedValue };
  deps.setConfig(next);
  await deps.persistConfig(next);
  ui.notify(`${KEY_LABELS.tool} set to ${selectedValue}`, "info");
}

export async function configRetryFlow(
  ui: MenuUi,
  deps: TgConfigDeps,
  value?: string,
): Promise<void> {
  const config = deps.getConfig();
  const currentRetry = config.retryCount ?? 3;
  const inputValue = value ?? await ui.input("Retry count (0-10)", `Current: ${currentRetry}`);
  if (!inputValue) return;
  const n = parseInt(inputValue, 10);
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    ui.notify("Must be a number 0-10", "error");
    return;
  }
  const next = { ...config, retryCount: n };
  deps.setConfig(next);
  await deps.persistConfig(next);
  ui.notify(`${KEY_LABELS.retry} set to ${n}`, "info");
}

async function pickRenderLevel(ui: MenuUi, title: string, current: TelegramRenderLevel): Promise<TelegramRenderLevel | undefined> {
  const labels = [...RENDER_LEVELS].map((v) => (v === current ? `● ${v}` : `  ${v}`));
  const choice = await ui.select(title, labels);
  if (!choice) return undefined;
  const idx = labels.indexOf(choice);
  if (idx < 0 || idx >= RENDER_LEVELS.length) return undefined;
  return RENDER_LEVELS[idx];
}