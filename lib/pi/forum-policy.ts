import type { DialogModel, EntryInfo } from "./tui/model.ts";

/** Defense in depth for known host credential flows; not a general secret detector. */
export function isCredentialTitle(title: string): boolean {
  return /\b(?:log[ -]?in|log[ -]?out|sign[ -]?in|oauth|api[ _-]?key|(?:access|bot)[ _-]?token|password|secret)\b|登录|密钥|密码|令牌/i.test(title);
}
export function forumCommandPolicy(name: string): "ssh" | "confirm" | undefined {
  const command = name.toLowerCase().replace(/_/g, "-");
  if (["login", "logout", "auth", "tg-forum", "tg-setup"].includes(command)) return "ssh";
  if (["share"].includes(command)) return "confirm";
}
export function isCredentialDialog(model: DialogModel, component: object, entry?: EntryInfo): boolean {
  const ctor = (component as { constructor?: { name?: string } }).constructor?.name ?? "";
  if (/Login|OAuth|AuthUrl|Authentication/.test(ctor) || entry?.secret || isCredentialTitle(entry?.title ?? "")) return true;
  if ("title" in model && isCredentialTitle(model.title ?? "")) return true;
  if (model.kind === "input" && model.secret) return true;
  if (model.kind === "settings" && model.submenu) return isCredentialDialog(model.submenu.model, component, entry);
  return (model.kind === "progress" || model.kind === "info") && isCredentialTitle(model.text);
}
