import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/MediaQuotaField.tsx` */
const fragment: Dictionary = {
  '本站媒体额度（MB）': 'Site media quota (MB)',
  '媒体额度单位为 MB（1 MB = 1024 × 1024 字节）；留空继承部署默认，0 表示无限。':
    'Media quota is set in MB (1 MB = 1024 × 1024 bytes); leave it blank to inherit the deployment default, or enter 0 for unlimited.',
  '媒体额度必须是非负整数或小数（MB），且不能超过可存储上限。':
    'Enter a non-negative whole number or decimal in MB, within the supported storage limit.',
};

export default fragment;
