import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/DomainGuard.tsx` */
const fragment: Dictionary = {
  这个域名还没有绑定到本站: 'This domain is not bound to this site yet',
  当前访问的域名是: 'The domain you are visiting is',
  未知主机: 'unknown host',
  '。如果这是你的站点，请把域名加入白名单，并在 DNS 与反向代理里完成绑定。':
    '. If this is your site, add the domain to the allowlist and complete the binding in DNS and the reverse proxy.',
  已允许的域名: 'Allowed domains',
  '白名单为空。': 'The allowlist is empty.',
  '提示：浏览器端白名单只负责展示提示；真正阻止未绑定域名访问的是 DNS 与反向代理。':
    'Note: the browser-side allowlist only shows this notice; DNS and the reverse proxy are what actually block unbound domains.',
};

export default fragment;
