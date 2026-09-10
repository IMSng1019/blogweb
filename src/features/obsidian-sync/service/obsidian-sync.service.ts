import type { JSONContent } from "@tiptap/react";
import * as PostRepo from "@/features/posts/data/posts.data";
import * as PostService from "@/features/posts/services/posts.service";
import type {
  ArticlePayload,
  UpdateArticlePayload,
} from "@/features/obsidian-sync/schema/obsidian-sync.schema";
import {
  deletePostLink,
  findPostLink,
  listPosts,
  updatePostLink,
  upsertPostLink,
} from "@/features/obsidian-sync/data/obsidian-sync.data";
import { slugify } from "@/features/posts/utils/content";

export type SyncContext = DbContext & { executionCtx: ExecutionContext };

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export async function contentHash(title: string, content: unknown) {
  const payload = JSON.stringify(
    stableValue({ title: title.trim(), content }),
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function toISO(value: Date | null) {
  return value?.toISOString() ?? null;
}

export interface SyncArticle {
  id: number;
  title: string;
  slug: string;
  content: JSONContent;
  revision: number;
  contentHash: string;
  updatedAt: string;
  createdAt: string;
  published: boolean;
  url: string;
  obsidianUri?: string;
}

async function ensureLink(context: SyncContext, post: Awaited<ReturnType<typeof PostRepo.findPostById>>) {
  if (!post) return undefined;
  const existing = await findPostLink(context.db, post.id);
  const hash = await contentHash(post.title, post.contentJson ?? { type: "doc", content: [] });
  if (existing) {
    if (existing.contentHash !== hash) {
      const refreshed = await updatePostLink(context.db, post.id, {
        obsidianPath: existing.obsidianPath,
        revision: existing.revision + 1,
        contentHash: hash,
        expectedRevision: existing.revision,
        expectedHash: existing.contentHash,
      });
      return refreshed ?? (await findPostLink(context.db, post.id));
    }
    return existing;
  }
  return await upsertPostLink(context.db, {
    postId: post.id,
    obsidianPath: null,
    revision: 1,
    contentHash: hash,
  });
}

function serializeArticle(
  context: SyncContext,
  post: NonNullable<Awaited<ReturnType<typeof PostRepo.findPostById>>>,
  link: NonNullable<Awaited<ReturnType<typeof ensureLink>>>,
): SyncArticle {
  const content = post.contentJson ?? { type: "doc", content: [] };
  const article: SyncArticle = {
    id: post.id,
    title: post.title,
    slug: post.slug,
    content,
    revision: link.revision,
    contentHash: link.contentHash,
    updatedAt: toISO(post.updatedAt) ?? new Date(0).toISOString(),
    createdAt: toISO(post.createdAt) ?? new Date(0).toISOString(),
    published: post.status === "published",
    url: `https://${context.env.DOMAIN}/post/${encodeURIComponent(post.slug)}`,
  };
  if (link.obsidianPath) {
    article.obsidianUri = `obsidian://open?file=${encodeURIComponent(link.obsidianPath)}`;
  }
  return article;
}

async function processPost(context: SyncContext, postId: number, published: boolean) {
  await PostService.startPostProcessWorkflow(context, {
    id: postId,
    status: published ? "published" : "draft",
    clientToday: new Date().toISOString().slice(0, 10),
  });
}

export async function createArticle(context: SyncContext, input: ArticlePayload) {
  const { slug } = await PostService.generateSlug(context, {
    title: input.slug ?? input.title,
  });
  const empty = await PostService.createEmptyPost(context);
  const publishedAt = input.published ? new Date() : null;
  const updated = await PostService.updatePost(context, {
    id: empty.id,
    data: {
      title: input.title,
      slug: slugify(slug),
      contentJson: input.content,
      status: input.published ? "published" : "draft",
      publishedAt,
    },
  });
  if (updated.error || !updated.data) throw new Error("Post creation failed");
  const hash = await contentHash(input.title, input.content);
  const link = await upsertPostLink(context.db, {
    postId: updated.data.id,
    obsidianPath: input.path ?? null,
    revision: 1,
    contentHash: hash,
  });
  await processPost(context, updated.data.id, input.published ?? false);
  return serializeArticle(context, updated.data, link);
}

export async function getArticle(context: SyncContext, id: number) {
  const post = await PostRepo.findPostById(context.db, id);
  if (!post) return undefined;
  const link = await ensureLink(context, post);
  if (!link) return undefined;
  return serializeArticle(context, post, link);
}

export async function listArticles(context: SyncContext, cursor: number, limit: number) {
  const page = await listPosts(context.db, cursor, limit);
  const items: SyncArticle[] = [];
  for (const row of page.rows) {
    const post = await PostRepo.findPostById(context.db, row.id);
    if (!post) continue;
    const link = await ensureLink(context, post);
    if (link) items.push(serializeArticle(context, post, link));
  }
  return {
    items,
    nextCursor: page.hasMore ? (page.rows.at(-1)?.id ?? null) : null,
  };
}

export async function updateArticle(
  context: SyncContext,
  id: number,
  input: UpdateArticlePayload,
) {
  const post = await PostRepo.findPostById(context.db, id);
  if (!post) return { notFound: true as const };
  const link = await ensureLink(context, post);
  if (!link) return { notFound: true as const };
  if (!input.force && (link.revision !== input.revision || link.contentHash !== input.contentHash)) {
    return { conflict: serializeArticle(context, post, link) };
  }

  const nextHash = await contentHash(input.title, input.content);
  let nextSlug = post.slug;
  if (input.slug && input.slug !== post.slug) {
    nextSlug = (await PostService.generateSlug(context, {
      title: input.slug,
      excludeId: id,
    })).slug;
  }
  const updated = await PostService.updatePost(context, {
    id,
    data: {
      title: input.title,
      slug: nextSlug,
      contentJson: input.content,
      status: input.published ? "published" : "draft",
      publishedAt: input.published ? post.publishedAt ?? new Date() : null,
    },
  });
  if (updated.error || !updated.data) return { notFound: true as const };
  const nextLink = await updatePostLink(context.db, id, {
    obsidianPath: input.path ?? link.obsidianPath,
    revision: link.revision + 1,
    contentHash: nextHash,
    ...(input.force
      ? {}
      : { expectedRevision: link.revision, expectedHash: link.contentHash }),
  });
  if (!nextLink) {
    const current = await getArticle(context, id);
    return current ? { conflict: current } : { notFound: true as const };
  }
  await processPost(context, id, input.published ?? false);
  return { article: serializeArticle(context, updated.data, nextLink) };
}

export async function deleteArticle(context: SyncContext, id: number) {
  const post = await PostRepo.findPostById(context.db, id);
  if (!post) return false;
  await PostService.deletePost(context, { id });
  await deletePostLink(context.db, id);
  return true;
}
