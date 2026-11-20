import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/BackupSchedule.tsx`（从 ActivityOperations.tsx 拆出） */
const fragment: Dictionary = {
  自动备份计划: 'Automatic backup schedule',
  '计划来自部署环境变量，页面只读。':
    'The schedule comes from deployment environment variables; this page is read-only.',
  已启用: 'Enabled',
  未启用: 'Not enabled',
  自动备份未启用: 'Automatic backups are not enabled',
  '未启用，需在部署环境变量中开启。':
    'Not enabled. Turn it on with the deployment environment variables.',
  每天运行: 'Runs daily',
  服务器本地时间: "Server's local time",
  保留份数: 'Copies kept',
  超出后删除最旧的备份: 'The oldest copies are removed first',
  上次运行: 'Last run',
  下次运行: 'Next run',
  从未运行过: 'Never run yet',
  按每日计划自动执行: 'Runs automatically on the daily schedule',
  计划未启用: 'Schedule is off',
  上次运行失败: 'The last run failed',
  备份产物: 'Backup artifacts',
  '保留最近 {count} 份自动备份。': {
    one: 'Keeping the most recent automatic backup.',
    other: 'Keeping the most recent {count} automatic backups.',
  },
  文件名: 'File name',
  大小: 'Size',
  创建时间: 'Created',
  '还没有自动备份产物。': 'No automatic backup artifacts yet.',
  无法读取备份计划: 'Could not load the backup schedule',
  成功: 'Success',
  失败: 'Failure',
};

export default fragment;
