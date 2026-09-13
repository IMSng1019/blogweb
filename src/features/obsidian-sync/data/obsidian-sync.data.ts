import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { ObsidianPostLinksTable, PostsTable } from "@/lib/db/schema";

export type SyncPostRow = Pick<
  typeof PostsTable.$inferSelect,
  | "id"
  | "title"
  | "slug"
  | "publicSlug"
  | "contentJson"
  | "publicSnapshotJson"
  | "status"
  | "createdAt"
  | "updatedAt"
>;

export async function findPostLink(db: DB, postId: number) {
  return db.query.ObsidianPostLinksTable.findFirst({
    where: eq(ObsidianPostLinksTable.postId, postId),
  });
}

export type SyncLink = Awaited<ReturnType<typeof findPostLink>>;

export async function upsertPostLink(
  db: DB,
  data: typeof ObsidianPostLinksTable.$inferInsert,
) {
  const [link] = await db
    .insert(ObsidianPostLinksTable)
    .values(data)
    .onConflictDoUpdate({
      target: ObsidianPostLinksTable.postId,
      set: {
        obsidianPath: data.obsidianPath,
        revision: data.revision,
        contentHash: data.contentHash,
        updatedAt: new Date(),
      },
    })
    .returning();
  return link;
}

export async function updatePostLink(
  db: DB,
  postId: number,
  data: {
    obsidianPath?: string | null;
    revision: number;
    contentHash: string;
    expectedRevision?: number;
    expectedHash?: string;
  },
) {
  const [link] = await db
    .update(ObsidianPostLinksTable)
    .set({
      obsidianPath: data.obsidianPath,
      revision: data.revision,
      contentHash: data.contentHash,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ObsidianPostLinksTable.postId, postId),
        data.expectedRevision === undefined
          ? undefined
          : eq(ObsidianPostLinksTable.revision, data.expectedRevision),
        data.expectedHash === undefined
          ? undefined
          : eq(ObsidianPostLinksTable.contentHash, data.expectedHash),
      ),
    )
    .returning();
  return link;
}

export async function deletePostLink(db: DB, postId: number) {
  await db
    .delete(ObsidianPostLinksTable)
    .where(eq(ObsidianPostLinksTable.postId, postId));
}

export async function createPostWithLink(
  db: DB,
  post: typeof PostsTable.$inferInsert,
  link: Omit<typeof ObsidianPostLinksTable.$inferInsert, "postId">,
) {
  const [createdPost] = await db.insert(PostsTable).values(post).returning();
  if (!createdPost) throw new Error("Post creation failed");

  try {
    const [createdLink] = await db
      .insert(ObsidianPostLinksTable)
      .values({ ...link, postId: createdPost.id })
      .returning();
    if (!createdLink) throw new Error("Obsidian link creation failed");
    return { post: createdPost, link: createdLink };
  } catch (error) {
    await db.delete(PostsTable).where(eq(PostsTable.id, createdPost.id));
    throw error;
  }
}

export async function updatePostWithLink(
  db: DB,
  postId: number,
  post: Partial<Omit<typeof PostsTable.$inferInsert, "id" | "createdAt">>,
  link: {
    obsidianPath: string | null;
    revision: number;
    contentHash: string;
    expectedRevision?: number;
    expectedHash?: string;
  },
) {
  const syncToken = crypto.randomUUID();
  const linkMatch = and(
    eq(ObsidianPostLinksTable.postId, postId),
    link.expectedRevision === undefined
      ? undefined
      : eq(ObsidianPostLinksTable.revision, link.expectedRevision),
    link.expectedHash === undefined
      ? undefined
      : eq(ObsidianPostLinksTable.contentHash, link.expectedHash),
  );
  const postMatch = and(
    eq(PostsTable.id, postId),
    sql`EXISTS (
      SELECT 1 FROM obsidian_post_links
      WHERE post_id = ${postId}
        AND revision = ${link.revision}
        AND content_hash = ${link.contentHash}
        AND sync_token = ${syncToken}
    )`,
  );
  const [linkRows, postRows, clearedLinkRows] = await db.batch([
    db
      .update(ObsidianPostLinksTable)
      .set({
        obsidianPath: link.obsidianPath,
        revision: link.revision,
        contentHash: link.contentHash,
        syncToken,
        updatedAt: new Date(),
      })
      .where(linkMatch)
      .returning(),
    db.update(PostsTable).set(post).where(postMatch).returning(),
    db
      .update(ObsidianPostLinksTable)
      .set({ syncToken: null })
      .where(
        and(
          eq(ObsidianPostLinksTable.postId, postId),
          eq(ObsidianPostLinksTable.syncToken, syncToken),
        ),
      )
      .returning(),
  ] as const);
  const updatedLink = clearedLinkRows[0] ?? linkRows[0];
  const updatedPost = postRows[0];
  if (!updatedLink || !updatedPost) return null;
  return { post: updatedPost, link: updatedLink };
}

export async function listPosts(db: DB, cursor: number, limit: number) {
  const rows = await db
    .select({
      id: PostsTable.id,
      title: PostsTable.title,
      slug: PostsTable.slug,
      publicSlug: PostsTable.publicSlug,
      contentJson: PostsTable.contentJson,
      publicSnapshotJson: PostsTable.publicSnapshotJson,
      status: PostsTable.status,
      createdAt: PostsTable.createdAt,
      updatedAt: PostsTable.updatedAt,
    })
    .from(PostsTable)
    .where(gt(PostsTable.id, cursor))
    .orderBy(asc(PostsTable.id))
    .limit(limit + 1);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function findLinks(db: DB, postIds: number[]) {
  if (postIds.length === 0) return [];
  return db
    .select()
    .from(ObsidianPostLinksTable)
    .where(inArray(ObsidianPostLinksTable.postId, postIds));
}
