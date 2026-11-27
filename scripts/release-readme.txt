Practacu Press · Windows 便携版
================================

本压缩包只有程序本身：
  · PractacuPress.exe   Go 程序（内嵌前台、管理后台、安装引导与安全检查）
  · .env                   本机开发配置
  · 启动.cmd               双击启动并打开浏览器
  · data/                  数据库、媒体与备份目录

使用方法
  1. 把整个文件夹解压到任意位置（不要在压缩包里直接双击）。
  2. 双击 启动.cmd，或在本目录运行 PractacuPress.exe。
  3. 浏览器打开 http://127.0.0.1:8080。
  4. 第一次进入按引导完成安装；第一个注册账户就是平台管理员。

配置
  · 默认配置在 .env：development、SQLite、本地媒体目录、127.0.0.1:8080。
  · 修改端口时同时改 .env 里的 HTTP_ADDR 与 PUBLIC_BASE_URL。
  · 生产部署请设置 APP_ENV=production、PP_DESKTOP=false，并提供
    AUTH_JWT_ED25519_PRIVATE_KEY、FIELD_ENCRYPTION_KEY、BACKUP_ENCRYPTION_KEY。
  · 安全检查（Argon2id、HTML 白名单、上传检查）已编译进 API，不需要额外服务。

数据
  · data/practacu.db         SQLite 数据库
  · data/media/              上传的媒体文件
  · data/backups/            整站备份
  · 备份：关掉程序后复制整个 data 文件夹。
  · 首次启动会自动建表并创建默认站点。

停止
  · 关闭运行 PractacuPress.exe 的命令行窗口，或在窗口中按 Ctrl+C。

常见问题
  · 浏览器打不开：确认命令行窗口没有报错，端口 8080 未被占用。
  · 提示缺少 APP_ENV：确认启动时的工作目录就是本文件夹（.env 所在目录）。
  · 杀毒软件拦截：把 PractacuPress.exe 加入信任。

技术说明
  · 单个 Go 二进制同时提供前端、/api、/api/healthz 与 /api/readyz。
  · SQLite 使用纯 Go 驱动，不需要安装 Node.js、数据库或额外服务。
  · migrate / seed / backup / media-gc / searchindex 是同一个程序的子命令，
    例如 PractacuPress.exe migrate --driver sqlite --dsn "file:./data/practacu.db"。
