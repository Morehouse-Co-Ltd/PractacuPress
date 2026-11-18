Practacu Press · Linux 安装包
================================

这个目录装的是 Practacu Press 的 Linux 版本（x86_64 或 aarch64，取决于压缩包）：Go API、Rust 安全服务与
前端（含八步安装引导）都在包里，目标机不需要 Go / Node / Rust，也不需要 Docker。

三步装好
--------
1) 解压后运行安装向导（需要 root）：

     tar -xzf PractacuPress-Linux-<x64|arm64>.tar.gz
     cd PractacuPress-Linux-<x64|arm64>
     sudo ./install.sh

   向导会问程序目录、数据目录、端口与是否配置 Nginx，直接回车即用默认值。

2) 打开安装引导，创建第一个账户（它就是平台管理员）：

   · 服务器本机：http://127.0.0.1:8080
   · 远程服务器：先在自己电脑上开隧道
       ssh -L 8080:127.0.0.1:8080 你的用户@服务器地址
     再打开 http://127.0.0.1:8080

   ⚠ 这一阶段只监听回环，不要用 http://服务器IP:8080 访问——
     首个管理员只能从回环地址注册。

3) 安装引导完成后，切换访问形态（二选一）：

     # 内网 / 单机 HTTP（不需要域名与证书）
     sudo /opt/practacu-press/install.sh --finalize --mode lan

     # 公网 HTTPS（先在管理后台完成域名验证，且 DNS 已指向本机）
     sudo /opt/practacu-press/install.sh --finalize --mode public --domain 你的域名

常用命令
--------
  sudo /opt/practacu-press/install.sh --status          查看安装状态与访问地址
  sudo journalctl -u practacu-press-api -f              看 API 日志
  sudo journalctl -u practacu-press-security -f         看安全服务日志
  sudo systemctl restart practacu-press-api             重启 API
  sudo /opt/practacu-press/install.sh                   升级（保留数据与密钥）
  sudo /opt/practacu-press/uninstall.sh                 卸载（保留数据）

数据与备份
----------
  · 数据默认在 /var/lib/practacu-press/data/：
      practacu.db   SQLite 数据库
      media/        上传的媒体文件
      backups/      后台生成的整站备份
  · 备份＝复制整个 data 目录；也可以在后台「数据」页生成备份。
  · 升级前建议先备份。

安全服务
--------
  包里带 practacu-security（Argon2id 密码哈希、HTML 白名单清洗、上传检查）。
  它没起来时站点仍可浏览/写作，但发布文章与完成上传会按设计返回 503
  （fail-closed，不是故障）。

排查
----
  · 页面打不开：确认 SSH 隧道、`ss -ltn | grep 8080`、`journalctl -u nginx`
  · 服务不健康：`curl -fsS http://127.0.0.1:8081/healthz`、`/readyz`
  · 完整说明（含域名验证、证书、防火墙、升级与卸载）见 INSTALL.md
