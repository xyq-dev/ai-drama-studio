import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ApiEnv } from "../config/env";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SiteAuth, type SiteAuthState } from "../auth/site-auth";
import { EventsController } from "./studio.controller";
import { RUNTIME_STORE, STUDIO_SERVICE } from "./tokens";

/**
 * S2 regression: the event stream is bound to the session that opened it. Real AuthModule (middleware + login/logout),
 * real EventsController and a real HTTP stream; the event store and the clock are controllable stand-ins.
 * Ordering uses explicit barriers (read entered / read count reached), not guessed sleeps. The only fixed waits are
 * the short "nothing more happens" windows after a stream ended, which cannot be observed any other way.
 */
const PASSWORD = "test-only-site-password-Qm7#x";
const ORIGIN = "https://drama.example.test";
let HASH = "";

interface StoredEvent { eventId: string; eventType: string; occurredAt: string; traceId: string; data: unknown }

/** An event store whose reads can be counted, awaited and held open. */
class EventFeed {
  readonly events: StoredEvent[] = [];
  reads = 0;
  private hold: { entered: () => void; released: Promise<void> } | null = null;
  private waiters: Array<{ count: number; resolve: () => void }> = [];
  cursorError: Error | null = null;

  add(id: number) {
    this.events.push({ eventId: String(id), eventType: "test.event", occurredAt: "2026-10-10T00:00:00Z", traceId: "t", data: { id } });
  }

  /** The next read pauses after it starts; returns (entered, release). */
  holdNextRead(): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    this.hold = { entered, released: new Promise<void>((resolve) => { release = resolve; }) };
    return { entered: enteredPromise, release };
  }

  readsAtLeast(count: number): Promise<void> {
    if (this.reads >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  async assertCursor(): Promise<void> {
    if (this.cursorError) throw this.cursorError;
  }

  async listEventsAfter(_workspace: string, after: string): Promise<StoredEvent[]> {
    this.reads += 1;
    this.waiters = this.waiters.filter((waiter) => (this.reads >= waiter.count ? (waiter.resolve(), false) : true));
    const hold = this.hold;
    if (hold) {
      this.hold = null;
      hold.entered();
      await hold.released;
    }
    return this.events.filter((event) => BigInt(event.eventId) > BigInt(after));
  }
}

/** Reads a server-sent event stream in the background. */
function stream(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let ended = false;
  const listeners: Array<() => void> = [];
  const notify = () => { for (const listener of listeners.splice(0)) listener(); };
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
        notify();
      }
    } catch { /* aborted */ }
    ended = true;
    notify();
  })();
  const until = (predicate: () => boolean) => new Promise<void>((resolve) => {
    const check = () => (predicate() ? resolve() : listeners.push(check));
    check();
  });
  return {
    get text() { return text; },
    get ended() { return ended; },
    seen: (id: number) => until(() => text.includes(`id: ${String(id)}\n`)),
    end: () => done,
    cancel: () => reader.cancel(),
  };
}

const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  HASH = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
});

describe("event stream bound to the site session", () => {
  let app: INestApplication | undefined;
  let base = "";
  let now = Date.parse("2026-10-10T00:00:00Z");
  let feed: EventFeed;
  const open: Array<{ cancel: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const item of open.splice(0)) await item.cancel().catch(() => undefined);
    await app?.close();
    app = undefined;
    now = Date.parse("2026-10-10T00:00:00Z");
  });

  async function start(kind: "enabled" | "disabled" = "enabled") {
    feed = new EventFeed();
    const state: SiteAuthState = kind === "enabled"
      ? { kind, auth: new SiteAuth({ username: "admin", passwordHash: HASH, publicOrigin: ORIGIN }, { now: () => now }) }
      : { kind };
    const module = await Test.createTestingModule({
      imports: [AuthModule.register({ NODE_ENV: "test" } as ApiEnv, state)],
      controllers: [EventsController],
      providers: [
        { provide: STUDIO_SERVICE, useValue: { workspace: "11111111-1111-4111-8111-111111111111" } },
        { provide: RUNTIME_STORE, useValue: feed },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1`;
  }

  async function signIn() {
    const response = await fetch(`${base}/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: PASSWORD }) });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; ");
    const csrf = (await response.json() as { csrfToken: string }).csrfToken;
    return { cookie, csrf };
  }

  async function subscribe(headers: Record<string, string> = {}) {
    const response = await fetch(`${base}/events`, { headers });
    expect(response.status).toBe(200);
    const events = stream(response);
    open.push(events);
    return events;
  }

  const logout = async (cookie: string, csrf: string) => {
    const response = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf } });
    expect(response.status).toBe(204);
  };

  it("delivers events to a valid session as before", async () => {
    await start();
    const { cookie } = await signIn();
    feed.add(1);
    const events = await subscribe({ cookie });
    await events.seen(1);
    feed.add(2);
    await events.seen(2);
    expect(events.ended).toBe(false);
  });

  it("refuses to open the stream without a session", async () => {
    await start();
    expect((await fetch(`${base}/events`)).status).toBe(401);
    expect(feed.reads).toBe(0);
  });

  it("ends an open stream when its session logs out; events after that are never sent", async () => {
    await start();
    const { cookie, csrf } = await signIn();
    feed.add(1);
    const events = await subscribe({ cookie });
    await events.seen(1);
    await logout(cookie, csrf);
    feed.add(2);
    await events.end();
    expect(events.text).not.toContain("id: 2\n");
    const readsAtEnd = feed.reads;
    await quiet(800);
    expect(feed.reads).toBe(readsAtEnd);
  });

  it("does not send what a read returns when the logout happened while that read was in flight", async () => {
    await start();
    const { cookie, csrf } = await signIn();
    feed.add(1);
    const events = await subscribe({ cookie });
    await events.seen(1);
    const held = feed.holdNextRead();
    await held.entered;
    await logout(cookie, csrf);
    feed.add(2);
    held.release();
    await events.end();
    expect(events.text).not.toContain("id: 2\n");
  });

  it("ends at the idle limit, and its own pushes do not count as activity", async () => {
    await start();
    const { cookie } = await signIn();
    const events = await subscribe({ cookie });
    now += SESSION_IDLE_MS - 1;
    // Several timer-driven reads happen just before the idle limit; none of them may extend the session.
    await feed.readsAtLeast(feed.reads + 3);
    expect(events.ended).toBe(false);
    now += 1;
    await events.end();
    feed.add(1);
    await quiet(600);
    expect(events.text).not.toContain("id: 1\n");
  });

  it("ends at the absolute limit even while the person keeps using the site", async () => {
    await start();
    const { cookie } = await signIn();
    const events = await subscribe({ cookie });
    for (let elapsed = 0; elapsed < SESSION_ABSOLUTE_MS - SESSION_IDLE_MS / 2; elapsed += SESSION_IDLE_MS / 2) {
      now += SESSION_IDLE_MS / 2;
      expect((await fetch(`${base}/auth/session`, { headers: { cookie } })).status).toBe(200);
      await feed.readsAtLeast(feed.reads + 1);
      expect(events.ended).toBe(false);
    }
    now += SESSION_IDLE_MS / 2;
    await events.end();
  });

  it("stops reading and scheduling once the client disconnects", async () => {
    await start();
    const { cookie } = await signIn();
    const events = await subscribe({ cookie });
    await feed.readsAtLeast(2);
    await events.cancel();
    await quiet(300);
    const readsAfterClose = feed.reads;
    await quiet(800);
    expect(feed.reads).toBe(readsAfterClose);
  });

  it("keeps the earlier stream behaviour, Last-Event-ID and cursor checks when the login is off", async () => {
    await start("disabled");
    feed.add(1);
    feed.add(2);
    const events = await subscribe({ "last-event-id": "1" });
    await events.seen(2);
    expect(events.text).not.toContain("id: 1\n");
    feed.cursorError = new PersistenceError("EVENT_CURSOR_EXPIRED", "expired");
    const expired = await fetch(`${base}/events`, { headers: { "last-event-id": "1" } });
    expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({ error: { code: "EVENT_CURSOR_EXPIRED" } });
  });
});
