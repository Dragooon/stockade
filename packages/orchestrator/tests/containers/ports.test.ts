import { describe, it, expect } from "vitest";
import { PortAllocator } from "../../src/containers/ports.js";

describe("PortAllocator", () => {
  it("allocates ports sequentially from range start", () => {
    const alloc = new PortAllocator([3001, 3005]);
    expect(alloc.allocate()).toBe(3001);
    expect(alloc.allocate()).toBe(3002);
    expect(alloc.allocate()).toBe(3003);
  });

  it("release + reuse", () => {
    const alloc = new PortAllocator([3001, 3003]);
    const p1 = alloc.allocate(); // 3001
    alloc.allocate(); // 3002
    alloc.release(p1);
    // Next allocate should give 3001 back
    expect(alloc.allocate()).toBe(3001);
  });

  it("throws on range exhaustion", () => {
    const alloc = new PortAllocator([3001, 3002]);
    alloc.allocate(); // 3001
    alloc.allocate(); // 3002
    expect(() => alloc.allocate()).toThrow("No ports available");
  });

  it("isAvailable checks correctly", () => {
    const alloc = new PortAllocator([3001, 3003]);
    expect(alloc.isAvailable(3001)).toBe(true);
    alloc.allocate(); // 3001
    expect(alloc.isAvailable(3001)).toBe(false);
    expect(alloc.isAvailable(3002)).toBe(true);
    // Out of range
    expect(alloc.isAvailable(9999)).toBe(false);
  });

  it("reserve marks port as used", () => {
    const alloc = new PortAllocator([3001, 3003]);
    alloc.reserve(3001);
    expect(alloc.isAvailable(3001)).toBe(false);
    // Next allocate skips 3001
    expect(alloc.allocate()).toBe(3002);
  });

  it("tracks size", () => {
    const alloc = new PortAllocator([3001, 3005]);
    expect(alloc.size).toBe(0);
    alloc.allocate();
    alloc.allocate();
    expect(alloc.size).toBe(2);
    alloc.release(3001);
    expect(alloc.size).toBe(1);
  });
});
