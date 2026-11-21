import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/site/Profile.tsx` */
const fragment: Dictionary = {
  // ---- 主页元信息与标题 ----
  未知用户: 'Unknown member',
  '{name} 在 {site} 主页与已发布内容。': '{name}’s profile and published work on {site}.',
  '加入于 {date} · {site}': 'Joined {date} · {site}',

  // ---- 主页操作 ----
  我的通知: 'My notifications',
  我的互动: 'My activity',
  关注: 'Follow',
  登录后关注: 'Sign in to follow',
  编辑资料: 'Edit profile',
  修改密码: 'Change password',

  // ---- 邮箱状态 ----
  邮箱状态: 'Email status',
  已验证: 'Verified',
  未验证: 'Unverified',
  发送验证邮件: 'Send verification email',
  邮箱已经验证过了: 'This email is already verified',
  '验证邮件已发送，请查收': 'Verification email sent, please check your inbox',
  发送验证邮件失败: 'Could not send the verification email',

  // ---- 资料编辑弹窗 ----
  '昵称、简介与头像会立即显示在你的公开主页上。':
    'Your name, bio and avatar appear on your public profile immediately.',
  昵称: 'Display name',
  简介: 'Bio',
  '最多 2000 个字符。': 'Up to 2000 characters.',
  '用一两句话介绍自己。': 'Introduce yourself in a sentence or two.',
  头像: 'Avatar',
  '只能选择你上传并通过检查的图片。':
    'Only images you uploaded and that passed inspection can be used.',
  移除头像: 'Remove avatar',
  '上传中…': 'Uploading…',
  上传头像: 'Upload avatar',
  头像素材: 'Avatar asset',
  保存: 'Save',
  取消: 'Cancel',
  昵称不能为空: 'Display name cannot be empty',
  资料已更新: 'Profile updated',
  保存失败: 'Could not save',
  头像已上传: 'Avatar uploaded',
  上传失败: 'Upload failed',

  // ---- 修改密码弹窗 ----
  '需要先验证当前密码。保存后，其他设备上的登录会被注销。':
    'Confirm your current password first. Saving signs out your other devices.',
  当前密码: 'Current password',
  新密码: 'New password',
  '至少 12 位，需要包含两类字符，且不能是常见弱口令。': 'At least 12 characters and two character classes, and not a common password.',
  确认新密码: 'Confirm new password',
  更新密码: 'Update password',
  请输入当前密码: 'Enter your current password',
  两次输入的新密码不一致: 'The new passwords do not match',
  '密码已更新，其他设备已下线': 'Password updated; other devices were signed out',
  修改密码失败: 'Could not change the password',

  // ---- 资料统计 ----
  加入时间: 'Joined',
  本人: 'You',
  未关注: 'Not following',
  关注状态: 'Follow status',

  // ---- 已发布内容列表 ----
  我的文章与帖子: 'My articles and posts',
  'TA 的文章与帖子': 'Their articles and posts',
  '{count} 篇': { one: '1 entry', other: '{count} entries' },
  还没有已发布的内容: 'Nothing published yet',
  '草稿与被退回的稿子不会出现在公开主页。':
    'Drafts and rejected drafts never appear on the public profile.',

  // ---- 主页不可用 ----
  无法打开这个主页: 'Cannot open this profile',
  '这位成员不在当前站点里，或主页还没有公开。':
    'This member is not on this site, or the profile is not public yet.',

  // ---- 邮件订阅（/me/newsletter） ----
  邮件订阅: 'Email newsletter',
  '订阅后，本站发布新内容时会通过邮件通知你，可以随时退订。':
    'Once subscribed, new posts on this site arrive by email; you can unsubscribe at any time.',
  '暂时读不到订阅状态，请稍后刷新。':
    'The subscription state cannot be loaded right now; refresh to try again.',
  '这个账户还没有可用的邮箱，暂时无法订阅邮件。':
    'This account has no usable email address yet, so it cannot subscribe to the newsletter.',
  接收本站邮件: 'Send me this site’s email',
  '新内容发布时会发到账户邮箱；随时可以退订。':
    'New posts are mailed to the account address; unsubscribe at any time.',
  '请到邮箱点击确认链接': 'Please click the confirmation link in your email',
  '确认之后才会收到本刊邮件。': 'You will only receive the newsletter after confirming.',
  已退订: 'Unsubscribed',
  已订阅: 'Subscribed',
  '这个邮箱不会再收到本站的邮件。':
    'This address will no longer receive email from this site.',
  '新的发布内容会通过邮件通知你。': 'New posts will be emailed to you.',
  '请输入新密码': 'Enter a new password.',
};

export default fragment;
