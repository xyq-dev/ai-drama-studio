import { describe, expect, it, vi } from "vitest";
import type { ProjectLibraryPage } from "@ai-drama/database";
import { ProjectLibraryService } from "./project-library.service";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const CATEGORY = "33333333-3333-4333-8333-333333333333";
function setup() {
  const store = {
    list: vi.fn(async (): Promise<ProjectLibraryPage> => ({ items: [], nextCursor: null, total: 0, allCount: 0,
      unclassifiedCount: 0, categories: [], categoriesReady: true })),
    createCategory: vi.fn(async () => ({ id: CATEGORY, name: "都市", count: 0 })),
    assignCategory: vi.fn(async () => ({ projectId: PROJECT, categoryId: CATEGORY, categoryName: "都市", categoryRevision: 1 })),
  };
  return { store, service: new ProjectLibraryService(store, WORKSPACE) };
}

describe("project library request boundary", () => {
  it("scopes reads and writes to the configured workspace", async () => {
    const { service, store } = setup();
    await service.list({ q: "都市", category: "uncategorized", sort: "created" });
    expect(store.list).toHaveBeenCalledWith(WORKSPACE, { q: "都市", category: "uncategorized", sort: "created" });
    await service.createCategory({ id: CATEGORY, name: " 都市 " });
    expect(store.createCategory).toHaveBeenCalledWith(WORKSPACE, { id: CATEGORY, name: "都市" });
    await service.assignCategory(PROJECT, { categoryId: null, expectedRevision: 2 });
    expect(store.assignCategory).toHaveBeenCalledWith(WORKSPACE, PROJECT, { categoryId: null, expectedRevision: 2 });
  });

  it.each([{ workspaceId: "browser" }, { q: ["one", "two"] }, { sort: "status" }, { cursor: "x".repeat(2049) },
    { limit: "2000" }, { q: "x".repeat(201) }])("rejects unsafe or unsupported queries %j", (query) => {
    const { service, store } = setup();
    expect(() => service.list(query)).toThrow();
    expect(store.list).not.toHaveBeenCalled();
  });

  it.each([{ id: CATEGORY, name: "" }, { id: CATEGORY, name: "x".repeat(41) }, { id: "invalid", name: "都市" },
    { id: CATEGORY, name: "都市", workspaceId: "browser" }])("rejects invalid creation bodies", (body) => {
    const { service, store } = setup();
    expect(() => service.createCategory(body)).toThrow();
    expect(store.createCategory).not.toHaveBeenCalled();
  });

  it.each([{ categoryId: CATEGORY }, { categoryId: CATEGORY, expectedRevision: "1" },
    { categoryId: CATEGORY, expectedRevision: -1 }, { categoryId: CATEGORY, expectedRevision: 1.1 },
    { categoryId: CATEGORY, expectedRevision: 0, workspaceId: "browser" }])("requires the caller's observed classification revision", (body) => {
    const { service, store } = setup();
    expect(() => service.assignCategory(PROJECT, body)).toThrow();
    expect(store.assignCategory).not.toHaveBeenCalled();
  });
});
