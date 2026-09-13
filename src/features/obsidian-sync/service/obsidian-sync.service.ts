import type { JSONContent } from "@tiptap/react";
import { syncPostMedia } from "@/features/posts/data/post-media.data";
import * as PostRepo from "@/features/posts/data/posts.data";
import * as PostService from "@/features/posts/services/posts.service";
import type {
  ArticlePayload,
  SyncArticle,
  UpdateArticlePayload,
} from "@/features/obsidian-sync/schema/obsidian-sync.schema";
import {
  createPostWithLink,
  deletePostLink,
  findLinks,
  findPostLink,
  listPosts,
  type SyncLink,
  type SyncPostRow,
  updatePostLink,
  updatePostWithLink,
  upsertPostLink,
} from "@/features/obsidian-sync/data/obsidian-sync.data";
import { slugify } from "@/features/posts/utils/content";
import { normalizePostContent } from "@/features/posts/utils/normalize-content";
import { getPostPublisher } from "@/lib/do/post-publisher-binding";
import { unwrap } from "@/lib/errors";

export type SyncContext = DbContext & { executionCtx: ExecutionContext };

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export async function contentHash(title: string, content: unknown) {
  const payload = JSON.stringify(stableValue({ title: title.trim(), content }));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function documentContent(content: JSONContent | null | undefined): JSONContent {
  return content ?? { type: "doc", content: [] };
}

function toISO(value: Date | null | undefined) {
  return value?.toISOString() ?? new Date(0).toISOString();
}

function isUniqueConstraintError(error: unknown) {
  return /unique constraint|constraint failed|already exists/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function ensureLink(
  context: SyncContext,
  post: SyncPostRow,
  knownLink?: SyncLink,
) {
  const existing = knownLink ?? (await findPostLink(context.db, post.id));
  const hash = await contentHash(post.title, documentContent(post.contentJson));
  if (!existing) {
    return upsertPostLink(context.db, {
      postId: post.id,
      obsidianPath: null,
      revision: 1,
      contentHash: hash,
    });
  }

  if (existing.contentHash === hash) return existing;

  const refreshed = await updatePostLink(context.db, post.id, {
    obsidianPath: existing.obsidianPath,
    revision: existing.revision + 1,
    contentHash: hash,
    expectedRevision: existing.revision,
    expectedHash: existing.contentHash,
  });
  return refreshed ?? (await findPostLink(context.db, post.id));
}

function serializeArticle(
  context: SyncContext,
  post: SyncPostRow,
  link: NonNullable<SyncLink>,
): SyncArticle {
  const slug = post.publicSlug ?? post.slug;
  const article: SyncArticle = {
    id: post.id,
    title: post.title,
    slug: post.slug,
    content: documentContent(post.contentJson),
    revision: link.revision,
    contentHash: link.contentHash,
    updatedAt: toISO(post.updatedAt),
    createdAt: toISO(post.createdAt),
    published: post.status === "published",
    url: `https://${context.env.DOMAIN}/post/${encodeURIComponent(slug)}`,
  };
  if (link.obsidianPath) {
    article.obsidianUri = `obsidian://open?file=${encodeURIComponent(link.obsidianPath)}`;
  }
  return article;
}

async function readArticle(context: SyncContext, id: number) {
  const post = await PostRepo.findPostById(context.db, id);
  if (!post) return undefined;
  const link = await ensureLink(context, post);
  return link ? serializeArticle(context, post, link) : undefined;
}

async function setPublished(
  context: SyncContext,
  id: number,
  published: boolean,
) {
  const publisher = getPostPublisher(context.env, id);
  if (published) {
    unwrap(await publisher.publish(id));
    return;
  }

  const post = await PostRepo.findPostById(context.db, id);
  if (post?.status === "published" || post?.publicSnapshotJson) {
    unwrap(await publisher.unpublish(id));
  }
}

export async function createArticle(
  context: SyncContext,
  input: ArticlePayload,
) {
  const content = normalizePostContent(input.content) ?? input.content;
  const hash = await contentHash(input.title, content);
  let created: Awaited<ReturnType<typeof createPostWithLink>> | undefined;

  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    const { slug } = await PostService.generateSlug(context, {
      title: input.slug ?? input.title,
    });
    try {
      created = await createPostWithLink(
        context.db,
        {
          title: input.title,
          slug: slugify(slug),
          contentJson: content,
          status: "draft",
          publishedAt: input.published ? new Date() : null,
        },
        {
          obsidianPath: input.path ?? null,
          revision: 1,
          contentHash: hash,
        },
      );
    } catch (error) {
      if (!isUniqueConstraintError(error) || attempt === 2) throw error;
    }
  }

  if (!created) throw new Error("Post creation failed");
  try {
    await syncPostMedia(context.db, {
      ...created.post,
      publicSnapshotJson: null,
      coverMediaId: null,
    });
    if (input.published) await setPublished(context, created.post.id, true);

    const post = await PostRepo.findPostById(context.db, created.post.id);
    const link = await findPostLink(context.db, created.post.id);
    if (!post || !link) throw new Error("Post creation failed");
    return serializeArticle(context, post, link);
  } catch (error) {
    await deletePostLink(context.db, created.post.id);
    await PostRepo.deletePost(context.db, created.post.id);
    throw error;
  }
}

export async function getArticle(context: SyncContext, id: number) {
  return readArticle(context, id);
}

export async function listArticles(
  context: SyncContext,
  cursor: number,
  limit: number,
) {
  const page = await listPosts(context.db, cursor, limit);
  const links = await findLinks(
    context.db,
    page.rows.map((row) => row.id),
  );
  const linksByPostId = new Map(links.map((link) => [link.postId, link]));
  const items: SyncArticle[] = [];
  for (const row of page.rows) {
    const link = await ensureLink(context, row, linksByPostId.get(row.id));
    if (link) items.push(serializeArticle(context, row, link));
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
  const current = await PostRepo.findPostById(context.db, id);
  if (!current) return { notFound: true as const };
  const link = await ensureLink(context, current);
  if (!link) return { notFound: true as const };

  if (
    !input.force &&
    (link.revision !== input.revision || link.contentHash !== input.contentHash)
  ) {
    return { conflict: serializeArticle(context, current, link) };
  }

  const nextSlug = input.slug
    ? input.slug === current.slug
      ? current.slug
      : (
          await PostService.generateSlug(context, {
            title: input.slug,
            excludeId: id,
          })
        ).slug
    : current.slug;

  const content = normalizePostContent(input.content) ?? input.content;
  const updated = await updatePostWithLink(
    context.db,
    id,
    {
      title: input.title,
      slug: nextSlug,
      contentJson: content,
      publishedAt: input.published ? (current.publishedAt ?? new Date()) : null,
    },
    {
      obsidianPath: input.path ?? link.obsidianPath,
      revision: link.revision + 1,
      contentHash: await contentHash(input.title, content),
      ...(input.force
        ? {}
        : { expectedRevision: link.revision, expectedHash: link.contentHash }),
    },
  );
  if (!updated) {
    const article = await readArticle(context, id);
    return article ? { conflict: article } : { notFound: true as const };
  }

  await syncPostMedia(context.db, {
    ...updated.post,
    publicSnapshotJson: current.publicSnapshotJson,
    coverMediaId: current.coverMediaId,
  });

  if (input.published || current.status === "published") {
    await setPublished(context, id, input.published);
  }

  const article = await readArticle(context, id);
  return article ? { article } : { notFound: true as const };
}

export async function deleteArticle(context: SyncContext, id: number) {
  const post = await PostRepo.findPostById(context.db, id);
  if (!post) return false;
  unwrap(await PostService.deletePost(context, { id }));
  await deletePostLink(context.db, id);
  return true;
}
