import type { TelegramConfig } from "../../core/types.ts";

// Bots, pairing and per-folder connect/disconnect are managed by `a2t`
// (setup / enable / disable); the /tg menu keeps Pi's own items only.

export type TelegramCommandDeps = {
  getConfig: () => TelegramConfig;
};

// ── Shared UI type ─────────────────────────────────────────────────────────

export type MenuUi = {
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  select: (title: string, options: string[]) => Promise<string | undefined>;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
  inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined>;
  confirm: (title: string, message?: string) => Promise<boolean>;
  /** Telegram only: select that edits one menu message in place across calls. */
  menu?: (title: string, options: string[]) => Promise<string | undefined>;
  /** Telegram only: drop the keyboard of the live menu message. */
  closeMenu?: () => Promise<void>;
};
