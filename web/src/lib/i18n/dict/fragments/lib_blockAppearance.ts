import type { Dictionary } from '../../plural';

/**
 * 来源：`web/src/lib/blockAppearance.ts`
 *
 * 圆角档位与「图片圆角」共用同一批中文键（直角 / 小圆角……），
 * 已有英文条目在 `lib_imageRadius.ts` 里，这里只补新增的档位与阴影、裁剪文案。
 */
const fragment: Dictionary = {
  '胶囊（999px）': 'Pill (999px)',
  无阴影: 'No shadow',
  轻阴影: 'Soft shadow',
  常规阴影: 'Regular shadow',
  大阴影: 'Large shadow',
  强调光晕: 'Accent glow',
  不裁剪: 'No crop',
  裁剪溢出内容: 'Crop overflow',
  '16:9 相框': '16:9 frame',
  '4:3 相框': '4:3 frame',
  '3:2 相框': '3:2 frame',
  '1:1 相框': '1:1 frame',
  '2:1 相框': '2:1 frame',
};

export default fragment;
