// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
function unauthorized() {
  return new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), { status: 401 });
}

let session: typeof import("./site-session");
let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>;
beforeEach(async () => {
  // Every test represents a new document. In the browser login/logout use full-page navigation.
  vi.resetModules();
  session = await import("./site-session");
  window.history.replaceState(null, "", "/studio");
  assign = vi.fn<(url: string | URL) => void>();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("explicit logout and outstanding session checks", () => {
  it("lets logout own navigation when a separate client's read returns 401 before its 204", async () => {
    const read = deferred<Response>();
    const write = deferred<Response>();
    const readRequest = session.withSession(() => read.promise)("/api/v1/projects");
    const logoutRequest = session.logout(() => write.promise);
    const response = unauthorized();
    read.resolve(response);
    expect(await readRequest).toBe(response);
    const duringLogout = [...assign.mock.calls];
    write.resolve(new Response(null, { status: 204 }));
    await logoutRequest;
    session.goToLogin("signed-out");
    expect(duringLogout).toEqual([]);
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fstudio&reason=signed-out");
    expect(assign.mock.calls.every(([url]) => String(url).endsWith("reason=signed-out"))).toBe(true);
  });

  it("does not replace signed-out while navigation is pending and another client returns a late 401", async () => {
    const read = deferred<Response>();
    const otherClient = session.withSession(() => read.promise);
    const readRequest = otherClient("/api/v1/projects");
    await session.logout(async () => new Response(null, { status: 204 }));
    session.goToLogin("signed-out");
    const response = unauthorized();
    read.resolve(response);
    expect(await readRequest).toBe(response);
    expect(assign.mock.calls).toEqual([["/login?returnTo=%2Fstudio&reason=signed-out"]]);
  });

  it("finishes signed-out even if the console's expiry check cleared its local session during logout", async () => {
    const write = deferred<Response>();
    const logoutRequest = session.logout(() => write.promise);
    // AdminModels calls this after a passive session check has ended its local session/generation.
    session.goToLogin("expired");
    const duringLogout = [...assign.mock.calls];
    write.resolve(new Response(null, { status: 204 }));
    await logoutRequest;
    expect(duringLogout).toEqual([]);
    expect(assign.mock.calls).toEqual([["/login?returnTo=%2Fstudio&reason=signed-out"]]);
  });

  it.each(["rejected", "non-204"] as const)("restores ordinary expiry navigation after a %s logout", async (failure) => {
    const write = deferred<Response>();
    const logoutRequest = session.logout(() => write.promise);
    const failed = expect(logoutRequest).rejects.toThrow();
    if (failure === "rejected") write.reject(new Error("connection lost"));
    else write.resolve(new Response(null, { status: 403 }));
    await failed;
    await session.withSession(async () => unauthorized())("/api/v1/projects");
    expect(assign.mock.calls).toEqual([["/login?returnTo=%2Fstudio&reason=expired"]]);
  });

  it("honors an observed 401 if the pending logout later fails, without claiming signed-out", async () => {
    const write = deferred<Response>();
    const logoutRequest = session.logout(() => write.promise);
    const failed = expect(logoutRequest).rejects.toThrow();
    await session.withSession(async () => unauthorized())("/api/v1/projects");
    const duringLogout = [...assign.mock.calls];
    write.resolve(new Response(null, { status: 503 }));
    await failed;
    expect(duringLogout).toEqual([]);
    expect(assign.mock.calls).toEqual([["/login?returnTo=%2Fstudio&reason=expired"]]);
  });

  it("keeps ordinary session expiry unchanged when no logout was requested", async () => {
    await session.withSession(async () => unauthorized())("/api/v1/projects");
    expect(assign.mock.calls).toEqual([["/login?returnTo=%2Fstudio&reason=expired"]]);
  });

  it("shares logout across the header and drawer both in flight and after 204 before navigation commits", async () => {
    const write = deferred<Response>();
    const fetch = vi.fn(() => write.promise);
    const otherFetch = vi.fn(async () => new Response(null, { status: 403 }));
    const first = session.logout(fetch);
    const second = session.logout(otherFetch);
    const sameAttempt = first === second;
    // Observe either result before asserting, including on the old implementation with two requests.
    const settled = Promise.allSettled([first, second]);
    write.resolve(new Response(null, { status: 204 }));
    await settled;
    await session.logout(otherFetch);
    session.goToLogin("signed-out");
    await session.withSession(async () => unauthorized())("/api/v1/projects");
    expect(sameAttempt).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(otherFetch).not.toHaveBeenCalled();
    expect(assign.mock.calls).toEqual([["/login?returnTo=%2Fstudio&reason=signed-out"]]);
  });

  it("does not carry completed logout priority into a new document", async () => {
    await session.logout(async () => new Response(null, { status: 204 }));
    vi.resetModules();
    const nextDocument = await import("./site-session");
    await nextDocument.withSession(async () => unauthorized())("/api/v1/projects");
    expect(assign.mock.calls).toEqual([["/login?returnTo=%2Fstudio&reason=expired"]]);
  });
});
