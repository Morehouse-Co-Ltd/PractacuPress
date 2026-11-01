Practacu Press · Windows 一键启动
==================================

本压缩包里的三样东西：
  · PractacuPress.exe        站点启动器（前台、管理后台与安装引导已内嵌，双击即用）
  · PractacuPressAPI.exe     Go API（真实环境的数据服务，由启动器自动拉起）
  · practacu-security.exe    Rust 安全服务（Argon2id 密码哈希、内容清洗、上传检查）

使用方法
  1. 把整个文件夹解压到任意位置（不要在压缩包里直接双击）。
  2. 双击 PractacuPress.exe。
  3. 浏览器会自动打开 http://localhost。
  4. 第一次进入按引导完成安装：
       · 选「演示数据」= 不建库、不写服务端，数据保存在浏览器 localStorage，适合先看界面；
       · 选「真实环境」= 使用启动器已经拉起好的 Go API + SQLite，数据保存在 data 目录，可长期写作。

运行方式
  · 启动器会先拉起 practacu-security.exe，再拉起 PractacuPressAPI.exe，
    并把 /api、/healthz、/readyz 同源代理到站点端口，所以不需要填地址，也不需要另外开窗口。
  · 启动器会依次寻找 PractacuPressAPI.exe、api/PractacuPressAPI.exe；
    找不到时自动退回演示模式，界面照常可用。
  · 想强制只用静态前端：PractacuPress.exe --mode demo
    想强制真实环境（缺少 API 时报错退出）：PractacuPress.exe --mode live

数据（真实环境）
  · 默认在 exe 同目录的 data 文件夹：
      data/practacu.db         SQLite 数据库
      data/media/              上传的媒体文件
      data/api.log             API 日志
      data/api.err.log         API 错误日志
      data/security.log        安全服务日志
  · 第一次启动会自动建表并创建默认站点；安装引导里创建的第一个账户就是平台管理员。
  · 备份：关掉窗口后复制整个 data 文件夹即可。
  · exe 所在目录不可写时（例如放在 Program Files），数据改存
    %LOCALAPPDATA%\PractacuPress\data。

安全服务
  · 本包已附带 practacu-security.exe，启动器会一并拉起。
  · 如果它被删除或被安全软件拦截，站点仍可运行，但发布文章与完成上传会返回 503
    （这是设计上的 fail-closed，不是故障）。
  · 端口、密钥等都在启动器内部处理，不需要手工配置环境变量。

端口
  · 默认使用 80 端口，地址栏不用写端口号。
  · 80 被占用时会自动改用 8080，窗口里会显示实际地址。
  · 登录后台 → 站点设置 → 访问端口，可以随时修改；
    选择会记住（保存在 exe 同目录的 practacu-web.json）。
  · 真实环境下换端口不会影响 API：页面与 /api 始终同源。

演示模式
  · 演示数据保存在浏览器的 localStorage，按访问地址隔离；在后台换端口会自动迁移。
  · 清除浏览器数据会丢失内容；主题与自定义页面可在「外观」里导出 JSON 备份。
  · 站点只监听本机（127.0.0.1 / ::1），局域网内其他设备访问不到。

停止
  · 关闭窗口即停止站点；启动器拉起的 API 与安全服务会一并退出。

常见问题
  · 提示「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」。未签名程序的常规提示。
  · 双击后没有任何反应：先检查是否被安全软件拦截；启动失败时窗口会停留并显示原因。
  · 选了真实环境却连不上：看窗口里的提示与 data/api.err.log；
    多半是杀毒软件拦截了 PractacuPressAPI.exe，把整个文件夹加入信任即可。
  · 杀毒软件拦截：把 PractacuPress.exe、PractacuPressAPI.exe、practacu-security.exe
    加入信任即可。

技术说明
  · 启动器、API 与安全服务都是原生程序：站点文件内嵌在启动器里，API 用纯 Go 的 SQLite 驱动，
    不需要安装 Node.js 或数据库。
  · 运行时接口：GET /__pp/runtime、POST /__pp/runtime/port、GET /__pp/state/{token}，
    只接受本机请求，用于后台修改端口与数据迁移。
  · /__pp/runtime 还会返回本次运行方式与本机 API 状态，安装引导据此判断能否直连真实环境。
  · 想自己重新打包：在源码仓库里双击 打包.bat，或执行
    powershell -ExecutionPolicy Bypass -File scripts\package.ps1
