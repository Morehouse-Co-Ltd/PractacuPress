Practacu Press · macOS 安装包
================================

这个目录是 Practacu Press 的 macOS 版本（Apple Silicon 或 Intel，取决于下载的
压缩包）：Go API、Rust 安全服务、预构建前端与启动/卸载脚本都在包里，目标机不需要
Go / Node / Rust / Docker。

三步装好
--------
1) 解压后运行安装器（需要 sudo）：

     tar -xzf PractacuPress-macOS-arm64.tar.gz
     cd PractacuPress-macOS-arm64
     sudo ./install.sh

   安装器会：
     · 把程序装到 /usr/local/practacu-press
     · 把数据放到 /usr/local/var/practacu-press
     · 注册两个 launchd 服务（API + 安全服务），以当前 sudo 用户运行
     · 如果已安装 Homebrew Nginx，生成 127.0.0.1:8080 的同源站点

   没有 Nginx 时先装：brew install nginx，再重新执行 sudo ./install.sh。
   也可以 `sudo ./install.sh --no-nginx`，自行用 Caddy 等反代到 127.0.0.1:8081。

2) 打开安装引导，创建第一个账户（它就是平台管理员）：

     http://127.0.0.1:8080

3) 需要公网访问时，在前面加一层 TLS 反代（Caddy / Nginx），
   并修改 /usr/local/etc/practacu-press/practacu.env：
     · APP_ENV=production
     · PP_DESKTOP=false
     · PUBLIC_BASE_URL=https://你的域名
     · AUTH_JWT_ED25519_PRIVATE_KEY 必须是持久密钥
   然后重启服务：
     sudo launchctl kickstart -k system/com.practacu.press-api

常用命令
--------
  sudo launchctl print system/com.practacu.press-api       查看 API 服务
  sudo launchctl kickstart -k system/com.practacu.press-api 重启 API
  sudo launchctl kickstart -k system/com.practacu.press-security 重启安全服务
  tail -f /usr/local/var/practacu-press/api.err.log        看 API 错误
  sudo /usr/local/practacu-press/uninstall.sh              卸载（保留数据）
  sudo /usr/local/practacu-press/uninstall.sh --purge      连数据一起删除

数据与备份
----------
  · /usr/local/var/practacu-press/data/
      practacu.db   SQLite 数据库
      media/        上传的媒体文件
      backups/      后台生成的整站备份
  · 备份 = 复制整个 data 目录，或在后台「数据」页生成备份包。

安全服务
--------
  包里带 practacu-security（Argon2id、HTML 白名单清洗、上传检查）。它没起来时
  站点仍可浏览/写作，但发布文章与完成上传会按设计返回 503（fail-closed）。

Intel / Apple Silicon
---------------------
  · arm64 包用于 Apple Silicon（M 系列），x86_64 包用于 Intel Mac。
  · 在 Apple Silicon 上可以通过 Rosetta 运行 x86_64 包，但优先用 arm64 包。
  · 两个包的前端相同，二进制由各自架构的 Go / Rust 工具链构建。
