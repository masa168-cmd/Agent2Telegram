// Test-only preload. Allows loopback IPC; rejects external fetch/socket connections before DNS/connect.
import net from "node:net";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.EX_OFFLINE_ROOT;
if (!root) throw new Error("EX_OFFLINE_ROOT is required by the offline network guard");
const local = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
function blocked(host) {
  appendFileSync(join(root, "blocked-network.log"), `${String(host)}\n`);
  throw new Error(`Offline test blocked external network host: ${host}`);
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === "object" && first !== null ? first : undefined;
  if (!options?.path && !(typeof first === "string" && !/^\d+$/.test(first))) {
    const host = options?.host ?? (typeof args[1] === "string" ? args[1] : "localhost");
    if (!local.has(host)) blocked(host);
  }
  return connect.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!local.has(url.hostname)) blocked(url.hostname);
  return fetch(input, init);
};
