/**
 * 页脚备案信息。
 *
 * 中国大陆站点通常需要在页脚展示 ICP 备案号与公安网备号。公安备案要求同时展示
 * 徽标并链接到全国互联网安全管理服务平台，因此这里把号段解析成 official query 链接。
 */

const POLICE_QUERY = 'https://beian.mps.gov.cn/#/query/webSearch?code=';
const ICP_PORTAL = 'https://beian.miit.gov.cn/';

/** 从「京公网安备 11010502030123 号」里取出数字备案号。 */
export function policeCode(text: string): string {
  const match = text.replace(/\s+/g, '').match(/(\d{6,})/);
  return match ? match[1] : '';
}

export function policeHref(text: string): string {
  const code = policeCode(text);
  return code ? `${POLICE_QUERY}${code}` : 'https://beian.mps.gov.cn/';
}

export function PoliceBadge({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="police-badge"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8 1.15 13.6 3v5.15c0 3.2-2.2 5.8-5.6 6.9-3.4-1.1-5.6-3.7-5.6-6.9V3L8 1.15Z"
        fill="#1f5fd0"
      />
      <path
        d="M8 2.85 12.2 4.2v3.9c0 2.35-1.6 4.3-4.2 5.15-2.6-.85-4.2-2.8-4.2-5.15V4.2L8 2.85Z"
        fill="#ffffff"
        opacity="0.94"
      />
      <text
        x="8"
        y="9.7"
        textAnchor="middle"
        fontSize="5"
        fontWeight="700"
        fontFamily="serif"
        fill="#1f5fd0"
      >
        公
      </text>
    </svg>
  );
}

export function FilingLinks({ icp, police, icon }: { icp: string; police: string; icon?: string }) {
  if (!icp.trim() && !police.trim()) return null;
  return (
    <span className="filing-links">
      {icp.trim() ? (
        <a className="filing" href={ICP_PORTAL} target="_blank" rel="noreferrer">
          {icp.trim()}
        </a>
      ) : null}
      {police.trim() ? (
        <a className="filing filing-police" href={policeHref(police)} target="_blank" rel="noreferrer">
          {icon && /^https?:\/\//i.test(icon.trim()) ? (
            <img className="police-badge" src={icon.trim()} alt="" width={14} height={14} />
          ) : (
            <PoliceBadge />
          )}
          <span>{police.trim()}</span>
        </a>
      ) : null}
    </span>
  );
}
