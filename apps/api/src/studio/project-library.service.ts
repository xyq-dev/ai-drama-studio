import { PersistenceError, type ProjectLibraryQuery, type ProjectLibraryStore } from "@ai-drama/database";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const querySchema = z.object({
  q: z.string().max(200).optional(),
  category: z.string().max(36).optional(),
  sort: z.enum(["updated", "created"]).optional(),
  cursor: z.string().max(2048).optional(),
}).strict();
const categorySchema = z.object({ id: z.string().regex(UUID), name: z.string().trim().min(1).max(40) }).strict();
const assignmentSchema = z.object({ categoryId: z.string().regex(UUID).nullable(),
  expectedRevision: z.number().int().min(0).max(2147483646) }).strict();

/** Workspace scope comes only from server configuration, never from route/query/body input. */
export class ProjectLibraryService {
  constructor(private readonly store: Pick<ProjectLibraryStore, "list" | "createCategory" | "assignCategory">,
    private readonly workspaceId: string) {}

  list(query: unknown) {
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) throw new PersistenceError("VALIDATION_ERROR", "作品查询参数无效。");
    return this.store.list(this.workspaceId, parsed.data as ProjectLibraryQuery);
  }

  createCategory(body: unknown) {
    const parsed = categorySchema.safeParse(body);
    if (!parsed.success) throw new PersistenceError("VALIDATION_ERROR", "请输入有效的分类名称。");
    return this.store.createCategory(this.workspaceId, parsed.data);
  }

  assignCategory(projectId: string, body: unknown) {
    const parsed = assignmentSchema.safeParse(body);
    if (!UUID.test(projectId) || !parsed.success) throw new PersistenceError("VALIDATION_ERROR", "作品分类参数无效。");
    return this.store.assignCategory(this.workspaceId, projectId.toLowerCase(), parsed.data);
  }
}
