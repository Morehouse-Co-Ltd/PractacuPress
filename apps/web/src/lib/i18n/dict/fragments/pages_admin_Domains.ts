import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Domains.tsx` */
const fragment: Dictionary = {
  访问与域名: 'Access & domains',
  域名绑定: 'Domain binding',
  '设置站点主域名、别名白名单、SSL 证书、CORS 来源与反向代理信任地址，并生成 Nginx 与 API 环境变量片段。没有设置主域名时，生产环境只允许公网 IP 直接访问。':
    'Set the primary domain, alias allowlist, SSL certificate, CORS origins, and trusted reverse proxy addresses, and generate the Nginx and API environment variable snippets. With no primary domain, production only allows direct access by public IP.',
  'CORS 来源必须是以 http(s) 开头的地址。':
    'CORS origins must be addresses that start with http(s).',
  '主域名不是有效域名。': 'The primary domain is not a valid domain.',
  '主域名必须是具体域名，不能是 IP 或通配符。':
    'The primary domain must be a concrete domain, not an IP address or a wildcard.',
  "Let's Encrypt 需要先填写主域名。": "Let's Encrypt needs the primary domain first.",
  "Let's Encrypt 需要一个通知邮箱。": "Let's Encrypt needs a notification email.",
  '手动证书需要填写证书链与私钥的服务器路径。':
    'Manual certificates need the server paths of the certificate chain and the private key.',
  访问与域名已保存: 'Access and domains saved',
  '主域名已写入站点配置；把下方片段部署后，域名与 HTTPS 才会真正生效。':
    'The primary domain is written into the site configuration; the domain and HTTPS only take effect after you deploy the snippet below.',
  '未设置主域名：生产环境将只允许公网 IP 直连（本机 localhost 例外）。':
    'No primary domain set: production will only allow direct public IP access (localhost is the exception).',
  '保存失败。': 'Save failed.',
  无法保存主域名: 'Could not save the primary domain',
  已恢复默认域名设置: 'Default domain settings restored',
  '白名单关闭，localhost 与 IP 默认允许。':
    'The allowlist is off; localhost and IPs are allowed by default.',
  站点管理员: 'Site admin',
  有设置没有通过校验: 'Some settings did not pass validation',
  '未设置主域名：只允许公网 IP 直接访问':
    'No primary domain: only direct public IP access is allowed',
  '填写域名并配置 DNS 后，站点会按域名与证书对外服务；不填时，生产环境只接受公网 IP 的 Host， 私有 IP 与普通域名都不解析。本机管理仍可通过 localhost 访问。':
    'Once a domain is filled in and DNS is configured, the site serves over that domain with its certificate; if it is empty, production only accepts a public IP in the Host header, and neither private IPs nor ordinary domains resolve. Local admin access still works over localhost.',
  '别名域名需要网关把 Host 改写为主域名':
    'Alias domains need the gateway to rewrite Host to the primary domain',
  '服务端按 Host 解析站点，别名域名直连 API 会被当成未知站点。下方 Nginx 片段里已经包含':
    'The server resolves the site by Host, so an alias domain calling the API directly is treated as an unknown site. The Nginx snippet below already includes',
  '，请一并部署。': ' — deploy it together with the rest.',
  'proxy_set_header Host 主域名;': 'proxy_set_header Host <primary domain>;',
  主域名: 'Primary domain',
  '保存后会直接写入站点配置；留空表示不设置域名（生产环境回退到公网 IP 直连）。':
    'Saving writes it straight into the site configuration; leave it empty to set no domain (production falls back to direct public IP access).',
  '未设置（公网 IP）': 'Not set (public IP)',
  '只填主机名，例如 press.example.com；不要带 https://、路径或端口。':
    'Enter the host name only, for example press.example.com; do not include https://, a path, or a port.',
  当前访问域名: 'Current domain',
  '浏览器实际打开的 host。': 'The host the browser is actually using.',
  本地豁免: 'Local exempt',
  'IP 放行': 'IP allowed',
  '公网 IP': 'Public IP',
  已绑定: 'Bound',
  未绑定: 'Not bound',
  白名单: 'Allowlist',
  '一行一个域名，支持通配符。留空表示不做浏览器端限制。':
    'One domain per line; wildcards are supported. Leave it empty to apply no browser-side restriction.',
  启用域名白名单: 'Enable the domain allowlist',
  '白名单为空：只允许公网 IP 直连':
    'The allowlist is empty: only direct public IP access is allowed',
  '先填写主域名或至少一个别名，白名单才会真正生效；否则生产环境只接受公网 IP。':
    'Fill in the primary domain or at least one alias for the allowlist to take effect; otherwise production only accepts public IPs.',
  别名域名: 'Alias domains',
  '例如 www.example.com、blog.example.com 或 *.example.com。主域名不需要重复填写。':
    'For example www.example.com, blog.example.com, or *.example.com. No need to repeat the primary domain.',
  '把 www 视为主域名别名': 'Treat www as an alias of the primary domain',
  '勾选后 www.example.com 会匹配 example.com。':
    'When checked, www.example.com matches example.com.',
  '允许 localhost': 'Allow localhost',
  '本地开发与预览需要；正式站点可按需关闭。':
    'Needed for local development and previews; a live site can turn it off.',
  '允许直接用 IP 访问': 'Allow access by IP address',
  '关闭后只有白名单域名能显示站点。': 'When off, only allowlisted domains can serve the site.',
  反向代理与跨域: 'Reverse proxy and CORS',
  '这些值只进入生成的 .env；API 需要重启才能读取。':
    'These values only go into the generated .env; the API must restart to read them.',
  '允许的浏览器来源（CORS）': 'Allowed browser origins (CORS)',
  '一行一个完整 origin，例如 https://example.com。留空则由上面的域名自动推导。':
    'One full origin per line, for example https://example.com. When empty, origins are derived from the domains above.',
  可信代理: 'Trusted proxies',
  '一行一个 IP 或 CIDR。只有来自这些地址的 X-Forwarded-For 才会被相信。':
    'One IP or CIDR per line. Only X-Forwarded-For values from these addresses are trusted.',
  'Cookie 作用域': 'Cookie scope',
  '多个子域名共享登录态时填写，例如 .example.com。':
    'Set this when several subdomains share the sign-in state, for example .example.com.',
  '强制 HTTPS（生成配置）': 'Force HTTPS (generated config)',
  '网关把 80 的请求跳到 443。': 'The gateway redirects port 80 requests to 443.',
  '别名 301 到主域名（生成配置）': '301 aliases to the primary domain (generated config)',
  '统一 SEO 与 Cookie 作用域。': 'Unifies SEO and the cookie scope.',
  'SSL 证书': 'SSL certificate',
  '选择 HTTPS 的启用方式；这里只记录部署方式与服务器上的证书路径，不会保存私钥内容。 保存后把下方 Nginx 片段与证书一起部署。':
    'Choose how HTTPS is enabled; only the deployment mode and the certificate paths on the server are recorded, and private key contents are never stored. Deploy the Nginx snippet below together with the certificate after saving.',
  未启用: 'Off',
  手动证书: 'Manual certificate',
  不启用: 'Off',
  '只用 HTTP；由前置代理终止 TLS。': 'HTTP only; a front proxy terminates TLS.',
  '生成 certbot 申请命令与证书路径。':
    'Generates the certbot request command and the certificate paths.',
  '已有证书链与私钥文件。': 'You already have the certificate chain and private key files.',
  通知邮箱: 'Notification email',
  '到期提醒与证书注册使用；不会写进浏览器存储之外的公开位置。':
    'Used for expiry reminders and certificate registration; it never goes anywhere public beyond browser storage.',
  '需要主域名已解析到本机，并允许 80/443 入站。下方「部署片段」里有 certbot 申请命令； 证书续期用':
    'The primary domain must resolve to this machine and allow inbound 80/443. The “Deployment snippets” section below has the certbot request command; renew the certificate with',
  '。': '.',
  证书链路径: 'Certificate chain path',
  '服务器上的 fullchain 文件，例如 /etc/ssl/certs/press.example.com.pem。':
    'The fullchain file on the server, for example /etc/ssl/certs/press.example.com.pem.',
  私钥路径: 'Private key path',
  '只填写路径；不要把私钥粘贴到浏览器或提交到 Git。':
    'Enter the path only; never paste the private key into the browser or commit it to Git.',
  '启用 HSTS': 'Enable HSTS',
  '启用后浏览器会强制使用 HTTPS；确认所有子域名都已支持 HTTPS 再打开。':
    'Once on, browsers insist on HTTPS; make sure every subdomain supports HTTPS before turning it on.',
  部署片段: 'Deployment snippets',
  '按已保存的设置生成，复制后请按实际证书路径与静态目录调整。':
    'Generated from the saved settings; after copying, adjust the real certificate paths and static directories.',
  '复制 Nginx': 'Copy Nginx',
  '复制 .env': 'Copy .env',
  复制证书步骤: 'Copy certificate steps',
  '展开 API 环境变量': 'Show API environment variables',
  '展开证书申请 / 部署步骤': 'Show certificate request / deployment steps',
  绑定概览: 'Binding overview',
  当前域名: 'Current host',
  '{count} 个': { one: '1 domain', other: '{count} domains' },
  不豁免: 'Not exempt',
  '允许 IP': 'Allow IP',
  '禁止 IP': 'Block IP',
  '还没有别名；主域名为空时不会限制访问。':
    'No aliases yet; when the primary domain is empty, access is not restricted.',
  'DNS 检查清单': 'DNS checklist',
  '绑定域名还需要这些步骤。': 'Binding a domain still needs these steps.',
  '给主域名添加 A / AAAA 记录，指向服务器地址。':
    'Add A / AAAA records for the primary domain pointing at the server address.',
  '别名用 CNAME 指向主域名，或单独添加 A 记录。':
    'Point aliases at the primary domain with CNAME, or add separate A records.',
  '为每个域名签发 TLS 证书，或使用通配证书。':
    'Issue a TLS certificate for each domain, or use a wildcard certificate.',
  '把上方 Nginx 的': 'Fill in the',
  '填全。': 'in the Nginx snippet above.',
  '把 API 的': 'Set the',
  '设为主域名。': 'to the primary domain.',
  '打开 DNS 查询': 'Open DNS lookup',
  恢复默认域名设置: 'Restore default domain settings',
  '关闭白名单并清空别名、CORS 与代理地址；主域名本身不会被修改。':
    'Turns off the allowlist and clears aliases, CORS origins, and proxy addresses; the primary domain itself is not changed.',
  恢复默认: 'Restore defaults',
  放弃未保存的修改: 'Discard unsaved changes',
  没有未保存的修改: 'No unsaved changes',

  // V-12 主域名 TXT 归属验证
  待验证: 'Pending verification',
  已验证: 'Verified',
  域名待验证: 'Domain pending verification',
  '验证完成前，公网域名暂不生效，可在本机（localhost）继续完成验证。':
    'Until verification is complete the public domain stays inactive; you can finish verifying on this machine (localhost).',
  'DNS 记录类型': 'DNS record type',
  '在域名 DNS 服务商处添加一条 TXT 记录。':
    'Add a TXT record at your DNS provider.',
  记录名: 'Record name',
  '有的服务商要求只填主机记录（不包含主域名后缀）。':
    'Some providers want only the host part (without the primary domain suffix).',
  复制记录名: 'Copy record name',
  记录值: 'Record value',
  'TXT 记录的内容；验证通过后可以删除。':
    'The TXT record contents; it can be removed once verification passes.',
  复制记录值: 'Copy record value',
  验证没有通过: 'Verification did not pass',
  '我已添加，立即验证': 'I added it — verify now',
  'DNS 记录生效通常需要几分钟；没通过可以稍后再点一次。':
    'DNS records usually take a few minutes to propagate; try again later if it fails.',
  主域名已验证: 'Primary domain verified',
  '公网域名已经生效；如果刚改过 DNS，浏览器可能需要几分钟缓存。':
    'The public domain is live; if you just changed DNS, browsers may cache the old answer for a few minutes.',
  '已保存的域名与当前输入不一致：重新保存后会生成新的 TXT 验证记录。':
    'The saved domain differs from the current input: saving again issues a new TXT verification record.',
  域名验证成功: 'Domain verified',
  '公网域名已经生效。': 'The public domain is now live.',
  '还没有验证通过，请稍后重试。': 'Verification has not passed yet; please try again later.',
  '还没有查询到 TXT 记录。DNS 生效可能需要几分钟，请稍后重试。':
    'No TXT record found yet. DNS can take a few minutes to propagate; please try again later.',
  '域名状态不允许验证，请检查域名格式与保存状态。':
    'The domain cannot be verified in its current state; check the domain format and whether it was saved.',
  '验证失败，请稍后重试。': 'Verification failed; please try again later.',
  '主域名已保存，待完成 TXT 验证；验证完成前公网域名暂不生效，可在本机继续管理。把下方部署片段应用后，域名与 HTTPS 才会真正对外服务。':
    'The primary domain was saved and is pending TXT verification; until then the public domain stays inactive and you can keep managing the site locally. Apply the deployment snippet below for the domain and HTTPS to actually serve visitors.',
};

export default fragment;
