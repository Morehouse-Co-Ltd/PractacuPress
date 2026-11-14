# 2026-11-14 本地安全审计报告

- **审计对象**：本机自托管实例（用户明确授权的本地安全体检）
  - API：`http://127.0.0.1:8080`（Go 1.26 模块，实际构建工具链已升至 go1.27.4）
  - 前端开发服务器：`http://127.0.0.1:5173`（Vite，仅本机监听）
  - 安全服务：`127.0.0.1:9001`（Rust gRPC，仅本机监听）
- **代码基线**：`feat/page-builder-v2-p0` 分支，审计开始前本地基线提交 `ef98de2`
- **审计时间**：2026-11-13 23:50 – 2026-11-14 00:40（Asia/Shanghai）
- **方式**：白盒代码审阅 + 本机低强度实测（仅 `127.0.0.1`；未做外部扫描、未做压力测试、未修改既有业务数据）
- **测试账号**：全部为审计期间创建的 `qa-sec-*` 临时账号，审计结束后已删除（用户表回到 8 个真实账户）

## 1. 结论摘要

| 级别 | 数量 | 状态 |
| --- | --- | --- |
| Critical | 0 | — |
| High | 0 | — |
| Medium | 2 | 1 已修复（Host 头邮件链接投毒）；1 记录并给出缓解建议（账号锁定可被用于拒绝服务） |
| Low | 14 | 4 已修复（依赖/首管理员/链接白名单）、其余记录或接受 |
| Info | 9 | 记录（设计取舍或纵深防御建议） |

**没有发现可直接利用的远程代码执行、SQL 注入、认证绕过、越权读取他人数据、存储型/反射型 XSS。**
认证、会话、CSRF、授权（含跨站点）、路径/上传、SSRF、WASM 沙箱的整体实现质量较高；
主要风险集中在**部署配置面**（Host 头 / PUBLIC_BASE_URL）、**高价值操作的二次验证覆盖**、
以及**第三方依赖**。依赖问题已全部升级清零：

- Go 标准库 `GO-2026-6859`（`net/http` MaxBytesReader 头竞争可致服务崩溃）→ 工具链升至 **go1.27.4**
- `golang.org/x/image` WebP/VP8L 解码崩溃（`GO-2026-4961`、`GO-2026-6222` 等）→ 升至 **v0.45.0**
- 前端 `katex@0.16.22`（GHSA-238p-pmpm-9mq7）→ 升至 **0.19.1**
- 最终 `govulncheck ./...` → **No vulnerabilities found**；`npm audit --omit=dev` → **0 vulnerabilities**

## 2. 发现总览

| ID | 级别 | 标题 | 状态 |
| --- | --- | --- | --- |
| SEC-01 | Medium | Host 头参与密码重置/邮箱验证链接 → token 投毒（需 SMTP 且未设 PUBLIC_BASE_URL） | ✅ 已修复（配置强制 + 测试） |
| SEC-02 | Medium | 登录失败锁定可被用于账号拒绝服务（5 次错误后正确密码也 429） | 📋 记录，建议改渐进延迟/CAPTCHA |
| SEC-03 | Low | 桌面模式首个管理员判定只看 Host 头 | ✅ 已修复（同时校验对端回环） |
| SEC-04 | Low | 注销/改密后 access token 仍有效至 15 分钟 | 📋 记录（JWT 无状态设计，TTL 900s） |
| SEC-05 | Low | step-up 令牌 300s 内可重复使用（无 jti/一次性消费） | 📋 记录 |
| SEC-06 | Low | 平台→站点 handoff token 120s 内可重复兑换 | 📋 记录 |
| SEC-07 | Low | 注册接口 409 `identity_exists` 可枚举已注册邮箱 | 📋 记录（UX 取舍） |
| SEC-08 | Low | 登录锁定状态为进程内内存表（多副本可绕过/重启清零） | 📋 记录 |
| SEC-09 | Low | 验证码"已启用但服务端缺密钥"时 fail-open | 📋 记录，建议 fail-closed |
| SEC-10 | Low | step-up 保护面偏窄：扩展导入、站点配置/设计、备份等未受二次验证 | 📋 记录（实测扩展导入无需 step-up） |
| SEC-11 | Low | 整库备份创建/下载无 step-up，响应为全库快照 | 📋 记录 |
| SEC-12 | Low | 编排链接白名单不一致：作者卡 `javascript:`、公告条 `//host` | ✅ 已修复（safeUrl + 拒绝协议相对） |
| SEC-13 | Low | WebsiteBlock 同源 iframe 同时允许 `allow-scripts allow-same-origin` | 📋 纵深防御建议 |
| SEC-14 | Low | `custom_extensions`/`covers` 被服务端内容扫描跳过，依赖 iframe 沙箱 | 📋 已确认沙箱正确，建议回归测试 |
| SEC-15 | Low | Vite 开发服务器无安全响应头、`/@fs/` 暴露工作区源码 | 📋 仅 dev，禁止对外暴露 |
| SEC-16 | Info | 请求体超限返回 400 而非 413；`IsBodyTooLarge` 未接线 | 📋 记录 |
| SEC-17 | Info | 匿名可读面：`/api/v1/docs`、`/api/v1/openapi.json`、`setup/status`、`site-config`（含 admin_path） | 📋 按设计接受，生产可收敛 |
| SEC-18 | Info | 安全头加固：无 COOP/COEP/CORP、无 `object-src 'none'`、HTTP 无 HSTS | 📋 建议 |
| SEC-19 | Info | Cookie 加固：开发无 Secure、未用 `__Host-` 前缀、支持 Domain | 📋 建议 |
| SEC-20 | Info | 密码策略最小 12 位 + 2 类 + 内嵌弱口令黑名单（`too_common`） | ✅ 已修复（2026-11-14） |
| SEC-21 | Info | 扩展同 id 静默替换、替换后保持启用 | 📋 建议记录哈希 + 显式确认 |
| SEC-22 | Info | WASM 沙箱能力面（无 FS/网络/env import，超时/内存受限） | ✅ 已验证安全 |
| SEC-23 | Info | 管理后台 `window.open` 未显式 noopener；PreviewBridge 选择器拼接 | 📋 记录（风险极低） |

## 3. 重点发现与处置

### SEC-01（Medium，已修复）Host 头污染邮件链接 → 一次性 token 可被投毒

- **位置**：`apps/api/internal/auth/handler.go`（`requestOrigin` 仅信任 `c.Request.Host`）、`password_reset.go`、`email_verification.go`、`transport/http/gin/sitefiles.go`。
- **实测**：
  - `GET /sitemap.xml` 带 `Host: evil.qa-sec.example` → 200，且返回 `<loc>http://evil.qa-sec.example/</loc>`；
  - 单站点 + 无域名时任意 Host 解析到本站（`site/service.go`）；伪造 Host+Origin 可到达密码重置 handler（本实例未配置 SMTP，返回 503）。
- **影响**：若部署启用 SMTP 且未配置 `PUBLIC_BASE_URL`，攻击者触发受害者重置请求即可让邮件里的合法 token 指向攻击者域名 → 账号接管。
- **修复**：非桌面部署启用 SMTP 时**强制要求 `PUBLIC_BASE_URL`**（`platform/config`），否则启动失败并给出明确错误；桌面模式为回环单机，保留请求来源回退。新增 3 条配置单测覆盖。
- **验证**：`go test ./apps/api/internal/platform/config/`。

### SEC-02（Medium，记录）账号锁定可被用于拒绝服务

- **现象**：对已知邮箱连续 5 次错误密码后，账号进入退避；**正确密码也返回 429**（实测：5×401 → 正确密码 429，`Retry-After` 生效）。
- **影响**：知道管理员/成员邮箱的人可以低成本让该账号一段时间无法登录（仅影响密码登录，其他会话不受影响）。
- **建议**：将硬锁定改为“渐进延迟 + 失败后 CAPTCHA/邮件提醒”，或按 IP+账号联合计数并对来自已知良好 IP 的请求降低惩罚；给账号所有者发送锁定通知。

### SEC-03（Low，已修复）桌面模式首管理员判定可被 Host 头伪造

- **位置**：`auth/first_admin.go`。原先只检查 `Request.Host` 是否回环。
- **修复**：同时要求**直连对端地址**（`RemoteAddr`）与 Host 均为回环；新增 `first_admin_test.go` 覆盖伪造 Host + 远程对端、LAN Host + 回环代理等组合。
- **残余**：同机反向代理会把所有远端用户伪装成回环对端；桌面安装不应把 API 暴露给此类代理（启动器默认仅监听回环）。

### SEC-10（Low，记录）step-up 覆盖缺口（实测）

- 站点当前已开启高威胁操作保护；受保护路由（成员创建/修改/删除、2FA 重置、站点导入、敏感词/IP 规则删除）在无 `X-PP-Step-Up` 时正确返回 403。
- **但** `POST /api/v1/extensions/import`（安装可执行代码）实测**无 step-up 也返回 201**；站点配置/设计、域名写入、平台备份创建/下载同样不在冻结表内。
- **建议**：把扩展导入/替换、站点配置与设计写入、平台备份创建/下载加入 `stepUpProtectedRoutes`，并在前端导入流程先调用 `ensureStepUp()`；扩展替换记录旧/新包哈希。

### SEC-05 / SEC-06（Low，记录）step-up 与 handoff 令牌可短时重放

- step-up grant 绑定 user+site、有效期 300s，但 payload 无 `jti`，同一令牌可用于多个高威胁操作；
- 平台进入站点的 handoff token 120s 内可多次兑换。
- **建议**：为一次性语义的令牌加 `jti` + 使用记录（或改成一次性 code/服务端 session）。

### SEC-12（Low，已修复）两处链接白名单不一致

- `Nightflight.tsx` 作者卡 `href={item.link}` 未过 `safeUrl()`；`SiteChrome.tsx` 公告条接受 `//host` 协议相对地址。
- **修复**：作者卡链接统一 `safeUrl()`（只允许 http(s)/站内单斜杠路径，空链接不渲染）；公告条拒绝 `//` 开头。两者与仓库其它区块的 URL 策略一致。

### 其余记录项

- **SEC-04**：access token 无吊销列表，注销只吊销 refresh；15 分钟窗口内旧 token 仍可用（实测 `logout 204` 后 `/me` 仍 200）。属 JWT 设计取舍；如需要可加 `jti` 黑名单或把 TTL 降到 5 分钟。
- **SEC-07**：重复注册返回 409「该邮箱已被注册」，而新邮箱 201；可用于枚举注册邮箱（登录/重置接口本身是统一的）。若介意，可改为统一 202/400 并只给邮件提示。
- **SEC-08**：登录锁定存于进程内存，多副本部署各算各的；单机桌面实例不受影响。
- **SEC-09**：站点开启验证码但服务端缺 `CAPTCHA_*_SECRET` 时仅告警并放行；建议设置页阻止保存或 fail-closed。
- **SEC-13/14**：`WebsiteBlock` 同源 iframe 不应同时给 `allow-scripts allow-same-origin`；创作者扩展当前沙箱（`allow-scripts`，无 same-origin、来源/权限校验正确）已验证安全，建议为 sandbox 属性补不可回退的回归测试。
- **SEC-15**：Vite dev 无 CSP/XFO/nosniff 且可读工作区源码（`/@fs/`）——仅本机开发实例，**禁止把 5173 暴露到局域网/公网**；生产 launcher 构建有完整安全头且无 sourcemap。
- **SEC-16**：请求体超限被拒但返回 400，`IsBodyTooLarge` 未接线；建议统一 413。
- **SEC-17**：`setup/status` 暴露 site_id/site_name/registration_open，公开 `site-config` 暴露 `admin_path`（匿名可用）；属前后台水合所需，但会降低后台入口隐藏效果，建议生产环境限制 `/api/v1/docs` 与 openapi 为管理员/内网可读。
- **SEC-18/19**：CSP 可补 `object-src 'none'`；COOP/COEP/CORP 可按兼容性评估；HTTPS 部署加 HSTS；生产 Cookie 建议 `__Host-` 前缀并限制 `CookieDomain`。
- **SEC-20（已修复）**：密码策略最小长度由 8 提高到 12（仍为最长 128、至少两类字符），并内置数百条经典弱口令黑名单（忽略大小写的**整串精确匹配**，拒绝时 `details.rule: too_common`）；注册 / 重置 / 建号共用，旧密码仍可登录。前端校验与 OpenAPI 契约同步为 12 位。
- **SEC-21**：扩展同 id 导入会静默替换并保持启用；建议记录包哈希、替换时要求 step-up + 显式确认。
- **SEC-23**：`window.open('/', '_blank')` 与 PreviewBridge 选择器拼接风险极低；可顺手加 `noopener` 与 `CSS.escape`。

## 4. 已验证安全的方面（无问题结论摘要）

| 类别 | 验证结果 |
| --- | --- |
| JWT | 算法固定 EdDSA；`alg=none`、HS256 混淆、签名篡改、payload 角色/用户/站点/过期篡改、异常 kid 共 11 组全部 401；令牌不落日志 |
| Cookie / CSRF | refresh HttpOnly + Path 限定 + 轮换；旧 refresh 重放会吊销家族；缺/错 CSRF 头与伪造 Origin 均 403；注销清 Cookie；无 CORS 通配/反射 |
| 登录枚举 | 未知邮箱、已知邮箱错密码、用户名错密码：状态码/正文一致，dummy Argon2 时序差 <25ms |
| 2FA | 密码登录只返回 challenge；challenge/TOTP 重放、恢复码重放均拒绝；恢复码单次消费 |
| 授权 / IDOR | 成员访问平台/系统/扩展/备份/审计全 403；改自己角色/配额 403；跨站点 token+路径 4 条全 403；资源 id 遍历统一 404；平台管理员角色层级/最后管理员保护完整 |
| SQL 注入 | 全部参数化/Ent predicate；ORDER BY 白名单、cursor 校验、limit 有界；`/search` 12 种 payload 无异常 |
| 路径 / 文件 | media 存储 key 服务端生成并拒绝 `..`/`\`/绝对路径/NUL；备份归档 safeEntry、校验和、解压上限；扩展 zip 拒绝 ADS/保留名/符号链接/zip 炸弹；插件资源 path.Clean 拒绝 `..` |
| 上传 | MIME 白名单 + Rust 魔数/polyglot 检测 + 分片 size 绑定；下载 nosniff/服务端 MIME |
| SSRF | captcha 端点为编译期常量；OAuth/mailer 端点为配置非用户输入；唯一用户影响的出站是 DNS TXT 域名验证；无元数据地址可达路径 |
| WASM 沙箱 | wazero 每插件 runtime、无 FS/网络/env import、内存页/超时上限、stdio/响应体上限 |
| XSS | 文章 HTML 只渲染服务端 Rust（ammonia）清洗结果且 fail-closed；评论/昵称/分类/站点文案全部文本渲染；图表 escapeXml、KaTeX trust:false；无 `eval`/`new Function`；管理后台无 CORS 放行、`?next=` 无开放重定向 |
| 网关 | 三个服务均只监听 `127.0.0.1`；无 pprof/metrics 暴露；API 安全头（CSP/XFO/nosniff/Referrer/Permissions）齐备 |

## 5. 本次代码改动与验证

| 改动 | 文件 |
| --- | --- |
| SMTP 启用时必须配置 `PUBLIC_BASE_URL`（非桌面） | `apps/api/internal/platform/config/config.go`、`config_security_test.go` |
| 首管理员要求回环 Host + 回环对端 | `apps/api/internal/auth/first_admin.go`、`first_admin_test.go`、`write_guard_handler_test.go` |
| 作者卡链接过 `safeUrl`、公告条拒绝 `//` | `apps/web/src/components/blocks/Nightflight.tsx`、`components/SiteChrome.tsx` |
| Go 工具链 1.27.4（修复 `GO-2026-6859`） | `go.mod`、`apps/launcher/go.mod` |
| `golang.org/x/image` → v0.45.0（WebP 解码崩溃修复） | `go.mod`、`go.sum` |
| `katex` → 0.19.1（GHSA-238p-pmpm-9mq7） | `apps/web/package.json`、`package-lock.json` |
| 密码策略 12 位起 + 内嵌弱口令黑名单（`too_common`） | `apps/api/internal/auth/{validation,common_passwords}.go`、`packages/contracts/openapi/openapi.yaml`、`apps/web/src/lib/{passwordPolicy,commonPasswords}.ts` 及 i18n |

验证命令与结果：

```text
go build ./apps/api/...                                   OK
go vet ./apps/api/...                                     OK
go test ./apps/api/... ./packages/... -count=1            OK（含安全修复新增测试）
apps/launcher: go build ./... / go test ./...             OK
govulncheck ./...                                         No vulnerabilities found
apps/web: npm run typecheck                               OK
apps/web: npm test                                        108 files / 1252 tests passed
apps/web: npm run build                                   OK
apps/web: npm audit --omit=dev                            0 vulnerabilities
```

## 6. 残余风险与建议优先级

1. **高优先级**：生产启用 SMTP 时务必设置 `PUBLIC_BASE_URL`（现在会强制校验）；不要把开发端口 5173 / API 端口暴露到非回环网络；平台管理员会话视为可执行代码/可拖库的高价值凭据，建议后续把扩展导入、站点配置、备份加入 step-up。
2. **中优先级**：按 SEC-02/SEC-07/SEC-09 调整锁定与枚举策略；多副本部署引入共享限流存储；为 step-up/handoff 令牌加一次性语义；备份下载改为短时效签名 URL。
3. **持续改进**：CSP `object-src 'none'` 与 COOP/CORP、HSTS；creator extension sandbox 回归测试；`window.open` noopener；请求体 413；生产收敛 docs/openapi。

## 7. 审计资源与清理

- 原始证据与 agent 报告保留在本地 `.tmp/security/`（gitignored，不随仓库提交）：
  `findings-auth.md`、`findings-backend.md`、`findings-frontend.md` 及探针脚本。
- 测试账号（7 个 `qa-sec-*`）已删除；`data/extensions` 状态为空；用户表恢复 8 个真实账户。
- 未修改站点现有内容、成员、角色、2FA 或数据库文件；仅代码修复与依赖升级进入提交。
