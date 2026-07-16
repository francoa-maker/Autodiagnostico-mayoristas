import { describe, it, expect, vi } from "vitest";
import { requireApproved, requireAdmin } from "../src/middleware.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("requireApproved", () => {
  it("401s when there is no user", () => {
    const res = mockRes();
    const next = vi.fn();
    requireApproved({ user: null }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s a pending customer", () => {
    const res = mockRes();
    const next = vi.fn();
    requireApproved({ user: { role: "customer", status: "pending" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s a blocked admin - admin-ness never substitutes for approval", () => {
    const res = mockRes();
    const next = vi.fn();
    requireApproved({ user: { role: "admin", status: "blocked" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes an approved customer", () => {
    const res = mockRes();
    const next = vi.fn();
    requireApproved({ user: { role: "customer", status: "approved" } }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("passes an approved admin", () => {
    const res = mockRes();
    const next = vi.fn();
    requireApproved({ user: { role: "admin", status: "approved" } }, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe("requireAdmin", () => {
  it("401s when there is no user", () => {
    const res = mockRes();
    const next = vi.fn();
    requireAdmin({ user: null }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("403s an approved customer (role, not just status, matters)", () => {
    const res = mockRes();
    const next = vi.fn();
    requireAdmin({ user: { role: "customer", status: "approved" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s a pending admin", () => {
    const res = mockRes();
    const next = vi.fn();
    requireAdmin({ user: { role: "admin", status: "pending" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes only an approved admin", () => {
    const res = mockRes();
    const next = vi.fn();
    requireAdmin({ user: { role: "admin", status: "approved" } }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
