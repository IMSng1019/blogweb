# Obsidian Blog Sync Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a production Obsidian synchronization API to the blog Worker backed by existing Posts and post processing workflows.

**Architecture:** Add an `obsidian_post_links` Drizzle table and a focused sync feature with token authentication, validation, repository operations, and Hono routes. Keep TipTap JSON in `posts.contentJson`, use link-table revision/hash for optimistic concurrency, and enqueue `POST_PROCESS_WORKFLOW` after content/status changes.

**Tech Stack:** TypeScript, Hono, Drizzle D1, Zod, Cloudflare Workflows, Vitest.

---

### Task 1: Add failing sync contract tests

**Files:**
- Create: `src/features/obsidian-sync/obsidian-sync.integration.test.ts`

**Steps:**
1. Test missing/invalid bearer tokens, create, list, get, conditional update, stale conflict, force update, and explicit delete.
2. Test that create/update schedule the existing post process workflow and that responses use the configured domain.
3. Run `bun vitest run src/features/obsidian-sync/obsidian-sync.integration.test.ts`; confirm route/module failures.

### Task 2: Add link-table schema and migration

**Files:**
- Create: `src/lib/db/schema/obsidian-post-links.table.ts`
- Modify: `src/lib/db/schema/index.ts`
- Create: `migrations/0011_*.sql`
- Update: `migrations/meta/_journal.json` and generated snapshot through Drizzle

**Steps:**
1. Define Post foreign key, path, revision, hash, and timestamps.
2. Add migration and verify fresh/local D1 migration state.

### Task 3: Implement sync service and route

**Files:**
- Create: `src/features/obsidian-sync/schema/obsidian-sync.schema.ts`
- Create: `src/features/obsidian-sync/data/obsidian-sync.data.ts`
- Create: `src/features/obsidian-sync/service/obsidian-sync.service.ts`
- Create: `src/features/obsidian-sync/api/hono/obsidian-sync.route.ts`
- Modify: `src/lib/hono/routes.ts`, `src/lib/env/server.env.ts`, `global.d.ts`, `wrangler.example.jsonc`

**Steps:**
1. Add request schemas and stable SHA-256 hashing of title plus TipTap content.
2. Implement authenticated create/list/get/update/delete operations using PostRepo/PostService and link rows.
3. Trigger `POST_PROCESS_WORKFLOW` for create/update status changes; return structured errors and no-store headers.
4. Mount the route before public cache/shield handling.

### Task 4: Verify and update plugin contract

**Files:**
- Modify: `J:/Project/brige-obsidian-with-flarestackblog/brige-obsidian-with-flarestackblog/docs/api/blogweb-adapter.md`
- Modify: `J:/Project/brige-obsidian-with-flarestackblog/brige-obsidian-with-flarestackblog/docs/使用教程.md`

**Steps:**
1. Document the production endpoint and `OBSIDIAN_SYNC_TOKEN` secret.
2. Run blog `bun typecheck`, focused integration tests, and full test suite.
3. Run plugin `npm test`, `npm run build`, and `npm run lint`.
