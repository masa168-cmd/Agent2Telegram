import { describe, expect, it, vi } from "vitest";
import { commandErrorMessage } from "../pi-compat.ts";

describe("pi compat redaction", () => {
  it("redacts common Telegram-visible secret formats while preserving useful labels", () => {
    const message = commandErrorMessage(new Error([
      "API key: AIzaSyDUMMYSECRET1234567890",
      "x-api-key=abcdef1234567890",
      "Authorization: Bearer bearer-secret-1234567890",
      "callback https://example.test/cb?code=abc123456789&access_token=tok123456789&state=ok",
      "github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
      "key: short",
      "key: abcdef1234567890",
    ].join("\n")));

    expect(message).toContain("API key: …");
    expect(message).toContain("x-api-key=…");
    expect(message).toContain("Authorization: Bearer …");
    expect(message).toContain("code=…");
    expect(message).toContain("access_token=…");
    expect(message).toContain("state=ok");
    expect(message).toContain("github_pat_…");
    expect(message).toContain("key: short");
    expect(message).toContain("key: …");
    expect(message).not.toContain("AIzaSyDUMMYSECRET1234567890");
    expect(message).not.toContain("bearer-secret-1234567890");
    expect(message).not.toContain("abc123456789");
    expect(message).not.toContain("tok123456789");
  });

  it("redacts JSON and quoted header dump secret formats", () => {
    const message = commandErrorMessage(new Error([
      '{"api_key":"jsonkey1234567890"}',
      '{"access_token":"jsontok1234567890"}',
      '{"authorization":"Bearer bearer-json-secret-1234567890"}',
      "Authorization: Basic dXNlcjpwYXNzMTIzNDU2",
      '{"authorization":"Token tokenvalue1234567890"}',
      'headers: { "x-api-key": "headerkey1234567890" }',
      'headers: { "Proxy-Authorization": "Basic proxysecret1234567890" }',
      "callback https://example.test/cb?code=urlcode123456&access_token=urltoken123456&state=ok",
      '{"url":"https://example.test/cb?state=ok&code=lastcode123456"}',
    ].join("\n")));

    expect(message).toContain('"api_key":"…"');
    expect(message).toContain('"access_token":"…"');
    expect(message).toContain('"authorization":"Bearer …"');
    expect(message).toContain("Authorization: Basic …");
    expect(message).toContain('"authorization":"Token …"');
    expect(message).toContain('"x-api-key": "…"');
    expect(message).toContain('"Proxy-Authorization": "Basic …"');
    expect(message).toContain("code=…");
    expect(message).toContain("access_token=…");
    expect(message).toContain("state=ok");
    expect(message).toContain('{"url":"https://example.test/cb?state=ok&code=…"}');
    expect(message).not.toContain("jsonkey1234567890");
    expect(message).not.toContain("jsontok1234567890");
    expect(message).not.toContain("bearer-json-secret-1234567890");
    expect(message).not.toContain("dXNlcjpwYXNzMTIzNDU2");
    expect(message).not.toContain("tokenvalue1234567890");
    expect(message).not.toContain("headerkey1234567890");
    expect(message).not.toContain("proxysecret1234567890");
    expect(message).not.toContain("urlcode123456");
    expect(message).not.toContain("urltoken123456");
    expect(message).not.toContain("lastcode123456");
  });
});
