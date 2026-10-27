export const UI_CALLBACK_PREFIX = "tgplus:ui:";

export const DIALOG_CALLBACK_PREFIX = "tgplus:dlg:";

/** Bot API caps callback_data at 64 UTF-8 bytes. */
export const MAX_CALLBACK_BYTES = 64;

/**
 * Dialog callbacks are `tgplus:dlg:<sessionId>:<generation>:<op>[:<arg>]`,
 * base36 ids (§4.7.1). Item identity is *not* carried here: the Broker keeps
 * `generation -> page index -> item.key` and resolves the argument against the
 * live model, so a stale button can never act on the wrong row.
 */
export type DialogCallback = {
  sessionId: string;
  generation: number;
  op: string;
  arg?: string;
};

export function encodeDialogCallback(sessionId: string, generation: number, op: string, arg?: string): string {
  const parts = [sessionId, generation.toString(36), op];
  if (arg !== undefined && arg !== "") parts.push(arg);
  const data = `${DIALOG_CALLBACK_PREFIX}${parts.join(":")}`;
  if (Buffer.byteLength(data, "utf8") > MAX_CALLBACK_BYTES) {
    throw new Error(`dialog callback exceeds ${MAX_CALLBACK_BYTES} bytes: ${data}`);
  }
  return data;
}

export function decodeDialogCallback(data: string): DialogCallback | undefined {
  if (!data.startsWith(DIALOG_CALLBACK_PREFIX)) return undefined;
  const parts = data.slice(DIALOG_CALLBACK_PREFIX.length).split(":");
  // An argument may itself contain colons (key names), so the tail is rejoined.
  if (parts.length < 3 || parts.length > 5) return undefined;
  const [sessionId, generation, op, ...rest] = parts;
  if (!sessionId || !op) return undefined;
  const parsed = Number.parseInt(generation, 36);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return { sessionId, generation: parsed, op, arg: rest.length > 0 ? rest.join(":") : undefined };
}
export const MENU_MORE_CALLBACK_PREFIX = "tgplus:more:";
export const MENU_RUN_CALLBACK_PREFIX = "tgplus:run:";

export function encodeUiCallback(value: string): string {
  return `${UI_CALLBACK_PREFIX}${value}`;
}

export function decodeUiCallback(data: string): string | undefined {
  return data.startsWith(UI_CALLBACK_PREFIX) ? data.slice(UI_CALLBACK_PREFIX.length) : undefined;
}

export function encodeMoreCallback(page: number): string {
  return `${MENU_MORE_CALLBACK_PREFIX}${page}`;
}

export function decodeMoreCallback(data: string): string | undefined {
  return data.startsWith(MENU_MORE_CALLBACK_PREFIX) ? data.slice(MENU_MORE_CALLBACK_PREFIX.length) : undefined;
}

export function encodeRunCallback(command: string): string {
  return `${MENU_RUN_CALLBACK_PREFIX}${command}`;
}

export function decodeRunCallback(data: string): string | undefined {
  return data.startsWith(MENU_RUN_CALLBACK_PREFIX) ? data.slice(MENU_RUN_CALLBACK_PREFIX.length) : undefined;
}