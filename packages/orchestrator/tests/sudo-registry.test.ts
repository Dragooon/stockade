import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SudoRegistry } from "../src/sudo.js";

function registry() {
  let now = 1_000_000;
  const sudo = new SudoRegistry(join(mkdtempSync(join(tmpdir(), "sudo-registry-")), "sudo-scopes.json"), 60_000, () => now);
  return { sudo, advance: (ms: number) => { now += ms; } };
}

describe("SudoRegistry.isActive", () => {
  it("is true for an active scope and false for an everyday one", () => {
    const { sudo } = registry();
    sudo.open("discord:g:1", "shitiz");
    expect(sudo.isActive("discord:g:1")).toBe(true);
    expect(sudo.isActive("discord:g:2")).toBe(false);
  });

  it("clears an expired scope, runs onExpired once, and reports it as everyday", () => {
    const { sudo, advance } = registry();
    sudo.open("discord:g:1", "shitiz");
    advance(60_001);
    let expired = 0;
    expect(sudo.isActive("discord:g:1", () => { expired++; })).toBe(false);
    expect(sudo.isActive("discord:g:1", () => { expired++; })).toBe(false);
    expect(expired).toBe(1);
    expect(sudo.state("discord:g:1")).toBe("none");
  });
});
