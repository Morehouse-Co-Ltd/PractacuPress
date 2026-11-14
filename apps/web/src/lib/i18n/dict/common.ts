import type { Dictionary } from '../plural';

/**
 * 跨页面复用的常用词。
 *
 * 规则：一个中文词如果只在某个页面出现，就写进那个页面的命名空间；
 * 只有真正到处都在用的（保存、取消、删除……）才放这里，避免同一句话两种译法。
 *
 * 各命名空间展开顺序在 `dict/index.ts`；后展开的会覆盖先展开的同名键，
 * 所以**不要在业务命名空间里重复定义这里的键**。
 */
const common: Dictionary = {
  保存: 'Save',
  保存修改: 'Save changes',
  保存中: 'Saving',
  取消: 'Cancel',
  关闭: 'Close',
  删除: 'Delete',
  确定: 'Confirm',
  编辑: 'Edit',
  新建: 'New',
  添加: 'Add',
  移除: 'Remove',
  返回: 'Back',
  上一步: 'Back',
  下一步: 'Next',
  完成: 'Done',
  跳过: 'Skip',
  重试: 'Retry',
  刷新: 'Refresh',
  重新加载: 'Reload',
  搜索: 'Search',
  全部: 'All',
  加载中: 'Loading',
  正在载入: 'Loading',
  暂无数据: 'No data yet',
  没有数据: 'No data yet',
  复制: 'Copy',
  已复制: 'Copied',
  已复制到剪贴板: 'Copied to clipboard',
  预览: 'Preview',
  预览站点: 'View site',
  设置: 'Settings',
  名称: 'Name',
  描述: 'Description',
  状态: 'Status',
  操作: 'Actions',
  类型: 'Type',
  时间: 'Time',
  详情: 'Details',
  确认: 'Confirm',
  是: 'Yes',
  否: 'No',
  开启: 'On',
  关闭开关: 'Off',
  启用: 'Enable',
  禁用: 'Disable',
  保存成功: 'Saved',
  保存失败: 'Save failed',
  已自动保存: 'Saved automatically',
  '正在自动保存…': 'Saving automatically…',
  修改会自动保存: 'Changes are saved automatically',
  修改会在停止输入后自动保存: 'Changes are saved automatically after you stop typing',
  自动保存失败: 'Auto-save failed',
  操作失败: 'Something went wrong',
  请求失败: 'Request failed',
  未知错误: 'Unknown error',
  访客: 'Guest',
  返回站点: 'Back to site',
  回到后台: 'Back to dashboard',
  '共 {count} 篇文章': { one: '1 article', other: '{count} articles' },
  '{count} 条评论': { one: '1 comment', other: '{count} comments' },
  佚名: 'Anonymous',
};

export default common;
