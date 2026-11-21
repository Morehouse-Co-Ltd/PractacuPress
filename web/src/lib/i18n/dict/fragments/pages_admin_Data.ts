import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/Data.tsx` 与 `components/AdminShell.tsx` 的数据入口 */
const fragment: Dictionary = {
  // ---- 页头 ----
  '数据与备份': 'Data and backups',
  '导出可迁移的 Markdown 与图片，或为整个实例生成可校验的备份包。':
    'Export portable Markdown and images, or create a verifiable package for the whole instance.',
  '导出可迁移的 Markdown 与图片、WordPress / Typecho XML，或为整个实例生成可校验的备份包。':
    'Export portable Markdown and images, WordPress / Typecho XML, or a verifiable package for the whole instance.',
  '真实后端': 'Live backend',
  '演示模式': 'Demo mode',
  '演示模式不生成真实文件': 'Demo mode does not create real files',
  '连接真实后端后才能导出、导入或下载备份；演示数据只保存在这台浏览器里。':
    'Connect a live backend to export, import or download backups; demo data lives only in this browser.',

  // ---- 导出 ----
  '全站导出': 'Whole-site export',
  'Markdown 带 front matter，附图片、站点设计、页面与分类标签。':
    'Markdown carries front matter and ships with images, the site design, pages and taxonomy.',
  '导出范围': 'Export range',
  '已发布内容适合迁移到别的写作工具；草稿默认也包含，便于换机继续写。':
    'Published content is best for moving to another writing tool; drafts are included by default so you can continue elsewhere.',
  '全部内容（含草稿与已归档）': 'Everything (including drafts and archived items)',
  '只导出已发布内容': 'Only published content',
  '导出 ZIP': 'Export ZIP',
  '图片会改写为包内相对路径，导入时再映射回本站媒体。':
    'Images are rewritten to relative paths inside the package and mapped back to site media on import.',
  '导出完成': 'Export complete',
  '已下载 {name}': 'Downloaded {name}',

  // ---- 导入 ----
  '全站导入': 'Whole-site import',
  '从导出包创建草稿；每条独立落库并逐条报告。':
    'Create drafts from an export package; every item is stored independently and reported.',
  '导出包': 'Export package',
  '选择本站或另一个站点导出的 practacu-press-site-export zip。':
    'Choose a practacu-press-site-export zip exported from this or another site.',
  'slug 冲突': 'Slug conflict',
  '标题相同不会阻止导入；这里处理的是地址（slug）已经被占用的情况。':
    'Duplicate titles are allowed; this only decides what to do when the URL slug is already taken.',
  '自动改名（追加 -2、-3）': 'Rename automatically (append -2, -3)',
  '跳过已存在的条目': 'Skip items that already exist',
  '保留冲突并记为失败': 'Keep the conflict and mark it failed',
  '覆盖已存在的条目': 'Overwrite items that already exist',
  '导入只创建草稿，不会自动发布；审核规则仍然生效。覆盖会通过正常的草稿保存流程更新原条目。':
    'Import only creates drafts and never publishes automatically; the review rules still apply. Overwrite updates the existing item through the normal draft save.',
  '开始导入': 'Start import',
  '成功 {count}': 'Imported {count}',
  '覆盖 {count}': 'Overwritten {count}',
  '跳过 {count}': 'Skipped {count}',
  '失败 {count}': 'Failed {count}',
  '导入图片 {count}': 'Images imported {count}',
  '复用图片 {count}': 'Images reused {count}',
  '导入提示': 'Import notes',
  '文件': 'File',
  '标题': 'Title',
  '地址（slug）': 'Slug',
  '结果': 'Result',
  '说明': 'Note',
  '失败': 'Failed',
  '跳过': 'Skipped',
  '已覆盖': 'Overwritten',
  '已导入': 'Imported',
  '导入完成': 'Import complete',
  '导入完成，但有 {failed} 条失败': 'Import complete with {failed} failures',
  '成功 {imported} · 覆盖 {overwritten} · 跳过 {skipped}':
    'Imported {imported} · Overwritten {overwritten} · Skipped {skipped}',

  // ---- 备份 ----
  '实例备份': 'Instance backup',
  '数据库全量 + 媒体 + 站点设计，manifest 记录版本与逐文件 SHA-256。':
    'Full database, media and site designs; the manifest records versions and a SHA-256 per file.',
  '仅平台管理员可备份整个实例': 'Only a platform administrator can back up the whole instance',
  '站点管理员可用上方的全站导出迁移自己的内容；实例备份包含所有站点，因此不在这里开放。':
    'A site administrator can use the whole-site export above; an instance backup contains every site, so it is not offered here.',
  '站点管理员可用「数据导入导出」里的全站导出迁移自己的内容；实例备份包含所有站点，因此不在这里开放。':
    'A site administrator can use the whole-site export on “Data import and export” to move their content; an instance backup contains every site, so it is not offered here.',
  '立即创建备份': 'Create backup now',
  '刷新列表': 'Refresh list',
  '备份已生成': 'Backup created',
  '还没有备份包。SQLite 会生成一致快照；MySQL / PostgreSQL 请用各自的 dump 工具。':
    'No backup packages yet. SQLite produces a consistent snapshot; use the native dump tools for MySQL / PostgreSQL.',
  '时间': 'Time',
  '大小': 'Size',
  '媒体': 'Media',
  '校验': 'Checksum',
  '已包含': 'Included',
  '未包含': 'Not included',
  '下载': 'Download',
  '备份范围提示': 'Backup scope notes',

  // ---- 数据导入导出 / 备份两个 tab ----
  '数据导入导出': 'Data import and export',

  // ---- 页面内恢复 ----
  '在线恢复备份': 'Restore backup online',
  '恢复完成': 'Restore complete',
  '数据库已恢复到 {name}': 'Database restored to {name}',
  '从备份恢复': 'Restore from backup',
  '直接在页面里选择一个 SQLite 备份覆盖当前数据库。':
    'Choose a SQLite backup on this page to replace the current database.',
  '仅平台管理员可恢复整个实例': 'Only a platform administrator can restore the whole instance',
  '恢复会替换所有站点的数据库，只有平台管理员可以执行；站点管理员请使用数据导入导出迁移自己的内容。':
    'Restoring replaces the database for every site, so only a platform administrator can do it. Site administrators can move their own content with data import and export.',
  '当前后端不支持页面内恢复': 'This backend does not support in-page restore',
  '请升级 API 后重试，或使用命令行恢复脚本。':
    'Upgrade the API and try again, or use the command-line restore script.',
  '高危操作：恢复会覆盖当前数据': 'High-risk action: restoring overwrites current data',
  '服务端会先校验备份包与每个文件的 SHA-256，自动创建一份安全备份，再用备份覆盖本机 SQLite 数据库并恢复本地媒体。恢复过程中请勿关闭服务；当前登录会话可能因账户数据被替换而失效。':
    'The server verifies the package and every file SHA-256, creates a safety backup, then replaces the local SQLite database and restores local media. Do not stop the service during the restore; the current session may expire if account data is replaced.',
  '还没有可恢复的 SQLite 备份。先创建一个备份，或刷新列表。':
    'There is no restorable SQLite backup yet. Create one first, or refresh the list.',
  '选择备份': 'Choose a backup',
  '只列出 SQLite 备份包；MySQL / PostgreSQL 请使用各自的 dump 工具恢复。':
    'Only SQLite packages are listed; restore MySQL / PostgreSQL with their native dump tools.',
  '请选择一个备份…': 'Choose a backup…',
  '恢复此备份': 'Restore this backup',
  '需要平台管理员身份，并再次输入高危操作密码。':
    'Requires a platform administrator and a fresh high-risk password check.',
  '数据库已恢复到 {path}；恢复前安全备份为 {id}。':
    'Database restored to {path}; the pre-restore safety backup is {id}.',
  '站点 {sites} · 用户 {users} · 内容 {content} · 媒体 {media} 个文件 · schema {schema}':
    'Sites {sites} · Users {users} · Content {content} · Media {media} files · schema {schema}',
  '重新加载页面': 'Reload page',
  'MySQL / PostgreSQL 不使用页面内恢复：请用 mysqldump / pg_dump 恢复数据库，媒体目录单独复制。S3 媒体不进入备份包，需要按桶单独备份。':
    'MySQL / PostgreSQL do not use in-page restore: restore the database with mysqldump / pg_dump and copy the media directory separately. S3 media is not packaged and must be backed up per bucket.',
  '确认恢复备份': 'Confirm backup restore',
  '这会覆盖当前数据库，且无法从页面撤销。':
    'This replaces the current database and cannot be undone from this page.',
  '继续并验证密码': 'Continue and verify password',
  '即将用 {name} 覆盖当前实例；服务端会先自动创建安全备份。':
    '{name} will replace the current instance; the server creates a safety backup first.',
  '确认后会要求再次输入高危操作密码。恢复完成前请不要关闭服务或刷新页面。':
    'After confirming, you must enter the high-risk password again. Do not stop the service or refresh the page during the restore.',

  // ---- 命令行恢复 ----
  '恢复': 'Restore',
  '恢复会替换数据库文件，只能在服务停止后由命令行执行。':
    'Restore replaces the database file and can only run from the command line while the service is stopped.',
  '恢复前自动做一次安全备份': 'A safety backup is created before restoring',
  '命令会先校验 manifest 与每个文件的 SHA-256，拒绝覆盖非空库，除非显式加 -Confirm；随后自动备份当前数据，再替换数据库与本地媒体，最后重新应用增量迁移并校验表结构。':
    'The command first verifies the manifest and every file SHA-256 and refuses to replace a non-empty database unless -Confirm is given; it then backs up the current data, replaces the database and local media, reapplies additive migrations and verifies the tables.',
  '在仓库根目录执行：': 'Run from the repository root:',
  'MySQL / PostgreSQL 不使用此命令：请用 mysqldump / pg_dump 备份数据库，媒体目录单独复制。S3 媒体不进入备份包，需要按桶单独备份。':
    'MySQL / PostgreSQL do not use this command: back up the database with mysqldump / pg_dump and copy the media directory separately. S3 media is not packaged and must be backed up per bucket.',

  // ---- WordPress / Typecho 导出 ----
  '导出到 WordPress / Typecho': 'Export to WordPress / Typecho',
  '生成标准 XML，供 WordPress 的 WXR 导入器或 Typecho 迁移工具读取。':
    'Generate standards-shaped XML for the WordPress WXR importer or Typecho migration tools.',
  '导出格式': 'Export format',
  'WordPress 使用 WXR 1.2；Typecho 使用备份风格的 posts / comments XML。':
    'WordPress uses WXR 1.2; Typecho uses a backup-style posts / comments XML.',
  'WordPress WXR XML': 'WordPress WXR XML',
  'Typecho XML': 'Typecho XML',
  '内容范围': 'Content scope',
  '只导出所选类型；分类与标签会一起写进 XML。':
    'Only the selected kinds are exported; categories and tags are written into the XML too.',
  '文章与帖子': 'Articles and posts',
  '仅文章': 'Articles only',
  '仅帖子': 'Posts only',
  '状态范围': 'Status scope',
  '草稿在 WordPress / Typecho 里也会是草稿状态。':
    'Drafts stay drafts in WordPress / Typecho as well.',
  '全部内容（含草稿）': 'Everything (including drafts)',
  '包含评论': 'Include comments',
  '仅评论列表可用时生效；无法关联到所选内容的评论会被跳过。':
    'Only works when the comment list is available; comments that cannot be matched to the selected content are skipped.',
  '媒体文件不会进入 XML': 'Media files are not part of the XML',
  '正文里的站内图片会改写成站点绝对地址；导入 WordPress / Typecho 后仍需由对方抓取或重新上传这些媒体。':
    'In-site images in the body are rewritten to absolute site URLs; WordPress / Typecho still has to fetch or re-upload those media after import.',
  '导出 XML': 'Export XML',
  '评论作者与发布时间会一起写入。': 'Comment authors and timestamps are written too.',
  '没有符合条件的内容，文件里只有站点信息。':
    'No content matched the filters, so the file only contains site information.',
  '当前后端没有评论列表接口，本次导出不含评论。':
    'This backend has no comment list endpoint, so this export contains no comments.',
  '只导出了与所选内容关联的 {count} 条评论。':
    'Only {count} comments that belong to the selected content were exported.',
  'XML 不含媒体文件：正文里的图片已改写为绝对地址，WordPress / Typecho 导入后需要抓取或重新上传。':
    'The XML contains no media files: images in the body were rewritten to absolute URLs, and WordPress / Typecho must fetch or re-upload them after import.',

  // ---- WordPress / Typecho 导入 ----
  '从 WordPress / Typecho 导入': 'Import from WordPress / Typecho',
  '读取 WXR 或 Typecho XML：先预览格式与数量，确认后创建草稿或按选择发布。':
    'Read a WXR or Typecho XML file: preview its format and counts, then create drafts or publish as chosen.',
  'XML 文件': 'XML file',
  '支持 WordPress WXR 1.2 与 Typecho 备份 XML；文件只在浏览器里解析，不会上传到服务器。':
    'Supports WordPress WXR 1.2 and Typecho backup XML; the file is parsed in the browser and never uploaded to the server.',
  '正在解析…': 'Parsing…',
  'XML 文件不能超过 20 MB。': 'The XML file must not exceed 20 MB.',
  '文件里没有找到可导入的文章或评论。':
    'No importable articles or comments were found in the file.',
  '无法识别这个 XML：请选择 WordPress WXR 或 Typecho 备份文件。':
    'Unrecognised XML: choose a WordPress WXR or Typecho backup file.',
  'XML 解析失败：文件可能已损坏。': 'Failed to parse the XML: the file may be damaged.',
  'XML 含 DOCTYPE / ENTITY 声明，出于安全考虑已拒绝解析。':
    'The XML contains DOCTYPE / ENTITY declarations; parsing was refused for safety.',
  '文章 {count}': 'Articles {count}',
  '帖子 {count}': 'Posts {count}',
  '评论 {count}': 'Comments {count}',
  '来源站点：{name}': 'Source site: {name}',
  '解析提示': 'Parse notes',
  '跳过 {count} 条不支持的内容类型：{type}':
    'Skipped {count} items of an unsupported type: {type}',
  '有 {count} 条内容缺少标题，导入时会跳过。':
    '{count} items have no title and will be skipped on import.',
  '有 {count} 条内容缺少正文，导入时会跳过。':
    '{count} items have no body and will be skipped on import.',
  '跳过 {count} 条空评论。': 'Skipped {count} empty comments.',
  '跳过 {count} 条无法关联到文章的评论。':
    'Skipped {count} comments that could not be matched to an article.',
  '有 {count} 条时间无法解析，已留空。':
    '{count} timestamps could not be parsed and were left empty.',
  '文件没有 wp:wxr_version，已按 WXR 1.x 尽力解析。':
    'The file has no wp:wxr_version and was parsed on a best-effort WXR 1.x basis.',
  '只显示前 10 条，确认导入时会处理全部 {count} 条。':
    'Only the first 10 are shown; confirming the import processes all {count} items.',
  '导入后的状态': 'Status after import',
  '先创建草稿，再按这里的选项切换；没有发布权限时会在报告里说明。':
    'Drafts are created first and then switched to this status; if you lack publish permission the report says so.',
  '保持草稿': 'Keep as draft',
  '直接发布（需要发布权限）': 'Publish directly (requires publish permission)',
  '导入评论': 'Import comments',
  '评论会挂到对应的新文章下；作者无法通过 API 指定，原名会写进正文前缀。':
    'Comments are attached to the matching new article; the API cannot set their author, so the original name is written into a body prefix.',
  '导入说明': 'Import notes',
  '导入以当前管理员账户写入，无法保留原作者身份；分类与标签会尽量复用站点分类法，slug 冲突时会自动追加后缀。':
    'The import writes under the current admin account and cannot preserve original authorship; categories and tags reuse the site taxonomy where possible, and duplicate slugs get a numeric suffix.',
  '确认导入': 'Confirm import',
  '已处理 {done} / {total}': 'Processed {done} / {total}',
  '站点信息尚未就绪。': 'Site information is not ready yet.',
  '读取现有内容失败，slug 冲突检测已跳过；服务端若拒绝重复地址会逐条报错。':
    'Failed to read existing content, so duplicate-slug detection was skipped; if the server rejects a duplicate URL it is reported per item.',
  '一篇内容只能有一个分类，多余分类已忽略。':
    'Content can only have one category, so extra categories were ignored.',
  '缺少标题': 'Missing title',
  '缺少正文': 'Missing body',
  '未命名': 'Untitled',
  'slug 冲突，已改为 {slug}': 'Slug conflict, renamed to {slug}',
  '正文超过 {max} 个字符，已截断。': 'The body exceeded {max} characters and was truncated.',
  '草稿已创建，但状态切换失败：{reason}':
    'The draft was created but the status change failed: {reason}',
  '原评论作者：{author}': 'Original comment author: {author}',
  '由导入创建的评论': 'Comment created by import',
  '原评论在来源站点未通过审核': 'The original comment was not approved on the source site',
  '文件里没有评论，已跳过评论导入。':
    'The file contains no comments, so comment import was skipped.',
  '本次选择不导入评论，已跳过 {count} 条。':
    'Comments are disabled for this import, so {count} were skipped.',
  '导入 WordPress / Typecho 内容': 'Import WordPress / Typecho content',
  '导入 {count}': 'Imported {count}',
  '发布 {count}': 'Published {count}',
  '提交 {count}': 'Submitted {count}',
  '跳过评论 {count}': 'Comments skipped {count}',
  '已导入 {imported} · 跳过 {skipped} · 失败 {failed}':
    'Imported {imported} · Skipped {skipped} · Failed {failed}',

  // ---- 改版：分组标题 / 备份健康条 / 备份列表 ----
  '带上内容、图片与站点设计，换台机器也能继续写。':
    'Take your content, images and site design with you; keep writing on another machine.',
  '先创建草稿，逐条报告结果；发布状态与审核规则照常生效。':
    'Items become drafts and are reported one by one; publish state and review rules still apply.',
  '最近备份': 'Latest backup',
  '备份包': 'Packages',
  '自动计划': 'Automatic schedule',
  '还没有备份': 'No backups yet',
  '最近备份已超过 {days} 天': 'The latest backup is {days} days old',
  '保留最近 {count} 份': 'Keeps the latest {count}',
  '还没有备份包': 'No backups yet',
  '备份包含数据库、媒体与站点设计；恢复前服务端会再校验一次。':
    'A backup contains the database, media and site design; the API verifies it again before restoring.',
  'SQLite 生成一致快照；MySQL / PostgreSQL 请用各自的 dump 工具。':
    'SQLite takes a consistent snapshot; use the native dump tools for MySQL / PostgreSQL.',
  '在备份列表里点「恢复」；这一步会覆盖当前数据库，且无法从页面撤销。':
    'Choose Restore on a backup below; it overwrites the current database and cannot be undone from this page.',
};

export default fragment;
