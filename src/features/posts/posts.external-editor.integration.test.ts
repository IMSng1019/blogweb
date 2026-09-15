import { env } from "cloudflare:workers";
import {
  createMockAdminSession,
  createMockExecutionCtx,
  seedUser,
} from "tests/test-utils";
import { describe, expect, it } from "vitest";
import { getAuth } from "@/lib/auth/auth.server";
import { getDb } from "@/lib/db";
import { createApiContext } from "@/lib/orpc/create-context";
import { openAPIHandler } from "@/lib/orpc/openapi-handler";

/**
 * Replays the exact request sequence an external editor (the Obsidian plugin)
 * performs against a deployed blog, over the real router and Admin API Key
 * authentication, to prove both API additions work together.
 */
async function createAdminApiKey() {
  const db = getDb(env);
  const admin = createMockAdminSession().user;
  await seedUser(db, admin);
  const auth = getAuth({ db, env });
  const created = await auth.api.createApiKey({
    body: { name: "external-editor", userId: admin.id },
  });
  return created.key;
}

async function call(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers = new Headers({ "x-api-key": apiKey });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const request = new Request(`http://localhost:3000/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const { response } = await openAPIHandler.handle(request, {
    prefix: "/api",
    context: createApiContext(request.headers, env, createMockExecutionCtx()),
  });
  if (!response) throw new Error(`No route matched ${method} ${path}`);
  return response;
}

const document = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("External editor round trip", () => {
  it("creates, reads, updates, publishes, lists and deletes a note", async () => {
    const apiKey = await createAdminApiKey();

    // 1. Create as website article.
    const created = await call(apiKey, "POST", "/admin/posts", {
      data: { title: "Note from Obsidian", contentJson: document("First body") },
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: number };

    // 2. Read it back for the slug, status and canonical body.
    const read = await call(apiKey, "GET", `/admin/posts/${id}`);
    expect(read.status).toBe(200);
    const post = (await read.json()) as {
      id: number;
      title: string;
      slug: string;
      status: string;
      contentJson: unknown;
      updatedAt: string;
    };
    expect(post.slug).toBe("note-from-obsidian");
    expect(post.status).toBe("draft");
    expect(post.contentJson).toEqual(document("First body"));

    // 3. Upload a local edit. The plugin stores the hash of what it reads back.
    const updated = await call(apiKey, "PATCH", `/admin/posts/${id}`, {
      data: { title: "Note from Obsidian", contentJson: document("Edited body") },
    });
    expect(updated.status).toBe(200);
    const updatedPost = (await updated.json()) as { contentJson: unknown };

    // 4. Publish, then confirm the published state.
    const published = await call(apiKey, "POST", `/admin/posts/${id}/publish`);
    expect(published.status).toBe(200);
    const afterPublish = (await (
      await call(apiKey, "GET", `/admin/posts/${id}`)
    ).json()) as { status: string };
    expect(afterPublish.status).toBe("published");

    // 5. A full folder sync reads every body in one paged list.
    const list = await call(
      apiKey,
      "GET",
      "/admin/posts?includeContent=true&sortBy=id&sortDir=ASC&limit=50&offset=0",
    );
    expect(list.status).toBe(200);
    const page = (await list.json()) as {
      items: Array<{ id: number; contentJson: unknown }>;
      total: number;
    };
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe(id);

    // 6. The body the editor just wrote must be byte-identical to what a later
    //    read returns, otherwise the plugin would report a phantom remote edit.
    expect(page.items[0]?.contentJson).toEqual(updatedPost.contentJson);
    const reread = (await (
      await call(apiKey, "GET", `/admin/posts/${id}`)
    ).json()) as { contentJson: unknown };
    expect(reread.contentJson).toEqual(updatedPost.contentJson);

    // 7. Turning publishing off unpublishes the article.
    const unpublished = await call(
      apiKey,
      "POST",
      `/admin/posts/${id}/unpublish`,
    );
    expect(unpublished.status).toBe(200);

    // 8. Deleting removes it from the list.
    const removed = await call(apiKey, "DELETE", `/admin/posts/${id}`);
    expect(removed.status).toBe(200);
    const empty = (await (
      await call(apiKey, "GET", "/admin/posts?includeContent=true")
    ).json()) as { total: number };
    expect(empty.total).toBe(0);
  });
});
