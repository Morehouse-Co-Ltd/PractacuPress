import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Data.tsx` 与 `components/AdminShell.tsx` 的数据入口 */
const fragment: Dictionary = {
  // ---- 页头 ----
  '数据与备份': 'Data and backups',
  '导出可迁移的 Markdown 与图片，或为整个实例生成可校验的备份包。':
    'Export portable Markdown and images, or create a verifiable package for the whole instance.',
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

  // ---- 恢复 ----
  '恢复': 'Restore',
  '恢复会替换数据库文件，只能在服务停止后由命令行执行。':
    'Restore replaces the database file and can only run from the command line while the service is stopped.',
  '恢复前自动做一次安全备份': 'A safety backup is created before restoring',
  '命令会先校验 manifest 与每个文件的 SHA-256，拒绝覆盖非空库，除非显式加 -Confirm；随后自动备份当前数据，再替换数据库与本地媒体，最后重新应用增量迁移并校验表结构。':
    'The command first verifies the manifest and every file SHA-256 and refuses to replace a non-empty database unless -Confirm is given; it then backs up the current data, replaces the database and local media, reapplies additive migrations and verifies the tables.',
  '在仓库根目录执行：': 'Run from the repository root:',
  'MySQL / PostgreSQL 不使用此命令：请用 mysqldump / pg_dump 备份数据库，媒体目录单独复制。S3 媒体不进入备份包，需要按桶单独备份。':
    'MySQL / PostgreSQL do not use this command: back up the database with mysqldump / pg_dump and copy the media directory separately. S3 media is not packaged and must be backed up per bucket.',
};

export default fragment;
