package analytics

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestReferrerHost(t *testing.T) {
	cases := []struct {
		name    string
		referer string
		want    string
	}{
		{name: "empty", referer: "", want: ""},
		{name: "blank", referer: "   ", want: ""},
		{name: "plain url", referer: "https://example.com/path?q=1", want: "example.com"},
		{name: "mixed case and port", referer: "HTTPS://Example.COM:8443/a", want: "example.com"},
		{name: "trailing root dot", referer: "https://example.com./a", want: "example.com"},
		{name: "protocol relative", referer: "//news.example.org/a", want: "news.example.org"},
		{name: "subdomain", referer: "https://m.facebook.com/x", want: "m.facebook.com"},
		{name: "path only", referer: "/a/previous", want: ""},
		{name: "word without scheme", referer: "not a url", want: ""},
		{name: "space in host is invalid", referer: "https://exa mple.com/", want: ""},
		{name: "opaque scheme", referer: "javascript:alert(1)", want: ""},
		{name: "no host", referer: "https:///path", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, ReferrerHost(tc.referer))
		})
	}
}

func TestDeriveSignalsSources(t *testing.T) {
	const desktopUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
	siteHosts := []string{"blog.example.com:8080", "example.com"}

	cases := []struct {
		name    string
		referer string
		want    Signals
	}{
		{
			name:    "no referrer is direct",
			referer: "",
			want:    Signals{ReferrerHost: "", Source: SourceDirect},
		},
		{
			name:    "invalid referrer has no usable host",
			referer: "not a url",
			want:    Signals{ReferrerHost: "", Source: SourceDirect},
		},
		{
			name:    "same request host is internal and keeps no host",
			referer: "https://blog.example.com:8080/a/previous",
			want:    Signals{ReferrerHost: "", Source: SourceInternal},
		},
		{
			name:    "same configured domain is internal",
			referer: "https://example.com/a/previous",
			want:    Signals{ReferrerHost: "", Source: SourceInternal},
		},
		{
			name:    "www of the configured domain is internal",
			referer: "https://www.example.com/a/previous",
			want:    Signals{ReferrerHost: "", Source: SourceInternal},
		},
		{
			name:    "google is search",
			referer: "https://www.google.com/search?q=go",
			want:    Signals{ReferrerHost: "www.google.com", Source: SourceSearch},
		},
		{
			name:    "google ccTLD is search",
			referer: "https://www.google.co.uk/search?q=go",
			want:    Signals{ReferrerHost: "www.google.co.uk", Source: SourceSearch},
		},
		{
			name:    "bing is search",
			referer: "https://cn.bing.com/search?q=go",
			want:    Signals{ReferrerHost: "cn.bing.com", Source: SourceSearch},
		},
		{
			name:    "baidu is search",
			referer: "https://www.baidu.com/s?wd=go",
			want:    Signals{ReferrerHost: "www.baidu.com", Source: SourceSearch},
		},
		{
			name:    "sogou is search",
			referer: "https://www.sogou.com/web?query=go",
			want:    Signals{ReferrerHost: "www.sogou.com", Source: SourceSearch},
		},
		{
			name:    "duckduckgo is search",
			referer: "https://duckduckgo.com/?q=go",
			want:    Signals{ReferrerHost: "duckduckgo.com", Source: SourceSearch},
		},
		{
			name:    "yandex is search",
			referer: "https://yandex.ru/search/?text=go",
			want:    Signals{ReferrerHost: "yandex.ru", Source: SourceSearch},
		},
		{
			name:    "yahoo is search",
			referer: "https://search.yahoo.com/search?p=go",
			want:    Signals{ReferrerHost: "search.yahoo.com", Source: SourceSearch},
		},
		{
			name:    "x.com is social",
			referer: "https://x.com/someone/status/1",
			want:    Signals{ReferrerHost: "x.com", Source: SourceSocial},
		},
		{
			name:    "twitter is social",
			referer: "https://twitter.com/someone/status/1",
			want:    Signals{ReferrerHost: "twitter.com", Source: SourceSocial},
		},
		{
			name:    "wechat article is social",
			referer: "https://mp.weixin.qq.com/s/abc",
			want:    Signals{ReferrerHost: "mp.weixin.qq.com", Source: SourceSocial},
		},
		{
			name:    "telegram short link is social",
			referer: "https://t.me/channel/1",
			want:    Signals{ReferrerHost: "t.me", Source: SourceSocial},
		},
		{
			name:    "facebook is social",
			referer: "https://m.facebook.com/story.php?id=1",
			want:    Signals{ReferrerHost: "m.facebook.com", Source: SourceSocial},
		},
		{
			name:    "weibo is social",
			referer: "https://weibo.com/1/abc",
			want:    Signals{ReferrerHost: "weibo.com", Source: SourceSocial},
		},
		{
			name:    "reddit is social",
			referer: "https://www.reddit.com/r/go/comments/x",
			want:    Signals{ReferrerHost: "www.reddit.com", Source: SourceSocial},
		},
		{
			name:    "linkedin is social",
			referer: "https://www.linkedin.com/feed/",
			want:    Signals{ReferrerHost: "www.linkedin.com", Source: SourceSocial},
		},
		{
			name:    "youtube is social",
			referer: "https://www.youtube.com/watch?v=x",
			want:    Signals{ReferrerHost: "www.youtube.com", Source: SourceSocial},
		},
		{
			name:    "douyin is social",
			referer: "https://www.douyin.com/video/1",
			want:    Signals{ReferrerHost: "www.douyin.com", Source: SourceSocial},
		},
		{
			name:    "tiktok is social",
			referer: "https://www.tiktok.com/@x/video/1",
			want:    Signals{ReferrerHost: "www.tiktok.com", Source: SourceSocial},
		},
		{
			name:    "other external site is referral",
			referer: "https://news.example.org/a",
			want:    Signals{ReferrerHost: "news.example.org", Source: SourceReferral},
		},
		{
			name:    "engine brand as a subdomain is not an engine",
			referer: "https://google.example.com/a",
			want:    Signals{ReferrerHost: "google.example.com", Source: SourceReferral},
		},
		{
			name:    "google subdomain is search",
			referer: "https://mail.google.com/mail",
			want:    Signals{ReferrerHost: "mail.google.com", Source: SourceSearch},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DeriveSignals(tc.referer, desktopUA, siteHosts...)
			require.Equal(t, tc.want.ReferrerHost, got.ReferrerHost)
			require.Equal(t, tc.want.Source, got.Source)
			require.Equal(t, DeviceDesktop, got.Device, "the device is independent of the referrer")
		})
	}
}

// TestDeriveVisitSignalsPrefersBodyReferrer pins the write path priority: the beacon
// body carries the real entry referrer while the Referer header is the tracked page
// itself, so the body value must win. The header is only a fallback when the body has
// no referrer at all.
func TestDeriveVisitSignalsPrefersBodyReferrer(t *testing.T) {
	const desktopUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
	const samePage = "https://blog.example.com/a/current-page"
	siteHosts := []string{"blog.example.com", "example.com"}

	cases := []struct {
		name          string
		bodyReferrer  string
		refererHeader string
		wantHost      string
		wantSource    Source
	}{
		{
			name:          "body search referrer beats a same site header",
			bodyReferrer:  "https://www.google.com/search?q=hello",
			refererHeader: samePage,
			wantHost:      "www.google.com",
			wantSource:    SourceSearch,
		},
		{
			name:          "body social referrer beats a same site header",
			bodyReferrer:  "https://x.com/someone/status/1",
			refererHeader: samePage,
			wantHost:      "x.com",
			wantSource:    SourceSocial,
		},
		{
			name:          "body external referral beats a same site header",
			bodyReferrer:  "https://news.example.org/a",
			refererHeader: samePage,
			wantHost:      "news.example.org",
			wantSource:    SourceReferral,
		},
		{
			name:          "same site body referrer stays internal",
			bodyReferrer:  "https://www.example.com/a/previous",
			refererHeader: "https://www.google.com/search?q=hello",
			wantHost:      "",
			wantSource:    SourceInternal,
		},
		{
			name:          "empty body referrer falls back to the header",
			bodyReferrer:  "",
			refererHeader: "https://www.google.com/search?q=hello",
			wantHost:      "www.google.com",
			wantSource:    SourceSearch,
		},
		{
			name:          "blank body referrer falls back to the header",
			bodyReferrer:  "   ",
			refererHeader: "https://www.google.com/search?q=hello",
			wantHost:      "www.google.com",
			wantSource:    SourceSearch,
		},
		{
			name:          "empty body and empty header is direct",
			bodyReferrer:  "",
			refererHeader: "",
			wantHost:      "",
			wantSource:    SourceDirect,
		},
		{
			// The web tracker sends the literal "直接访问" for a visit without a
			// document referrer; it is not a URL and must not fall back to the
			// same-site header, or every direct visit would become internal.
			name:          "unparseable body referrer stays direct",
			bodyReferrer:  "直接访问",
			refererHeader: samePage,
			wantHost:      "",
			wantSource:    SourceDirect,
		},
		{
			// An SPA navigation reports the previous path, which carries no host.
			name:          "relative body referrer stays direct",
			bodyReferrer:  "/a/previous",
			refererHeader: samePage,
			wantHost:      "",
			wantSource:    SourceDirect,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DeriveVisitSignals(tc.bodyReferrer, tc.refererHeader, desktopUA, siteHosts...)
			require.Equal(t, tc.wantHost, got.ReferrerHost)
			require.Equal(t, tc.wantSource, got.Source)
			require.Equal(t, DeviceDesktop, got.Device)
		})
	}
}

func TestDeriveDevice(t *testing.T) {
	cases := []struct {
		name string
		ua   string
		want Device
	}{
		{
			name: "empty",
			ua:   "",
			want: DeviceUnknown,
		},
		{
			name: "blank",
			ua:   "   ",
			want: DeviceUnknown,
		},
		{
			name: "windows desktop",
			ua:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			want: DeviceDesktop,
		},
		{
			name: "mac desktop",
			ua:   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
			want: DeviceDesktop,
		},
		{
			name: "iphone is mobile",
			ua:   "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
			want: DeviceMobile,
		},
		{
			name: "android phone is mobile",
			ua:   "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
			want: DeviceMobile,
		},
		{
			name: "ipad is tablet despite the mobile token",
			ua:   "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
			want: DeviceTablet,
		},
		{
			name: "tablet token without a mobile marker is tablet",
			ua:   "Mozilla/5.0 (X11; Linux; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36",
			want: DeviceTablet,
		},
		{
			name: "googlebot is bot even with a mobile token",
			ua:   "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.129 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
			want: DeviceBot,
		},
		{
			name: "bingbot is bot",
			ua:   "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
			want: DeviceBot,
		},
		{
			name: "spider is bot",
			ua:   "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
			want: DeviceBot,
		},
		{
			name: "crawler is bot",
			ua:   "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
			want: DeviceBot,
		},
		{
			name: "slurp is bot",
			ua:   "Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)",
			want: DeviceBot,
		},
		{
			name: "http client is bot",
			ua:   "curl/8.4.0",
			want: DeviceBot,
		},
		{
			name: "unknown token falls back to desktop",
			ua:   "SomeClient/1.0",
			want: DeviceDesktop,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, DeriveDevice(tc.ua))
		})
	}
}

// TestDeriveDeviceOrderPinsTheContractChain documents the consequence of the
// contract's mobile-before-tablet order: a tablet UA that also carries a mobile
// marker but no iPad token is counted as mobile.
func TestDeriveDeviceOrderPinsTheContractChain(t *testing.T) {
	androidTablet := "Mozilla/5.0 (Linux; Android 12; SM-T865) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
	require.Equal(t, DeviceMobile, DeriveDevice(androidTablet))
}
