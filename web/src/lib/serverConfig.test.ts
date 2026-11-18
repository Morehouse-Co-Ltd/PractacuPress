import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCESS } from './access';
import { DEFAULT_DOMAINS } from './domains';
import { DEFAULT_PERFORMANCE } from './performance';
import {
  buildAccessEnvSnippet,
  buildDomainEnvSnippet,
  buildGatewaySnippet,
  buildPerformanceEnvSnippet,
  buildPerformanceGatewaySnippet,
  buildTlsSetupSnippet,
} from './serverConfig';

const access = {
  ...DEFAULT_ACCESS,
  enabled: true,
  page_switch: { enabled: true, limit: 40, window_seconds: 60, block_seconds: 30 },
  requests: { enabled: true, limit: 120, window_seconds: 60, block_seconds: 30 },
  tabs: { enabled: true, limit: 6 },
};

const domains = {
  ...DEFAULT_DOMAINS,
  enabled: true,
  primary: 'example.com',
  aliases: ['www.example.com', '*.blog.example.com'],
  trusted_proxies: ['127.0.0.1'],
  cookie_domain: '.example.com',
};

describe('gateway snippets', () => {
  it('generates rate and connection zones with the configured numbers', () => {
    const snippet = buildGatewaySnippet(access, domains);
    expect(snippet).toContain('zone=pp_api:10m rate=120r/m');
    expect(snippet).toContain('zone=pp_page:10m rate=40r/m');
    expect(snippet).toContain('limit_conn pp_conn 24;');
    expect(snippet).toContain('server_name example.com www.example.com *.blog.example.com;');
    expect(snippet).toContain('proxy_set_header Host example.com;');
  });

  it('switches to HTTPS and the canonical redirect when asked', () => {
    const snippet = buildGatewaySnippet(
      access,
      { ...domains, https_only: true, redirect_primary: true },
    );
    expect(snippet).toContain('listen 443 ssl http2;');
    expect(snippet).toContain('return 301 https://$host$request_uri;');
    expect(snippet).toContain('if ($host != example.com)');
  });

  it('omits rules that are disabled', () => {
    const snippet = buildGatewaySnippet(
      {
        ...access,
        requests: { ...access.requests, enabled: false },
        tabs: { ...access.tabs, enabled: false },
      },
      domains,
    );
    expect(snippet).not.toContain('limit_req_zone $binary_remote_addr zone=pp_api');
    expect(snippet).not.toContain('limit_req zone=pp_api');
    expect(snippet).not.toContain('limit_conn pp_conn');
  });

  it('writes API rate and trusted proxies into the env snippet', () => {
    const snippet = buildAccessEnvSnippet(access, domains);
    expect(snippet).toContain('RATE_LIMIT_PER_MINUTE=120');
    expect(snippet).toContain('TRUSTED_PROXIES=127.0.0.1');
  });

  it('derives CORS and cookie settings for the domain env', () => {
    const snippet = buildDomainEnvSnippet(domains);
    expect(snippet).toContain('PUBLIC_BASE_URL=http://example.com');
    expect(snippet).toContain('COOKIE_DOMAIN=.example.com');
    expect(snippet).toContain('CORS_ALLOWED_ORIGINS=https://example.com,https://www.example.com');
    expect(snippet).toContain('CORS_ALLOW_CREDENTIALS=true');
  });

  it('uses https in the env snippet when TLS is enabled', () => {
    const snippet = buildDomainEnvSnippet({
      ...domains,
      tls: { ...DEFAULT_DOMAINS.tls, mode: 'manual', cert_path: '/c.pem', key_path: '/k.pem' },
    });
    expect(snippet).toContain('PUBLIC_BASE_URL=https://example.com');
  });

  it('writes TLS directives for Let’s Encrypt and manual certificates', () => {
    const letsencrypt = buildGatewaySnippet(access, {
      ...domains,
      tls: { ...DEFAULT_DOMAINS.tls, mode: 'letsencrypt', email: 'ops@example.com' },
    });
    expect(letsencrypt).toContain('listen 443 ssl http2;');
    expect(letsencrypt).toContain(
      'ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;',
    );
    expect(letsencrypt).toContain('ssl_protocols TLSv1.2 TLSv1.3;');

    const manual = buildGatewaySnippet(access, {
      ...domains,
      tls: {
        ...DEFAULT_DOMAINS.tls,
        mode: 'manual',
        cert_path: '/etc/ssl/example.pem',
        key_path: '/etc/ssl/example.key',
        hsts: true,
      },
    });
    expect(manual).toContain('ssl_certificate     /etc/ssl/example.pem;');
    expect(manual).toContain('ssl_certificate_key /etc/ssl/example.key;');
    expect(manual).toContain('Strict-Transport-Security');

    const steps = buildTlsSetupSnippet({
      ...domains,
      tls: { ...DEFAULT_DOMAINS.tls, mode: 'letsencrypt', email: 'ops@example.com' },
    });
    expect(steps).toContain('certbot certonly --nginx -d example.com');
  });

  it('without a domain only allows public IP Hosts in the gateway', () => {
    const snippet = buildGatewaySnippet(access, { ...DEFAULT_DOMAINS });
    expect(snippet).toContain('server_name _;');
    expect(snippet).toContain('if ($host !~* "^[0-9a-fA-F:.]+$") { return 444; }');
    expect(snippet).toContain('proxy_set_header Host $host;');
    expect(snippet).toContain('只允许公网 IP 直接访问');
  });

  it('emits deployable performance and database settings', () => {
    const gateway = buildPerformanceGatewaySnippet({
      ...DEFAULT_PERFORMANCE,
      gzip: true,
      static_cache_days: 30,
      keepalive_timeout: 65,
    });
    expect(gateway).toContain('gzip on;');
    expect(gateway).toContain('expires 30d;');
    expect(gateway).toContain('keepalive_timeout 65s;');

    const env = buildPerformanceEnvSnippet({
      ...DEFAULT_PERFORMANCE,
      api_read_timeout: 45,
      api_idle_timeout: 90,
      db_max_open_conns: 12,
      db_max_idle_conns: 6,
      db_conn_max_lifetime: 600,
    });
    expect(env).toContain('HTTP_READ_TIMEOUT_SECONDS=45');
    expect(env).toContain('HTTP_IDLE_TIMEOUT_SECONDS=90');
    expect(env).toContain('DB_MAX_OPEN_CONNS=12');
    expect(env).toContain('DB_MAX_IDLE_CONNS=6');
    expect(env).toContain('DB_CONN_MAX_LIFETIME_SECONDS=600');
  });
});
