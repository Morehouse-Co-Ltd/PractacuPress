import type { Dictionary } from '../../plural';

/**
 * 来源：`web/src/components/ArticleCoverPanel.tsx`
 *
 * Beta 1.2 起封面是内容字段（`cover_url` 等随 `DraftInput` 提交），不再写进
 * `SiteCustomization.covers`，所以这里与「配置 / 导出配置」相关的旧文案已经换掉。
 */
const fragment: Dictionary = {
  居中: 'Center',
  顶部: 'Top',
  底部: 'Bottom',
  已清除封面: 'Cover cleared',
  '这篇内容会重新使用自动生成的封面。': 'This content will use the generated cover again.',
  '这个地址不能用作封面，请换成图片地址或直接上传图片。':
    'That address cannot be used as a cover; use an image URL or upload an image instead.',
  封面已更新: 'Cover updated',
  '保存后，列表、首页卡片与详情页都会使用这张图片。':
    'After you save, the list, home page cards, and detail page will use this image.',
  '请选择图片文件（PNG / JPEG / WebP / GIF）。': 'Choose an image file (PNG / JPEG / WebP / GIF).',
  '演示模式把图片以 data URL 存进内容字段，请选择 600 KB 以内的图片。':
    'Demo mode stores images as data URLs in the content fields, so choose an image under 600 KB.',
  '服务端没有返回图片地址。': 'The server did not return an image URL.',
  '上传结果不能用作封面地址。': 'The uploaded file cannot be used as a cover URL.',
  '演示模式的图片保存在浏览器里，导出内容时会一起带走。':
    'Demo mode images are saved in the browser and travel along when you export the content.',
  '已使用上传的图片。': 'The uploaded image is now in use.',
  '上传失败。': 'Upload failed.',
  上传失败: 'Upload failed',
  已隐藏: 'Hidden',
  自定义: 'Custom',
  自动生成: 'Generated',
  封面: 'Cover',
  '随内容保存：列表、首页卡片、订阅源与分享卡都用这张图片。':
    'Saved with the content: the list, home page cards, feeds, and share cards all use this image.',
  '先保存草稿，之后可以给这篇内容设置封面。':
    'Save a draft first; after that you can give this content a cover.',
  '当前账户没有编辑权限，只能查看封面字段。':
    'This account cannot edit, so the cover fields are read-only.',
  封面已隐藏: 'Cover hidden',
  '前台列表与详情页都不显示封面；取消勾选即可恢复。':
    'The site list and detail page hide the cover; clear the checkbox to bring it back.',
  未命名: 'Untitled',
  图片地址: 'Image URL',
  '可以粘贴 http(s) 地址、站内路径或图片 data URL（含 SVG）；直接上传的图片建议 600 KB 以内。':
    'You can paste an http(s) URL, a site path, or an image data URL (SVG included); images you upload directly should be under 600 KB.',
  '支持 http(s) 图片地址、以 / 开头的站内路径与 data:image（含 SVG），也可以直接上传图片。':
    'Supports http(s) image URLs, site paths starting with /, and data:image (SVG included); you can also upload an image directly.',
  'https://… 或 /uploads/cover.jpg': 'https://… or /uploads/cover.jpg',
  应用: 'Apply',
  '图片描述': 'Image description',
  '给屏幕阅读器与社交分享卡用的替代文本；留空则使用标题。':
    'Alternative text for screen readers and social share cards; the title is used when it is empty.',
  '描述这张图片': 'Describe this image',
  上传图片: 'Upload image',
  '上传中 {progress}%': 'Uploading {progress}%',
  '演示模式：图片以 data URL 保存，建议 600 KB 以内。':
    'Demo mode: images are saved as data URLs; 600 KB or smaller is recommended.',
  'PNG / JPEG / WebP / GIF / SVG；上传后由服务端检查。':
    'PNG / JPEG / WebP / GIF / SVG; the server checks the file after upload.',
  焦点位置: 'Focal point',
  图片焦点位置: 'Image focal point',
  隐藏封面: 'Hide cover',
  '列表与详情页都不显示封面；设置会保留，随时可以恢复。':
    'The list and detail page hide the cover; the setting is kept and can be restored anytime.',
  清除封面: 'Clear cover',
  '当前使用自定义图片。': 'Currently using a custom image.',
  '当前封面已隐藏。': 'The cover is currently hidden.',
  '当前使用自动生成的装饰封面。': 'Currently using a generated decorative cover.',
};

export default fragment;
