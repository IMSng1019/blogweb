import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { testRequest } from "tests/test-utils";
import { describe, expect, it } from "vitest";
import { app } from "@/lib/hono/routes";
import { getDb } from "@/lib/db";
import { PostsTable } from "@/lib/db/schema";

const token = "obsidian-sync-test-token";
const content = {
  type: "doc" as const,
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Hello from Obsidian" }],
    },
  ],
};

function authHeaders() {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("Obsidian sync API", () => {
  it("rejects requests without the configured bearer token", async () => {
    const response = await testRequest(app, "/api/obsidian/articles", {
      method: "GET",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("creates, reads, conditionally updates, and deletes a linked Post", async () => {
    const customEnv = { ...env, OBSIDIAN_SYNC_TOKEN: token, DOMAIN: "example.com" };
    const createResponse = await testRequest(
      app,
      "/api/obsidian/articles",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          title: "Obsidian Post",
          content,
          path: "Notes/Obsidian Post.md",
          published: false,
        }),
      },
      customEnv,
    );

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as Record<string, unknown>;
    expect(created).toMatchObject({
      title: "Obsidian Post",
      published: false,
      revision: 1,
      url: "https://example.com/post/obsidian-post",
    });
    expect(typeof created.id).toBe("number");
    expect(typeof created.contentHash).toBe("string");

    const id = created.id as number;
    const updateResponse = await testRequest(
      app,
      `/api/obsidian/articles/${id}`,
      {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          title: "Obsidian Post Updated",
          content,
          revision: created.revision,
          contentHash: created.contentHash,
          path: "Notes/Obsidian Post.md",
          published: false,
        }),
      },
      customEnv,
    );
    expect(updateResponse.status).toBe(200);
    const updated = (await updateResponse.json()) as Record<string, unknown>;
    expect(updated).toMatchObject({ title: "Obsidian Post Updated", revision: 2 });

    const conflictResponse = await testRequest(
      app,
      `/api/obsidian/articles/${id}`,
      {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          title: "Stale Update",
          content,
          revision: created.revision,
          contentHash: created.contentHash,
        }),
      },
      customEnv,
    );
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({
      error: { code: "REVISION_CONFLICT", current: { revision: 2 } },
    });

    const deleteResponse = await testRequest(
      app,
      `/api/obsidian/articles/${id}`,
      { method: "DELETE", headers: authHeaders() },
      customEnv,
    );
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ success: true });
  });

  it("lists drafts and published Posts with a cursor", async () => {
    const customEnv = { ...env, OBSIDIAN_SYNC_TOKEN: token, DOMAIN: "example.com" };
    const response = await testRequest(
      app,
      "/api/obsidian/articles?limit=10",
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      customEnv,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.items).toEqual(expect.any(Array));
    expect(payload).toHaveProperty("nextCursor");
  });

  it("turns a website-side edit into a revision conflict for the plugin", async () => {
    const customEnv = { ...env, OBSIDIAN_SYNC_TOKEN: token, DOMAIN: "example.com" };
    const createResponse = await testRequest(
      app,
      "/api/obsidian/articles",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ title: "Conflict Post", content }),
      },
      customEnv,
    );
    const created = (await createResponse.json()) as Record<string, unknown>;
    const id = created.id as number;

    const db = getDb(customEnv);
    await db
      .update(PostsTable)
      .set({
        title: "Changed in website editor",
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Remote" }] }],
        },
      })
      .where(eq(PostsTable.id, id));

    const response = await testRequest(
      app,
      `/api/obsidian/articles/${id}`,
      {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          title: created.title,
          content,
          revision: created.revision,
          contentHash: created.contentHash,
        }),
      },
      customEnv,
    );
    expect(response.status).toBe(409);
  });
});
