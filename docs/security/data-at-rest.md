# 静态数据加密（data at rest）

本文说明当前版本在“数据库/备份文件被整份拿走”时还能保护什么、不能保护什么，以及密钥
怎么配、怎么迁移。代码位置：`apps/api/internal/platform/fieldcrypto`、
`apps/api/internal/platform/identitycrypto`、`apps/api/internal/backup/crypto.go`。

## 1. 分层

| 数据 | 存储形式 | 是否可还原 | 密钥 |
| --- | --- | --- | --- |
| 账户口令 | Argon2id PHC 哈希（64 MiB / 3 轮 / 随机盐） | 否（单向） | 无 |
| 2FA TOTP 种子 | AES-256-GCM 信封 `v1:` | 是 | 由 `AUTH_JWT_ED25519_PRIVATE_KEY` 派生 |
| 登录邮箱 / 手机号 | AES-256-GCM **确定性**信封 `d1:` | 是 | `FIELD_ENCRYPTION_KEY` |
| 私信正文 | AES-256-GCM 信封 `v1:`，AAD 绑定会话+消息 id | 是 | `FIELD_ENCRYPTION_KEY` |
| 正文、评论、媒体文件 | 明文 | — | 无（靠磁盘/卷加密） |
| 整库备份包 | `.ppbak`：分块 AES-256-GCM 流 | 是 | `BACKUP_ENCRYPTION_KEY` |
| Windows 启动器签名私钥 | DPAPI（`dpapi:`） | 是，仅同一 Windows 用户 | 操作系统 |

## 2. 字段级加密

- 信封格式：`v1:`（随机 nonce）/ `d1:`（确定性 nonce）+ base64(nonce‖ciphertext‖tag)。
- AAD 绑定用途，例如 `user-identity.subject.email`、`message.body|<conversation>|<message>`；
  把密文复制到别的列或别的行会认证失败，而不是解出错误内容。
- 邮箱/手机号必须支持“按值查找”和唯一索引，所以用确定性信封：相同值 → 相同密文。
  代价是泄露“两行是否相等”，不泄露内容；这与 blind index 的泄露相同。
- 私信正文不需要按值查找，使用随机 nonce，同一句话两次发送密文不同。
- 读取时 `OpenOrPlain` 兼容历史明文行：读得出、可继续用，启动时的
  `BackfillIdentityEncryption` / `BackfillMessageEncryption` 会把它们改写为密文
  （幂等，可每次启动运行）。
- 管理员页面看到的是解密后的正常值：个人资料（`/me`）、平台账号目录
  （`/platform/users`，含按邮箱搜索）、站点成员列表（`/sites/:id/members`、
  成员详情/改邮箱）以及私信正文，都在读取路径上解密后再返回；数据库和备份里
  仍然是密文。密钥不匹配时读取直接报错，不会把 `d1:`/`v1:` 信封显示成数据。

## 3. 备份加密

- 仅整库备份（`/platform/backups` 与 `backup` CLI）加密；站点导出仍是明文 zip，
  因为它的用途是跨实例搬运内容。
- 格式：`PPBAK1\n` + 4 字节随机前缀；1 MiB 明文一块，块尾带 16 字节 GCM tag；
  nonce = 前缀‖块序号，AAD = magic‖块序号，因此可检测截断、重排、篡改。
- 密文哈希写进 sidecar（`sha256sum` 与文件一致）；恢复必须提供同一把
  `BACKUP_ENCRYPTION_KEY`，缺失或错误都直接失败，不会退回明文。

## 4. 密钥管理

生产（`APP_ENV=production`）强制要求：

```bash
openssl rand -base64 32   # FIELD_ENCRYPTION_KEY
openssl rand -base64 32   # BACKUP_ENCRYPTION_KEY（另一把）
```

- `FIELD_ENCRYPTION_KEY` 必须留在服务器环境里（API 在线使用），丢失即字段不可读；
  轮换需要先解密再全量重加密，不能只改环境变量。
- `BACKUP_ENCRYPTION_KEY` 可以离线保管：只在创建/恢复备份时需要，适合放密码管理器。
- 开发/测试没有 `FIELD_ENCRYPTION_KEY` 时，会在数据目录生成
  `.field-encryption.key`（0600）并打警告；生产启动会拒绝这种回退。
- `.env.prod` 现在包含三份秘密（JWT 私钥、字段密钥、备份密钥），权限 600、
  不进镜像、不进公开备份。

## 5. 边界

- 字段加密不保护明文列：文章正文、评论、审计日志、媒体文件仍是明文；要覆盖它们
  用 LUKS / BitLocker / 云盘加密。
- 确定性信封可被离线“确认攻击”（已知候选邮箱可验证是否在库中），但无法还原未知值。
- 进程被攻陷（拿到环境变量和内存）时，字段加密不再提供保护；它防的是数据库/备份
  文件脱离服务器后的泄露。
- 多实例部署必须共享同一把 `FIELD_ENCRYPTION_KEY`，否则各副本读不出对方写入的字段。
- `services/security-go` 的 `MinPasswordLength` 仍是 8：那是哈希输入的长度上界/下限，
  账户口令策略由 API 的 `auth.ValidatePassword`（12 位 + 弱口令黑名单）负责。
