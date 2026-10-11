import { describe, expect, it } from "vitest";
import { appendBoundedLog, utf8ByteLength } from "./logging";

describe("appendBoundedLog", () => {
  it("keeps complete Unicode characters while respecting the byte limit", () => {
    const chunk = "á🙂".repeat(600_000);
    const result = appendBoundedLog({ text: "", byteLength: 0 }, chunk);

    expect(result.text.endsWith("[Registro truncado: límite de 2 MiB]\n")).toBe(true);
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect([...result.text].every((character) => character !== "\uFFFD")).toBe(true);
  });

  it("continues appending until the limit and then remains bounded", () => {
    const initial = "x".repeat(2 * 1024 * 1024 - 100);
    const first = appendBoundedLog({ text: initial, byteLength: initial.length }, "y".repeat(200));
    const second = appendBoundedLog(first, "z".repeat(1_000));

    expect(first.text.endsWith("[Registro truncado: límite de 2 MiB]\n")).toBe(true);
    expect(second).toEqual(first);
    expect(second.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
