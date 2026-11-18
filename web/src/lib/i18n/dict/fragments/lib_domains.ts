import type { Dictionary } from '../../plural';

/** 来源：`web/src/lib/domains.ts` */
const fragment: Dictionary = {
  // ---- 域名逐条校验（domainEntryError） ----
  '域名不能为空。': 'The domain cannot be empty.',
  '域名不能包含空格。': 'The domain cannot contain spaces.',
  '不是有效的域名。': 'This is not a valid domain.',
  '通配域名至少需要两级，例如 *.example.com。':
    'A wildcard domain needs at least two levels, for example *.example.com.',
};

export default fragment;
