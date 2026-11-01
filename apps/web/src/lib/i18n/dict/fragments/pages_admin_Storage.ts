import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Storage.tsx` */
const fragment: Dictionary = {
  '存储策略': 'Storage strategy',
  '保存只是写配置，部署才算切换': 'Saving only writes config; deploying is what switches',
  '站点管理员': 'Site admin',
  '媒体库': 'Media library',
  '存储策略已保存': 'Storage strategy saved',
  '已恢复默认存储策略': 'Default storage strategy restored',
  '放弃未保存的修改': 'Discard unsaved changes',
  '没有未保存的修改': 'No unsaved changes',
  '恢复默认': 'Restore defaults',
  '恢复默认存储策略': 'Restore the default storage strategy',
  '打开媒体库': 'Open media library',
  '性能优化': 'Performance',

  '本地存储': 'Local storage',
  '云对象存储': 'Cloud object storage',
  '本地磁盘': 'Local disk',
  '沿用全局': 'Use global setting',
  '文章媒体': 'Article media',
  '站点图片': 'Site images',
  '用户头像': 'User avatars',
  '用户数据 / 附件': 'User data / attachments',
  '用户数据/附件': 'User data/attachments',
  '全部沿用全局': 'All use the global setting',
  '仅本次': 'This session only',
  '只在本页内存里保留': 'Kept in this page’s memory only',
  '未填写桶': 'No bucket set',
  'AWS 默认': 'AWS default',
  'Access Key 已保存': 'Access Key saved',
  '未填写（实例角色）': 'Not set (instance role)',
  '由桶策略 / CDN 决定': 'Set by the bucket policy / CDN',

  '文章与帖子里插入的图片、封面等；正文本身不在媒体存储里。':
    'Images, cover art, and similar files inserted into articles and posts; the body text itself is not kept in media storage.',
  '站点图标、分享图与首页编排引用的站点级图片。':
    'The site icon, share images, and site-level images referenced by the home page layout.',
  '成员头像；访问频繁、体积小，可以单独放本地或 CDN 桶。':
    'Member avatars; they are small and read often, so they can live in a local folder or a CDN bucket of their own.',
  '用户上传的附件与私有数据，通常需要鉴权后才能访问。':
    'Attachments and private data uploaded by users, which usually need authentication to reach.',

  '留空时由服务器使用「全局目录 / 用途名」（约 {dir}/content 等）；建议显式填写。':
    'When empty the server uses “global directory / scope name” (about {dir}/content and so on); filling it in explicitly is recommended.',
  '云端存储需要桶名': 'Cloud storage needs a bucket name',
  'STORAGE_S3_BUCKET 在 STORAGE_DRIVER=s3 时是必填项，API 启动会直接拒绝这组环境变量。':
    'STORAGE_S3_BUCKET is required when STORAGE_DRIVER=s3; the API refuses these environment variables at startup.',
  'Endpoint 格式不对': 'Endpoint format is invalid',
  'Endpoint {error}': 'Endpoint {error}',
  '公开访问地址格式不对': 'Public base URL format is invalid',
  '公开访问地址{error}': 'Public base URL {error}',
  '{scope}缺少桶名': '{scope} is missing a bucket name',
  '选择了云对象存储后必须填写桶名（STORAGE_{scope}_S3_BUCKET），否则这组分用途变量无法部署。':
    'Once cloud object storage is selected, the bucket name is required (STORAGE_{scope}_S3_BUCKET); without it these per-scope variables cannot be deployed.',
  '选择已写入这台电脑的本地安装配置；把下方片段写进服务器 .env 并重启 API 之后，新的上传才会写到目标位置。':
    'The choice is written to the local install config on this computer; only after you put the snippet below into the server .env and restart the API will new uploads go to the new location.',
  '回到本地 ./data/media，所有用途都沿用全局；不会删除任何文件，也不会修改服务器的 .env。':
    'Back to local ./data/media with every scope on the global setting; no files are deleted and the server .env is untouched.',
  '回到本地 ./data/media 且所有用途沿用全局；不会删除文件，也不会修改服务器的 .env。':
    'Back to local ./data/media with every scope on the global setting; no files are deleted and the server .env is untouched.',

  '决定上传的图片与附件写到哪里：这台服务器的本地目录，或任何 S3 兼容的云对象存储。':
    'Decides where uploaded images and attachments are written: a local directory on this server, or any S3-compatible cloud object storage.',
  '全局设置之外，还可以按用途单独覆盖。浏览器只能保存部署意图，真正生效要靠服务器上的':
    'Beyond the global setting, each scope can be overridden. The browser can only record the deployment intent; what actually takes effect depends on the server’s',
  '与重启 API。': 'and on an API restart.',
  '本页只写入这台电脑的本地安装配置，并把选择翻译成可粘贴的 API':
    'This page only writes the local install config on this computer and turns the choice into a paste-ready API',
  '片段；服务器需要把片段写进': 'snippet; the server needs that snippet in its',
  '并重启 API 才生效。演示模式与真实后端行为一致：':
    'and the API restarted before it takes effect. Demo mode behaves like a real backend:',
  '都可以保存与生成片段，但演示模式没有真正的服务端进程可重启。':
    'both can save and generate the snippet, but demo mode has no real server process to restart.',

  '全局存储位置': 'Global storage location',
  '分用途没有单独覆盖时，所有上传都沿用这里。':
    'When a scope has no override of its own, every upload uses this.',
  '本地目录': 'Local directory',
  '相对路径基于 API 进程的工作目录；Windows 一键包默认在 exe 同目录的 data/media。备份或迁移只需拷贝这个目录。':
    'Relative paths resolve against the API process working directory; the Windows bundle defaults to data/media next to the exe. A backup or migration is just a copy of this directory.',
  '适合单机与 Windows 一键包': 'A good fit for a single machine and the Windows bundle',
  '本地存储没有额外的网络依赖，读取最快；但多实例部署时每台机器的磁盘各自独立，':
    'Local storage adds no network dependency and reads fastest; but with multiple instances each machine has its own disk,',
  '上传的文件在另一台机器上「看不到」。多实例请改用云对象存储，或自行挂载共享存储。':
    'so uploaded files are not visible on another machine. With multiple instances, switch to cloud object storage or mount shared storage yourself.',
  '桶名（Bucket）': 'Bucket name',
  's3 模式下必填；服务端启动时会尝试创建缺失的桶。':
    'Required in s3 mode; the server tries to create missing buckets at startup.',
  '区域（Region）': 'Region',
  'AWS 填实际区域，例如 ap-southeast-1；MinIO 等也要求一个值，通常保持 us-east-1。':
    'For AWS use the real region, for example ap-southeast-1; MinIO and similar also need a value, usually us-east-1.',
  'AWS 留空；MinIO 填 http://127.0.0.1:9000，阿里云 OSS / 腾讯云 COS 填各自 S3 兼容地址。':
    'Leave it empty for AWS; use http://127.0.0.1:9000 for MinIO, and the S3-compatible address for Alibaba Cloud OSS or Tencent Cloud COS.',
  '对象前缀': 'Object prefix',
  '同一个桶放多个站点时用来隔离对象键，例如 practacu/；留空写在桶根。':
    'Separates object keys when several sites share one bucket, for example practacu/; leave it empty to write at the bucket root.',
  '可以保存在本地安装配置里；建议使用只允许该桶读写的子账号。':
    'It can be stored in the local install config; prefer a sub-account that may only read and write this bucket.',
  '只用于生成 .env 片段，不写入浏览器配置，保存后也不会回显；所有分用途共享这一份凭据。':
    'Used only to generate the .env snippet. It is not written to the browser config and is not shown again after saving; all scopes share this one credential.',
  '公开访问地址（可选）': 'Public base URL (optional)',
  '仅用于记录与排查，API 不读取这个值；公开读权限、CDN 与防盗链由桶策略决定。':
    'Recorded for reference and troubleshooting only; the API never reads it. Public read access, CDN, and hotlink protection come from the bucket policy.',
  '公开访问与防盗链由桶策略或 CDN 决定':
    'Public access and hotlink protection come from the bucket policy or CDN',
  '对象存储默认是私有的。需要前台直接引用图片时，要么给桶开只读策略，要么在桶前面':
    'Object storage is private by default. To reference images directly from the site, either give the bucket a read-only policy or put',
  '挂 CDN / 自定义域名；本页与 API 都不会替你放开权限。MinIO、阿里云 OSS、腾讯云':
    'a CDN / custom domain in front of it; neither this page nor the API will open up permissions for you. MinIO, Alibaba Cloud OSS, Tencent',
  'COS 等都可以用 S3 兼容模式，只是 endpoint 不同；AWS S3 的 endpoint 留空即可。':
    'COS and similar services all work in S3-compatible mode with only the endpoint differing; for AWS S3 just leave the endpoint empty.',

  '分用途存储': 'Storage by scope',
  '文章媒体、站点图片、头像与用户数据可以单独覆盖全局设置；选择「沿用全局」的用途':
    'Article media, site images, avatars, and user data can override the global setting individually; scopes set to use the global setting',
  '不会生成任何变量。': 'generate no variables at all.',
  '{count} 个覆盖': { one: '1 override', other: '{count} overrides' },
  '必填；endpoint、区域与凭据沿用上面的全局 S3 设置。':
    'Required; the endpoint, region, and credentials come from the global S3 settings above.',
  '留空写在桶根；建议按用途分开，例如 practacu/content。':
    'Leave it empty to write at the bucket root; keeping scopes apart is recommended, for example practacu/content.',
  '沿用上面的全局{driver}{path}。': 'Follows the global {driver}{path} above.',
  '分用途的 S3 覆盖需要服务器有 S3 凭据':
    'Scope-level S3 overrides need S3 credentials on the server',
  '当前全局是本地存储，片段里不会生成':
    'Global storage is local right now, so the snippet will not emit',
  '等全局凭据；分用途的 S3 覆盖会沿用': 'or other global credentials; scope-level S3 overrides reuse',
  '这些值，请确认服务器已经通过 .env 或实例角色另行提供。':
    'those values, so make sure the server provides them another way, through .env or an instance role.',
  '分用途的 S3 只更换桶与前缀': 'A scope-level S3 override only swaps the bucket and prefix',
  '分用途覆盖沿用全局的 endpoint、区域与凭据；切换用途的存储同样不会搬运已有文件，':
    'Scope overrides reuse the global endpoint, region, and credentials; switching a scope’s storage also never moves existing files,',
  '需要自己把旧目录或旧桶里的对象同步到新位置。':
    'so you need to sync the objects from the old directory or bucket to the new location yourself.',

  '文章与帖子正文': 'Article and post body text',
  '正文不是媒体文件，不在本页的存储范围内。':
    'Body text is not a media file and is outside the storage scope of this page.',
  '只读 · 存数据库': 'Read-only · stored in the database',
  '正文存关系数据库：SQLite / MySQL / Postgres':
    'Body text lives in a relational database: SQLite / MySQL / Postgres',
  '标题、Markdown / 富文本正文、分类、评论与成员资料保存在服务端数据库，由':
    'Titles, Markdown / rich-text bodies, categories, comments, and member profiles live in the server database, controlled by',
  '决定；本页的本地目录与 S3 桶只存上传的图片、头像与附件。换数据库需要改服务端环境变量':
    '; the local directory and S3 bucket on this page only store uploaded images, avatars, and attachments. Changing the database means editing the server environment variables',
  '并迁移数据，后台没有对应开关。':
    'and migrating the data; the dashboard has no switch for it.',
  '正文与元数据': 'Body text and metadata',
  '数据库（不在本页）': 'Database (not on this page)',
  '图片 / 头像 / 附件': 'Images / avatars / attachments',
  '本页的存储目标': 'The storage targets of this page',

  '上传体积提示': 'Upload size hint',
  '只用于前端提示，不会改变服务端上限。':
    'A front-end hint only; it does not change the server-side limit.',
  '非服务端参数': 'Not a server-side setting',
  '单文件上限提示': 'Per-file size hint',
  'API 与安全服务默认限制 25 MiB；要传更大的文件，需要同时调整 API 与安全服务，而不是只改这里。':
    'The API and the security service default to a 25 MiB limit; to upload larger files, adjust both of them rather than only changing this value.',
  '超过 API 默认的 25 MiB 附件上限': 'Above the API default of 25 MiB per attachment',
  '这个值只影响页面提示。真正上传大文件前，需要按服务器规格调整 API 与安全服务的':
    'This value only affects the page hint. Before uploading large files for real, adjust the',
  '请求体上限，否则请求会被更早的一层拒绝。':
    'request body limits of the API and the security service to match the server, otherwise the request is rejected by an earlier layer.',

  '部署片段': 'Deployment snippet',
  '按已保存的设置生成；inherit 的用途不写变量，密钥只来自上面的输入框。':
    'Generated from the saved settings; scopes set to inherit emit no variables, and the secret only comes from the field above.',
  '复制 .env': 'Copy .env',
  '保存不会让服务器立刻换存储': 'Saving does not switch storage on the server right away',
  '把片段写进 API 的': 'Put the snippet into the API’s',
  '（或启动器环境变量）并重启后才会生效。':
    '(or the launcher environment variables) and restart before it takes effect.',
  '切换存储不会自动搬运已有文件：旧目录里的图片仍在旧目录，旧桶里的对象仍在旧桶，':
    'Switching storage never moves existing files: images in the old directory stay there, objects in the old bucket stay there,',
  '需要自己用 rclone / aws s3 sync 之类同步，或继续保留旧路径。':
    'so sync them with something like rclone / aws s3 sync, or keep the old paths.',

  '当前配置': 'Current configuration',
  '保存后立即写入本地安装配置。':
    'Written to the local install config as soon as you save.',
  '驱动': 'Driver',
  '位置': 'Location',
  '凭据': 'Credentials',
  '公开访问': 'Public access',
  '分用途覆盖': 'Scope overrides',
  '{count} 个用途': { one: '1 scope', other: '{count} scopes' },
  '上传提示': 'Upload hint',

  '切换存储的顺序': 'Order for switching storage',
  '先备份，再切换。': 'Back up first, then switch.',
  '备份本地 data/media 目录，或记下旧桶名与前缀。':
    'Back up the local data/media directory, or note the old bucket name and prefix.',
  '在本页保存新的存储策略，复制 .env 片段。':
    'Save the new storage strategy on this page and copy the .env snippet.',
  '把片段写进服务器 .env，重启 API（不是刷新后台）。':
    'Write the snippet into the server .env and restart the API (not just refresh the dashboard).',
  '分用途覆盖的 S3 只换桶与前缀，凭据仍用全局 STORAGE_S3_*。':
    'A scope-level S3 override only swaps the bucket and prefix; credentials still come from the global STORAGE_S3_*.',
  '上传图片验证；必要时用 rclone 迁移已有文件。':
    'Upload an image to verify; migrate existing files with rclone if needed.',
  '确认前台图片正常后，再清理旧目录或旧桶。':
    'Once images on the site look right, clean up the old directory or bucket.',
};

export default fragment;
