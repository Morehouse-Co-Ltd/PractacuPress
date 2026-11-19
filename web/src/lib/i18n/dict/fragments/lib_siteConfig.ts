import type { Dictionary } from '../../plural';

/** 来源：`web/src/lib/siteConfig.ts` */
const fragment: Dictionary = {
  '后台入口不能为空。': 'The admin entry cannot be empty.',
  '后台入口只能是路径，不能带查询参数。':
    'The admin entry must be a path, without query parameters.',
  '后台入口最多 80 个字符。': 'The admin entry can be at most 80 characters.',
  '{path} 是站点自己的路径，请换一个入口。': '{path} is a site path; choose another entry.',
};

export default fragment;
