# Obsidian Blog Sync Integration Design

## Goal

让 Obsidian 插件通过博客自身的 `/api/obsidian/articles` 接口创建、读取、更新和删除博客 Post，并在修改后复用博客现有的发布处理工作流。

## Architecture

博客端新增独立的同步 feature：Bearer Token 鉴权、请求校验、`obsidian_post_links` 链接表和 Hono 路由。正文仍唯一存放在 `posts.contentJson`；链接表保存 Obsidian 路径、同步 revision 和内容 hash。条件更新在链接表 revision/hash 仍匹配时才写入 Post，随后触发 `POST_PROCESS_WORKFLOW`。

插件继续使用现有 TipTap JSON 协议、frontmatter 元数据和冲突处理；生产 API URL 配置为博客域名。API 返回博客域名生成的 Post URL 和可选的 Obsidian URI。

## Data flow

1. `POST` 校验标题、slug、TipTap JSON 和发布状态，创建 Post 与链接记录。
2. `GET` 按 Post ID 游标分页，返回草稿和已发布 Post。
3. `PUT` 检查 revision/hash；不匹配返回 409 当前 Post，不修改数据；匹配时更新 Post、链接记录并触发处理工作流。
4. `DELETE` 显式删除 Post，链接记录由外键级联删除。

## Security and consistency

接口只接受 `Authorization: Bearer <OBSIDIAN_SYNC_TOKEN>`。Token 存在 Cloudflare Secret，不进入仓库。接口响应使用 `Cache-Control: no-store`，避免同步数据被公共缓存。revision/hash 写入链接表而不是依赖 Post 的 `updatedAt`，保证网站后台编辑也能被检测为冲突。

## Verification

集成测试覆盖鉴权、创建、列表/读取、条件更新、409 冲突、强制更新、删除和工作流触发；随后运行博客端 typecheck/test 以及插件端 test/build/lint。
