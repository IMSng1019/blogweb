import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getAuth } from "@/lib/auth/auth.server";
import { PostsTable } from "@/lib/db/schema";
import { createTestContext } from "tests/test-utils";
import { openAPIHandler } from "@/lib/orpc/openapi-handler";
import { ArticlePayloadSchema } from "@/features/obsidian-sync/schema/obsidian-sync.schema";
import {
  findPostLink,
  updatePostWithLink,
} from "@/features/obsidian-sync/data/obsidian-sync.data";
import { contentHash } from "@/features/obsidian-sync/service/obsidian-sync.service";

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

function createHandlerContext() {
  const base = createTestContext();
  const customEnv = {
    ...env,
    OBSIDIAN_SYNC_TOKEN: token,
    DOMAIN: "example.com",
  } as Env;
  return {
    ...base,
    env: customEnv,
    auth: getAuth({ db: base.db, env: customEnv }),
  };
}

async function request(
  context: ReturnType<typeof createHandlerContext>,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const result = await openAPIHandler.handle(
    new Request(`http://localhost/api${path}`, { ...init, headers }),
    { prefix: "/api", context: { ...context, headers } },
  );
  if (!result.response) throw new Error(`Route was not matched: ${path}`);
  return result.response;
}

describe("Obsidian sync API", () => {
  it("accepts only slugs supported by the shared slugifier", () => {
    const valid = ArticlePayloadSchema.safeParse({
      title: "Test",
      slug: "测试-post",
      content,
    });
    const unsupported = ArticlePayloadSchema.safeParse({
      title: "Test",
      slug: "\u9fa6-post",
      content,
    });

    expect(valid.success).toBe(true);
    expect(unsupported.success).toBe(false);
  });

  it("rejects requests without the configured bearer token", async () => {
    const context = createHandlerContext();
    const response = await openAPIHandler.handle(
      new Request("http://localhost/api/obsidian/articles"),
      {
        prefix: "/api",
        context: { ...context, headers: new Headers() },
      },
    );

    expect(response.response?.status).toBe(401);
  });

  it("creates, reads, conditionally updates, and deletes a linked Post", async () => {
    const context = createHandlerContext();
    const createResponse = await request(context, "/obsidian/articles", {
      method: "POST",
      body: JSON.stringify({
        title: "Obsidian Post",
        content,
        path: "Notes/Obsidian Post.md",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as Record<string, unknown>;
    expect(created).toMatchObject({
      title: "Obsidian Post",
      published: false,
      revision: 1,
      url: "https://example.com/post/obsidian-post",
    });

    const id = created.id as number;
    const updateResponse = await request(context, `/obsidian/articles/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        title: "Obsidian Post Updated",
        content,
        revision: created.revision,
        contentHash: created.contentHash,
      }),
    });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      title: "Obsidian Post Updated",
      revision: 2,
    });

    const conflictResponse = await request(
      context,
      `/obsidian/articles/${id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          title: "Stale Update",
          content,
          revision: created.revision,
          contentHash: created.contentHash,
        }),
      },
    );
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({
      code: "REVISION_CONFLICT",
      data: { current: { revision: 2 } },
    });

    const deleteResponse = await request(context, `/obsidian/articles/${id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ success: true });
  });

  it("detects website-side edits as a revision conflict", async () => {
    const context = createHandlerContext();
    const createResponse = await request(context, "/obsidian/articles", {
      method: "POST",
      body: JSON.stringify({ title: "Conflict Post", content }),
    });
    const created = (await createResponse.json()) as Record<string, unknown>;
    const id = created.id as number;

    await context.db
      .update(PostsTable)
      .set({
        title: "Changed in website editor",
        contentJson: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Remote" }] },
          ],
        },
      })
      .where(eq(PostsTable.id, id));

    const response = await request(context, `/obsidian/articles/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        title: created.title,
        content,
        revision: created.revision,
        contentHash: created.contentHash,
      }),
    });
    expect(response.status).toBe(409);
  });

  it("publishes an article and reprocesses later updates", async () => {
    const context = createHandlerContext();
    const createResponse = await request(context, "/obsidian/articles", {
      method: "POST",
      body: JSON.stringify({
        title: "Published Obsidian Post",
        content,
        published: true,
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as Record<string, unknown>;
    expect(created.published).toBe(true);

    const id = created.id as number;
    const published = await context.db.query.PostsTable.findFirst({
      where: eq(PostsTable.id, id),
    });
    expect(published?.publicSlug).toBe("published-obsidian-post");

    const updateResponse = await request(context, `/obsidian/articles/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        title: "Published Obsidian Post Updated",
        content,
        revision: created.revision,
        contentHash: created.contentHash,
        published: true,
      }),
    });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      published: true,
      revision: 2,
      title: "Published Obsidian Post Updated",
    });
  });

  it("allows only one concurrent update for a revision", async () => {
    const context = createHandlerContext();
    const createResponse = await request(context, "/obsidian/articles", {
      method: "POST",
      body: JSON.stringify({ title: "Concurrent Post", content }),
    });
    const created = (await createResponse.json()) as Record<string, unknown>;
    const id = created.id as number;
    const update = (title: string) =>
      request(context, `/obsidian/articles/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          title,
          content,
          revision: created.revision,
          contentHash: created.contentHash,
        }),
      });

    const responses = await Promise.all([
      update("First concurrent update"),
      update("Second concurrent update"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);

    const stored = await context.db.query.PostsTable.findFirst({
      where: eq(PostsTable.id, id),
    });
    expect(["First concurrent update", "Second concurrent update"]).toContain(
      stored?.title,
    );
  });

  it("does not apply a stale update when only the slug differs", async () => {
    const context = createHandlerContext();
    const createResponse = await request(context, "/obsidian/articles", {
      method: "POST",
      body: JSON.stringify({ title: "Same Content", content }),
    });
    const created = (await createResponse.json()) as Record<string, unknown>;
    const id = created.id as number;
    const update = (slug: string) =>
      request(context, `/obsidian/articles/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: "Same Content",
          slug,
          content,
          revision: created.revision,
          contentHash: created.contentHash,
        }),
      });

    const responses = await Promise.all([
      update("slug-one"),
      update("slug-two"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);

    const stored = await context.db.query.PostsTable.findFirst({
      where: eq(PostsTable.id, id),
    });
    expect(["slug-one", "slug-two"]).toContain(stored?.slug);
    const conflict = responses.find((response) => response.status === 409);
    expect(conflict).toBeDefined();
    const conflictBody = (await conflict!.json()) as {
      data: { current: { slug: string } };
    };
    expect(conflictBody.data.current.slug).toBe(stored?.slug);
  });

  it("keeps the sync revision when the Post update fails", async () => {
    const context = createHandlerContext();
    const firstResponse = await request(context, "/obsidian/articles", {
      method: "POST",
      body: JSON.stringify({ title: "First Post", content }),
    });
    const first = (await firstResponse.json()) as Record<string, unknown>;
    await request(context, "/obsidian/articles", {
      method: "POST",
      body: JSON.stringify({
        title: "Taken Slug",
        slug: "taken-slug",
        content,
      }),
    });

    const link = await findPostLink(context.db, first.id as number);
    expect(link).toBeDefined();
    await expect(
      updatePostWithLink(
        context.db,
        first.id as number,
        {
          title: "First Post",
          slug: "taken-slug",
          contentJson: content,
        },
        {
          obsidianPath: link!.obsidianPath,
          revision: link!.revision + 1,
          contentHash: await contentHash("First Post", content),
          expectedRevision: link!.revision,
          expectedHash: link!.contentHash,
        },
      ),
    ).rejects.toThrow();

    const current = await request(context, `/obsidian/articles/${first.id}`, {
      method: "GET",
    });
    expect(await current.json()).toMatchObject({
      slug: "first-post",
      revision: 1,
    });
  });

  it("lists posts with a cursor", async () => {
    const context = createHandlerContext();
    const response = await request(context, "/obsidian/articles?limit=10", {
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: expect.any(Array),
    });
  });
});
