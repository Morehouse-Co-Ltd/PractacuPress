import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/Storage.tsx` */
const fragment: Dictionary = {
  // ---- 页头与通用 ----
  '储存与媒体': 'Storage and media',
  '储存设置': 'Storage settings',
  '决定上传的图片与附件写到哪里，并管理正文长度、用户媒体额度与站点媒体额度。':
    'Decide where uploaded images and attachments are written, and manage the content length limit, per-user media limits, and site media quota.',
  '正文长度上限、单个用户媒体额度与站点媒体额度；修改后随本页自动保存。':
    'Content length limit, per-user media limits, and site media quota; changes are saved automatically with this page.',
  '每套策略就是一个存储目标；下面为每个用途选择使用哪一套，也可以按顺序分配多套并设置容量上限。':
    'Each strategy is a storage target; below, choose which one each scope uses, or assign several in order with capacity caps.',
  '各用途使用哪套策略': 'Which strategy each scope uses',
  未连接站点: 'Not connected to a site',
  '储存策略': 'Storage strategies',
  '站点管理员': 'Site admin',
  '媒体库': 'Media library',
  '保存修改': 'Save changes',
  '放弃未保存的修改': 'Discard unsaved changes',
  '没有未保存的修改': 'No unsaved changes',
  '打开媒体库': 'Open media library',
  '性能优化': 'Performance',
  '正文长度上限': 'Maximum content length',
  '字符': 'characters',
  '1 到 {max} 个 Unicode 字符；保存后文章与帖子立即按此上限校验。':
    'From 1 to {max} Unicode characters. Articles and posts use this limit as soon as the settings are applied.',
  '编辑': 'Edit',
  '删除': 'Delete',
  '取消': 'Cancel',
  '名称': 'Name',
  '类型': 'Type',
  '全局': 'Global',

  // ---- 类型 / 用途 ----
  '本地储存': 'Local storage',
  '云对象存储': 'Cloud object storage',
  '文章媒体': 'Article media',
  '站点图片': 'Site images',
  '用户头像': 'User avatars',
  '用户数据与附件': 'User data and attachments',

  // ---- 储存策略列表 ----
  '{count} 套': { one: '1 strategy', other: '{count} strategies' },
  '新建储存策略': 'New storage strategy',
  '用于：{scopes}': 'Used by: {scopes}',
  '暂时没有用途使用这套策略': 'No scope uses this strategy yet',
  'Endpoint：{value}': 'Endpoint: {value}',
  '至少保留一套、最多 {max} 套：只有一套时删除按钮不可用，达到上限时不能再新建。删除被用途引用的策略时，那些用途会回落到第一套。':
    'At least one strategy and at most {max}: with only one left, delete is disabled, and at the limit no new strategy can be created. Deleting a strategy that scopes use makes those scopes fall back to the first strategy.',
  '最多只能有 {max} 套储存策略': 'At most {max} storage strategies are allowed',
  '先删掉一套不再使用的策略，再新建。': 'Delete a strategy you no longer use, then create a new one.',

  // ---- 各用途的储存策略 ----
  '{count} 套在用': { one: '1 in use', other: '{count} in use' },
  '{count} 套策略': { one: '1 strategy', other: '{count} strategies' },
  '查看「{scope}」的储存策略': 'View the storage strategy for “{scope}”',
  '「{scope}」的储存策略': 'Storage strategies for “{scope}”',
  '位置：{path}': 'Location: {path}',
  '有用途指向云策略，但全局策略还是本地储存':
    'A scope points at a cloud strategy, but the global strategy is still local storage',
  '片段里不会生成 STORAGE_S3_* 凭据，服务器需要另行提供 endpoint、区域与 Access Key。':
    'The snippet will not emit STORAGE_S3_* credentials; the server has to provide the endpoint, region, and Access Key another way.',
  '把云策略分配给更多用途，它就会自动成为全局策略。':
    'Assign the cloud strategy to more scopes and it becomes the global strategy automatically.',
  '全局策略由用途数量决定': 'The global strategy is decided by how many scopes use it',
  '被最多用途使用的那套写成全局 STORAGE_DRIVER 与 STORAGE_S3_*；数量并列时取列表里靠前的一套。':
    'The strategy used by the most scopes becomes STORAGE_DRIVER and STORAGE_S3_*; on a tie, the one earlier in the list wins.',
  '其余用途只写自己的 STORAGE_<用途>_* 覆盖，缺省位置由服务器按全局目录推出来。':
    'Every other scope only writes its own STORAGE_<SCOPE>_* override, and the server derives missing paths from the global directory.',

  '文章与帖子里插入的图片、封面等；正文本身不在媒体存储里。':
    'Images, cover art, and similar files inserted into articles and posts; the body text itself is not kept in media storage.',
  '站点图标、分享图与首页编排引用的站点级图片。':
    'The site icon, share images, and site-level images referenced by the home page layout.',
  '成员头像；访问频繁、体积小，可以单独放本地或 CDN 桶。':
    'Member avatars; they are small and read often, so they can live in a local folder or a CDN bucket of their own.',
  '用户上传的附件与私有数据，通常需要鉴权后才能访问。':
    'Attachments and private data uploaded by users, which usually need authentication to reach.',

  // ---- 储存设置 ----
  '单个用户媒体总量上限': 'Per-user total media limit',
  '单个用户单次文章额度上限': 'Per-user per-article media limit',
  '单个用户单次媒体上传上限': 'Per-user single-upload limit',
  '0 表示不限；按 MB 计。超出后该用户的新上传会被拒绝。':
    '0 means unlimited; the unit is MB. New uploads from the user are refused once the total is exceeded.',
  '0 表示不限；按 MB 计。一篇文章引用的媒体总量不能超过它。':
    '0 means unlimited; the unit is MB. The media referenced by one article cannot exceed it.',
  '0 表示不限；按 MB 计。单个视频或附件超过后会被拒绝。':
    '0 means unlimited; the unit is MB. A single video or attachment above it is refused.',

  // ---- 部署片段 ----
  '部署片段': 'Deployment snippet',
  '按已保存的策略生成；指向全局策略的用途不写变量，密钥只来自下面的输入框。':
    'Generated from the saved strategies; scopes pointing at the global strategy emit no variables, and the secret only comes from the field below.',
  '复制 .env': 'Copy .env',
  'Secret Key（仅本次）': 'Secret Key (this session only)',
  '仅本次': 'This session only',
  '只在本页内存里保留': 'Kept in this page’s memory only',
  '只用于生成 .env 片段，不写入浏览器配置，保存后也不会回显；服务器只有一套 STORAGE_S3_SECRET_KEY，所有云策略共用它。':
    'Used only to generate the .env snippet. It is not written to the browser config and is not shown again after saving; the server has a single STORAGE_S3_SECRET_KEY that every cloud strategy shares.',
  '保存不会让服务器立刻换存储': 'Saving does not switch storage on the server right away',
  '切换存储不会自动搬运已有文件：旧目录里的图片仍在旧目录，旧桶里的对象仍在旧桶，':
    'Switching storage never moves existing files: images in the old directory stay there, objects in the old bucket stay there,',
  '需要自己用 rclone / aws s3 sync 之类同步，或继续保留旧路径。':
    'so sync them with something like rclone / aws s3 sync, or keep the old paths.',

  // ---- 右侧「当前配置」 ----
  '当前配置': 'Current configuration',
  '策略数量': 'Strategy count',
  '上传提示': 'Upload hint',

  // ---- 右侧「切换存储的顺序」与 danger zone ----
  '切换存储的顺序': 'Order for switching storage',
  '先备份，再切换。': 'Back up first, then switch.',
  '备份本地 data/media 目录，或记下旧桶名与前缀。':
    'Back up the local data/media directory, or note the old bucket name and prefix.',
  '保存修改，复制下方的 .env 片段。':
    'Save the changes and copy the .env snippet below.',
  '把片段写进服务器 .env，重启 API（不是刷新后台）。':
    'Write the snippet into the server .env and restart the API (not just refresh the dashboard).',
  '上传图片验证；必要时用 rclone 迁移已有文件。':
    'Upload an image to verify; migrate existing files with rclone if needed.',
  '确认前台图片正常后，再清理旧目录或旧桶。':
    'Once images on the site look right, clean up the old directory or bucket.',
  '恢复默认储存策略': 'Restore the default storage strategies',
  '回到一套「本地储存」（./data/media），四个用途都指向它；不会删除文件，也不会修改服务器的 .env。':
    'Back to a single “Local storage” strategy (./data/media) that all four scopes point at; no files are deleted and the server .env is untouched.',
  '恢复默认': 'Restore defaults',

  // ---- 新建 / 编辑弹窗 ----
  '编辑储存策略': 'Edit storage strategy',
  '保存这套策略': 'Save this strategy',
  '添加这套策略': 'Add this strategy',
  '必填且不能与已有策略重名，最多 {max} 个字符。':
    'Required and must differ from every existing strategy; at most {max} characters.',
  '例如：图床 COS': 'For example: image CDN bucket',
  '本地储存写这台服务器的磁盘；云对象存储需要兼容 S3 接口。':
    'Local storage writes to this server’s disk; cloud object storage must speak the S3-compatible API.',
  '本地目录': 'Local directory',
  '相对路径基于 API 进程的工作目录；Windows 一键包默认在 exe 同目录的 data/media。备份或迁移只需拷贝这个目录。':
    'Relative paths resolve against the API process working directory; the Windows bundle defaults to data/media next to the exe. A backup or migration is just a copy of this directory.',
  '桶名（Bucket）': 'Bucket name',
  '云策略必填；服务端启动时会尝试创建缺失的桶。':
    'Required for a cloud strategy; the server tries to create missing buckets at startup.',
  '对象前缀': 'Object prefix',
  '同一个桶放多个站点时用来隔离对象键，例如 practacu/；留空写在桶根。':
    'Separates object keys when several sites share one bucket, for example practacu/; leave it empty to write at the bucket root.',
  'AWS 留空；MinIO 填 http://127.0.0.1:9000，阿里云 OSS / 腾讯云 COS 填各自 S3 兼容地址。':
    'Leave it empty for AWS; use http://127.0.0.1:9000 for MinIO, and the S3-compatible address for Alibaba Cloud OSS or Tencent Cloud COS.',
  '区域（Region）': 'Region',
  'AWS 填实际区域，例如 ap-southeast-1；MinIO 等也要求一个值，通常保持 us-east-1。':
    'For AWS use the real region, for example ap-southeast-1; MinIO and similar also need a value, usually us-east-1.',
  '可以保存在本地安装配置里；建议使用只允许该桶读写的子账号。':
    'It can be stored in the local install config; prefer a sub-account that may only read and write this bucket.',
  '公开访问地址（可选）': 'Public base URL (optional)',
  '仅用于记录与排查，API 不读取这个值；公开读权限、CDN 与防盗链由桶策略决定。':
    'Recorded for reference and troubleshooting only; the API never reads it. Public read access, CDN, and hotlink protection come from the bucket policy.',
  '公开访问与防盗链由桶策略或 CDN 决定':
    'Public access and hotlink protection come from the bucket policy or CDN',
  '对象存储默认是私有的；需要前台直接引用图片时，要么给桶开只读策略，要么在桶前面挂 CDN / 自定义域名。':
    'Object storage is private by default; to reference images directly from the site, either give the bucket a read-only policy or put a CDN / custom domain in front of it.',
  'Secret Key 不在这里填写：它只留在页面内存里，只用于生成 .env 片段。':
    'The Secret Key is not entered here: it stays in page memory only, solely to generate the .env snippet.',

  // ---- 删除弹窗与保存提示 ----
  '删除储存策略': 'Delete storage strategy',
  '确定删除「{name}」吗？': 'Delete “{name}”?',
  '有用途正在使用这套策略': 'A scope is using this strategy',
  '删除后这些用途会回落到第一套策略「{name}」：':
    'After deleting, these scopes fall back to the first strategy “{name}”:',
  '没有用途在使用这套策略，删除不会改变上传位置。':
    'No scope uses this strategy, so deleting it does not change any upload location.',
  '删除只改这台电脑的配置，不会删除任何文件，也不会修改服务器的 .env；已经上传的文件仍留在原位置。':
    'Deleting only changes the config on this computer: no files are removed and the server .env is untouched; already-uploaded files stay where they are.',
  '已删除储存策略「{name}」': 'Deleted storage strategy “{name}”',
  '引用它的用途已经回落到第一套策略，点「保存修改」后生效；不会删除任何文件。':
    'The scopes that used it fell back to the first strategy, taking effect after “Save changes”; no files were deleted.',
  '已更新储存策略': 'Storage strategies updated',
  '点右上角「保存修改」写入这台电脑的本地安装配置；部署片段也会随之更新。':
    'Click “Save changes” in the top right to write it to this computer’s local install config; the deployment snippet updates too.',

  // ---- 校验与保存 ----
  '名称不能为空。': 'The name cannot be empty.',
  '名称最多 {max} 个字符。': 'The name can be at most {max} characters.',
  '已经有一套同名策略了。': 'A strategy with this name already exists.',
  '云对象存储必须有桶名。': 'Cloud object storage needs a bucket name.',
  '这套储存策略还不能保存': 'This storage strategy cannot be saved yet',
  '请先修正弹窗里标红的字段。': 'Fix the highlighted fields in the dialog first.',
  '云策略「{name}」缺少桶名': 'Cloud strategy “{name}” is missing a bucket name',
  'STORAGE_DRIVER=s3 时桶名必填，API 启动会直接拒绝这组环境变量。':
    'STORAGE_S3_BUCKET is required when STORAGE_DRIVER=s3; the API refuses these environment variables at startup.',
  'Endpoint 格式不对': 'Endpoint format is invalid',
  '策略「{name}」的 Endpoint {error}': 'Endpoint of strategy “{name}”: {error}',
  '公开访问地址格式不对': 'Public base URL format is invalid',
  '策略「{name}」的公开访问地址{error}': 'Public base URL of strategy “{name}”: {error}',
  '储存策略已保存': 'Storage strategies saved',
  '已写入这台电脑的本地安装配置；把下方片段写进服务器 .env 并重启 API 之后，新的上传才会写到目标位置。':
    'Written to the local install config on this computer; only after you put the snippet below into the server .env and restart the API will new uploads go to the new location.',
  '已恢复默认储存策略': 'Default storage strategies restored',
  '回到一套「本地储存」（./data/media），四个用途都指向它；不会删除任何文件，也不会修改服务器的 .env。':
    'Back to a single “Local storage” strategy (./data/media) that all four scopes point at; no files are deleted and the server .env is untouched.',

  // ---- 各用途的储存策略 ----
  '每个用途可以只用一套策略，也可以分配多套并设置各自的容量上限。':
    'Each scope can use one strategy, or several with individual capacity caps.',
  '分配方式': 'Allocation mode',
  '单策略': 'Single strategy',
  '多策略': 'Multiple',
  '多策略 · 容量切换': 'Multiple · capacity switch',
  '只使用一套策略，最省心。': 'Use one strategy; the simplest option.',
  '按顺序使用多套策略；前一套达到容量上限后，按「写满后」的规则处理。':
    'Use several strategies in order; when one reaches its cap, the “When full” rule decides what happens.',
  '策略顺序': 'Strategy order',
  '容量上限': 'Capacity cap',
  '写满后': 'When full',
  '自动切换到下一套': 'Switch to the next automatically',
  '停止写入并提示': 'Stop writing and warn',
  '按顺序写入；前面的策略写满后才会使用下一套。容量上限只作用于这个用途。':
    'Writes in order; the next strategy is used only after the previous one is full. The cap applies to this scope only.',
  '第 {index} 套策略': 'Strategy {index}',
  '上移': 'Move up',
  '下移': 'Move down',
  '移除这套策略': 'Remove this strategy',
  '添加一套策略': 'Add a strategy',
  '0 表示不限容量': '0 means unlimited',
  '合计 {size} GB': 'Total {size} GB',
  '含不限容量': 'Includes unlimited capacity',
  '当前顺序：{order}': 'Current order: {order}',
  '{count} 套策略 · {multi} 个用途多策略':
    '{count} strategies · {multi} scopes with multiple strategies',
  '这套策略已经在当前用途里了。': 'This strategy is already in this scope.',
  '同一个用途里每套策略只能出现一次，可以先用上移 / 下移调整顺序。':
    'Each strategy can appear only once per scope; use Move up / Move down to reorder them first.',
  '至少保留一套策略。': 'Keep at least one strategy.',
  '要把这个用途改回单策略，可以切换「分配方式」。':
    'To switch this scope back to a single strategy, change “Allocation mode”.',
  '这个用途已经分配了 {max} 套策略': 'This scope already has {max} strategies',
  '移除一套不再使用的策略后再添加。': 'Remove a strategy you no longer use, then add another.',
  '当前用途没有可添加的策略了。': 'No more strategies can be added to this scope.',
  '先新建一套储存策略，或移除一套已有的策略。':
    'Create a new storage strategy first, or remove one already assigned.',
  '多策略按顺序切换': 'Multiple strategies switch in order',
  '每个用途的第一套是主策略；达到容量上限后，按「写满后」的规则切换到下一套或停止。':
    'The first strategy in each scope is the primary one; when it reaches its cap, the “When full” rule switches to the next or stops.',
  '容量上限按用途单独记录，不改变策略本身的存储位置。':
    'Capacity caps are recorded per scope and do not change where a strategy stores files.',
  '每套策略就是一个存储目标；被最多用途使用的那套会标记为全局策略。':
    'Each strategy is one storage target; the one used by the most scopes is marked as the global strategy.',
  '本页只写入这台电脑的本地安装配置，不会改动服务器上的文件或凭据。':
    'This page only writes the local install config on this computer; it does not touch files or credentials on the server.',
  '服务器最终使用哪套存储，仍由部署时的存储配置决定；演示模式与真实后端行为一致。':
    'Which storage the server actually uses is still decided by the storage config at deployment time; demo mode behaves like a real backend.',
  '服务器目前只支持一套云凭据；多套云策略需要部署方另行提供 endpoint、区域与 Access Key。':
    'The server currently supports one set of cloud credentials; multiple cloud strategies need the deployer to provide the endpoint, region, and Access Key separately.',
  '引用它的用途已经从分配里移除，空出来的位置回落到第一套策略；改动会自动保存，不会删除任何文件。':
    'The scopes using it have removed it from their assignments and the freed slots fall back to the first strategy; the change is saved automatically and no files are deleted.',
  '没有用途在使用这套策略，删除不会改变上传位置，也不会删除任何文件。':
    'No scope uses this strategy; deleting it changes no upload location and removes no files.',
  '删除后这些用途里的这套策略会被移除，空出来的位置回落到第一套策略「{name}」：':
    'After deleting, this strategy is removed from these scopes and the freed slot falls back to the first strategy “{name}”:',
  '删除只改这台电脑的配置，不会删除任何文件，也不会修改服务器的存储配置；已经上传的文件仍留在原位置。':
    'Deleting only changes this computer’s config: no files are removed, the server storage config is untouched, and uploaded files stay where they are.',
  '改动会自动写入这台电脑的本地安装配置。':
    'The change is saved automatically to this computer’s local install config.',
  '回到一套「本地储存」（./data/media），四个用途都改为单策略并指向它；不会删除文件，也不会修改服务器的存储配置。':
    'Back to a single “Local storage” strategy (./data/media) that all four scopes use in single-strategy mode; no files are deleted and the server storage config is untouched.',

  // ---- 运行期储存与立即应用 ----
  '保存后立即生效': 'Takes effect as soon as you save',
  '平台管理员保存后会自动应用：服务器把设置写进 data/storage-settings.json 并马上换用，无需重启；这个文件优先于 .env 里的 STORAGE_* 变量。':
    'When a platform admin saves, the settings are applied automatically: the server writes them to data/storage-settings.json and switches over at once, with no restart; that file takes precedence over STORAGE_* in .env.',
  '容量上限与多策略切换由服务端在写入时执行；已有文件不会自动迁移，旧目录或旧桶里的对象仍在原处。':
    'Capacity caps and multi-strategy switching are enforced by the server at write time; existing files are not migrated, and objects in the old directory or bucket stay where they are.',
  '应用中…': 'Applying…',
  '已生效': 'In force',
  '待应用': 'Not applied yet',
  '应用失败': 'Apply failed',
  '立即应用': 'Apply now',
  '立即应用失败': 'Applying immediately failed',
  '已保存并立即生效': 'Saved and applied immediately',
  '服务器已换用新设置并写进 data/storage-settings.json；已有文件不会自动迁移。':
    'The server switched to the new settings and wrote them to data/storage-settings.json; existing files are not migrated.',
  '无法读取服务端的储存状态': 'Cannot read the server storage status',
  '部署片段（备用）': 'Deployment snippet (fallback)',
  '片段只描述位置与驱动，不含任何密钥；旧后端或没有运行期应用权限时，把它写进 API 的 .env 再重启，新的上传才会写到这些位置。':
    'The snippet describes only locations and drivers and contains no credentials; on an old backend or without runtime-apply permission, write it into the API .env and restart for new uploads to land in these locations.',
  '「立即应用」不可用': '“Apply now” is unavailable',
  '保存后自动应用，失败可以重试': 'Saved settings are applied automatically; failures can be retried',
  '保存成功会自动调用「立即应用」；失败时保留原来的生效状态，页面上会出现错误原因与重试按钮。':
    'A successful save calls “Apply now” automatically; on failure the previous effective state is kept, and the page shows the reason plus a retry button.',
  '演示模式只在本地保存策略，不会真的切换服务器存储；真实后端里的平台管理员保存后会立即应用。':
    'Demo mode only saves strategies locally and never switches the server’s storage; on a real backend a platform admin applies the settings right after saving.',
  '只有平台管理员可以立即应用；保存只写入这台电脑的本地安装配置，服务器继续使用部署环境变量或之前应用过的设置。':
    'Only platform admins can apply immediately; saving only writes the local install config on this computer, and the server keeps using the deployment environment variables or the settings applied before.',
  '这个后端没有立即应用接口；保存只写本地安装配置，需要把部署片段写进服务器再重启。':
    'This backend has no immediate-apply endpoint; saving only writes the local install config, so put the deployment snippet into the server and restart.',

  // ---- 服务端配额与用量 ----
  '已用 {size}': 'Used {size}',
  '当前写入': 'Current write target',
  '服务端用量：{usage}': 'Server usage: {usage}',
  '多策略由服务端按顺序写入': 'Multiple strategies are written in order by the server',
  '保存后服务端按写入顺序使用每套策略：单策略忽略配额；多策略时前一套写满（quota_gb，0 表示不限）后，按「写满后」的规则停止或切到下一套。':
    'After saving, the server uses the strategies in write order: single mode ignores the cap; in multi mode, once a strategy is full (quota_gb, 0 = unlimited) the “When full” rule stops or switches to the next one.',
  '所有策略都写满时，新的上传会失败并返回 storage_quota_exceeded（507）。':
    'When every strategy is full, new uploads fail with storage_quota_exceeded (507).',
  '这个用途可以只用一套策略，也可以按顺序分配多套并设置容量上限；点「完成」保存并应用，直接关闭不会保存。':
    'This scope can use one strategy, or several in order with capacity caps; choose “Done” to save and apply, or close without saving.',
  '只使用一套策略，最省心；单策略模式下配额不生效。':
    'Use one strategy; the simplest option. Capacity caps do not apply in single mode.',
  '按写入顺序使用多套策略；服务端在前一套写满（quota_gb）后，按「写满后」的规则停止或切换。':
    'Use several strategies in write order; the server follows the “When full” rule to stop or switch once a strategy is full (quota_gb).',
  '由服务端在写入时执行：按顺序写入，前面的策略写满后才会使用下一套；容量上限只作用于这个用途。':
    'Enforced by the server at write time: writes go in order and the next strategy is used only after the previous one is full; the cap applies to this scope only.',

  // ---- Secret Key ----
  'Secret Key（可选）': 'Secret Key (optional)',
  '留空沿用服务器已保存密钥': 'Leave empty to keep the secret saved on the server',
  '服务器已保存密钥': 'Secret saved on the server',
  '缺少密钥': 'Secret missing',
  '新密钥待应用': 'New secret pending',
  '只用于「立即应用」这一次请求，不会写入这台电脑的配置；留空表示沿用服务器已保存的密钥。':
    'Used only for this one apply request and never written to the config on this computer; leave it empty to keep the secret already saved on the server.',
  '会保存在本地安装配置里，并随应用请求提交；建议使用只允许该桶读写的子账号。':
    'Stored in the local install config and sent with the apply request; prefer a sub-account that may only read and write this bucket.',
  '策略名会出现在各用途的选择里；Secret Key 只保存在本页内存，仅随「立即应用」提交一次。':
    'The strategy name appears in each scope’s selection; the Secret Key stays in this page’s memory and is submitted once with “Apply now”.',
  '删除只改这份储存设置，下一次保存 / 应用后服务端才会换用新顺序；不会删除任何文件，已经上传的文件仍留在原位置。':
    'Deleting only changes this storage setting; the server switches to the new order on the next save / apply. No files are deleted and uploaded files stay where they are.',
};

export default fragment;
