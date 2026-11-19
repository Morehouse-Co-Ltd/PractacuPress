package analytics

import (
	"net"
	"net/url"
	"strings"
)

// Source is the traffic source class of a page view.
//
// The raw referrer is already stored, but classifying it once at write time is what
// lets a report group a month of traffic without parsing URLs on every read. The
// class is intentionally coarse: the dashboard answers "where did readers come
// from", not "which exact page linked here" (that is what top_referrers is for).
type Source string

// Traffic source classes.
const (
	// SourceDirect means the request carried no usable referrer.
	SourceDirect Source = "direct"
	// SourceInternal means the referrer was the site itself.
	SourceInternal Source = "internal"
	// SourceSearch means the referrer host is a search engine.
	SourceSearch Source = "search"
	// SourceSocial means the referrer host is a social network.
	SourceSocial Source = "social"
	// SourceReferral means some other external site linked here.
	SourceReferral Source = "referral"
	// SourceUnknown marks a row written before sources were derived.
	SourceUnknown Source = "unknown"
)

// Valid reports whether the source is one of the defined classes.
func (s Source) Valid() bool {
	switch s {
	case SourceDirect, SourceInternal, SourceSearch, SourceSocial, SourceReferral, SourceUnknown:
		return true
	default:
		return false
	}
}

// Device is the device class of a page view.
//
// Only the class is stored. The raw User-Agent is never persisted: the dashboard
// needs "how many readers are on a phone", while keeping the full UA string would
// turn an anonymous page counter into a per-visitor fingerprint.
type Device string

// Device classes.
const (
	// DeviceDesktop is a regular computer browser.
	DeviceDesktop Device = "desktop"
	// DeviceMobile is a phone browser.
	DeviceMobile Device = "mobile"
	// DeviceTablet is a tablet browser.
	DeviceTablet Device = "tablet"
	// DeviceBot is a crawler, preview fetcher or HTTP client.
	DeviceBot Device = "bot"
	// DeviceUnknown marks a request without a User-Agent.
	DeviceUnknown Device = "unknown"
)

// Valid reports whether the device is one of the defined classes.
func (d Device) Valid() bool {
	switch d {
	case DeviceDesktop, DeviceMobile, DeviceTablet, DeviceBot, DeviceUnknown:
		return true
	default:
		return false
	}
}

// Signal bounds.
const (
	// MaxReferrerHostLength matches the referrer_host column so a crafted referrer
	// value can never make an otherwise valid visit write fail validation.
	MaxReferrerHostLength = 255
	// MaxTopReferrers bounds the referrer host leaderboard.
	MaxTopReferrers = 8
)

// Signals are the visit attributes the server derives for a page view.
//
// The device comes from the user agent. The referrer class is derived from the
// referrer the client reports, which is advisory data: a caller can claim any
// referrer, and no authorization or rate decision reads it.
type Signals struct {
	ReferrerHost string
	Source       Source
	Device       Device
}

// DeriveVisitSignals classifies one page view from the beacon body referrer and the
// request headers.
//
// The body referrer wins over the Referer header. The tracking POST is a same-origin
// beacon, so the browser always sends Referer pointing at the tracked page itself; if
// the header were preferred, every external entry would be counted as internal and
// the source breakdown would be empty in production. The front end reports the real
// entry referrer (document.referrer) in the body, so that value is what classifies
// the visit. The header is only a fallback for a client that omits the body value.
//
// siteHosts are the hosts of the current site (request host and configured domain), so
// a same-site referrer is still recognised as internal from either source.
func DeriveVisitSignals(bodyReferrer, refererHeader, userAgent string, siteHosts ...string) Signals {
	referrer := strings.TrimSpace(bodyReferrer)
	if referrer == "" {
		referrer = refererHeader
	}
	return DeriveSignals(referrer, userAgent, siteHosts...)
}

// DeriveSignals classifies one page view from a single referrer value and a user
// agent. Callers on the write path should use DeriveVisitSignals, which implements the
// body-referrer-first priority.
//
// siteHosts are the host names that belong to the current site (the request host and
// the configured domain); a referrer from any of them is internal and keeps an empty
// referrer_host. A same-site referrer is not "no referrer", it is an internal
// navigation, which is why source and referrer_host are decided together.
func DeriveSignals(referer, userAgent string, siteHosts ...string) Signals {
	host := ReferrerHost(referer)
	signals := Signals{
		ReferrerHost: host,
		Source:       SourceDirect,
		Device:       DeriveDevice(userAgent),
	}
	if host == "" {
		return signals
	}
	switch {
	case isSameSiteHost(host, siteHosts):
		// Internal navigation is not a referral: the host is dropped so the
		// top_referrers leaderboard only lists places that actually linked here.
		signals.ReferrerHost = ""
		signals.Source = SourceInternal
	case isSearchEngineHost(host):
		signals.Source = SourceSearch
	case isSocialHost(host):
		signals.Source = SourceSocial
	default:
		signals.Source = SourceReferral
	}
	return signals
}

// ReferrerHost extracts the host of a referrer URL.
//
// It returns an empty string for a missing referrer and for anything that is not an
// absolute URL with a host: the column feeds host comparisons and a leaderboard, so
// a path or a malformed value has no meaning there.
func ReferrerHost(referer string) string {
	raw := strings.TrimSpace(referer)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	host = strings.TrimSuffix(host, ".")
	// A host longer than the longest legal DNS name is not a real referrer. Dropping
	// it keeps the insert valid instead of truncating a meaningless value.
	if host == "" || len(host) > MaxReferrerHostLength {
		return ""
	}
	return host
}

// DeriveDevice classifies a User-Agent header.
//
// Order matters and follows the contract: bots are checked first so a crawler with a
// mobile token is still a crawler; then mobile, with iPad excluded because an iPad
// Safari UA also carries the "Mobile" token; then tablet. The consequence is that an
// Android tablet UA without an iPad token is counted as mobile, which is why tablet
// mostly means iPad in practice.
func DeriveDevice(userAgent string) Device {
	ua := strings.ToLower(strings.TrimSpace(userAgent))
	if ua == "" {
		return DeviceUnknown
	}
	if containsAny(ua, botUserAgentMarkers) {
		return DeviceBot
	}
	if containsAny(ua, mobileUserAgentMarkers) && !strings.Contains(ua, "ipad") {
		return DeviceMobile
	}
	if containsAny(ua, tabletUserAgentMarkers) {
		return DeviceTablet
	}
	return DeviceDesktop
}

// botUserAgentMarkers are the tokens shared by crawlers, link preview fetchers and
// plain HTTP clients. A browser never carries them.
var botUserAgentMarkers = []string{
	"bot", "spider", "crawler", "slurp", "bingpreview", "facebookexternalhit",
	"headlesschrome", "phantomjs", "curl/", "wget", "python-requests", "go-http-client",
	"httpclient",
}

// mobileUserAgentMarkers are the tokens of phone browsers. "Android" is deliberately
// included because an Android tablet UA is not required to carry "Tablet".
var mobileUserAgentMarkers = []string{
	"mobile", "android", "iphone", "ipod", "windows phone", "blackberry", "bb10",
	"opera mini", "iemobile", "webos",
}

// tabletUserAgentMarkers are the tokens of tablet browsers.
var tabletUserAgentMarkers = []string{"ipad", "tablet"}

// containsAny reports whether value contains one of the markers.
func containsAny(value string, markers []string) bool {
	for _, marker := range markers {
		if strings.Contains(value, marker) {
			return true
		}
	}
	return false
}

// isSameSiteHost reports whether host belongs to the current site.
//
// The "www." prefix is ignored on both sides: a site configured as example.com is
// routinely reached through www.example.com, and counting that hop as an external
// referral would pollute both the source and the referrer leaderboard.
func isSameSiteHost(host string, siteHosts []string) bool {
	candidate := trimWWW(normalizeHost(host))
	if candidate == "" {
		return false
	}
	for _, siteHost := range siteHosts {
		if trimWWW(normalizeHost(siteHost)) == candidate {
			return true
		}
	}
	return false
}

// normalizeHost lowercases a host or host:port value and drops the port and a
// trailing root dot, so a request Host and a parsed referrer host are comparable.
func normalizeHost(raw string) string {
	host := strings.TrimSpace(strings.ToLower(raw))
	if host == "" {
		return ""
	}
	// SplitHostPort only succeeds with a port; a bare host is already normalized.
	if stripped, _, err := net.SplitHostPort(host); err == nil {
		host = stripped
	}
	host = strings.TrimSuffix(host, ".")
	// An IPv6 literal may keep its brackets when no port was present.
	return strings.Trim(host, "[]")
}

// trimWWW drops a leading "www." label.
func trimWWW(host string) string { return strings.TrimPrefix(host, "www.") }

// searchEngineBrands are the second level labels of search engines. Matching the
// brand label instead of a full domain list is what makes google.de, google.co.jp
// and www.google.com all count without enumerating every ccTLD.
var searchEngineBrands = map[string]struct{}{
	"google":     {},
	"bing":       {},
	"baidu":      {},
	"sogou":      {},
	"so":         {},
	"360":        {},
	"duckduckgo": {},
	"yandex":     {},
	"yahoo":      {},
	"ecosia":     {},
	"qwant":      {},
	"naver":      {},
	"daum":       {},
	"seznam":     {},
	"rambler":    {},
	"ask":        {},
	"aol":        {},
	"brave":      {},
	"startpage":  {},
	"mojeek":     {},
	"marginalia": {},
}

// socialBrands are the second level labels of social networks.
var socialBrands = map[string]struct{}{
	"weixin":    {},
	"wechat":    {},
	"qq":        {},
	"facebook":  {},
	"fb":        {},
	"weibo":     {},
	"telegram":  {},
	"reddit":    {},
	"linkedin":  {},
	"youtube":   {},
	"instagram": {},
	"douyin":    {},
	"tiktok":    {},
	"twitter":   {},
	"tumblr":    {},
	"pinterest": {},
	"snapchat":  {},
	"whatsapp":  {},
	"discord":   {},
	"threads":   {},
	"mastodon":  {},
}

// socialDomains are social hosts whose name is too short or too generic to match as
// a brand label ("x" would otherwise match any x.<tld> host).
var socialDomains = []string{
	"x.com", "t.co", "t.me", "youtu.be", "wa.me", "discord.gg", "redd.it", "lnkd.in",
}

// secondLevelRegistries are the registry labels used by ccTLD registries. A brand
// may sit one label further left on such a host (google.co.uk, yahoo.co.jp).
var secondLevelRegistries = map[string]struct{}{
	"co": {}, "com": {}, "or": {}, "ne": {}, "ac": {}, "go": {}, "gob": {},
	"gov": {}, "edu": {}, "mil": {}, "sch": {}, "net": {}, "org": {}, "ltd": {},
}

// isSearchEngineHost reports whether host belongs to a search engine.
func isSearchEngineHost(host string) bool { return hostBrandMatch(host, searchEngineBrands) }

// isSocialHost reports whether host belongs to a social network.
func isSocialHost(host string) bool {
	for _, domain := range socialDomains {
		if hostMatchesDomain(host, domain) {
			return true
		}
	}
	return hostBrandMatch(host, socialBrands)
}

// hostBrandMatch reports whether one label of host is a known brand sitting directly
// under the top level domain, or one step further left on a ccTLD registry
// (google.co.uk). Requiring the brand to be that close to the end rejects lookalike
// hosts such as google.example.com.
func hostBrandMatch(host string, brands map[string]struct{}) bool {
	labels := strings.Split(host, ".")
	for index := 0; index < len(labels)-1; index++ {
		if _, ok := brands[labels[index]]; !ok {
			continue
		}
		switch rest := labels[index+1:]; len(rest) {
		case 1:
			return true
		case 2:
			if _, ok := secondLevelRegistries[rest[0]]; ok {
				return true
			}
		}
	}
	return false
}

// hostMatchesDomain reports whether host is domain or a subdomain of it.
func hostMatchesDomain(host, domain string) bool {
	return host == domain || strings.HasSuffix(host, "."+domain)
}
