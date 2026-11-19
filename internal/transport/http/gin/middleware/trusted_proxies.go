package middleware

import (
	"fmt"
	"net"
	"strings"
)

// TrustedProxies is the set of peers whose forwarding headers are believed.
//
// An empty set means no peer is trusted, so X-Forwarded-* headers are ignored
// entirely. This matters for site resolution: trusting the header unconditionally
// would let any client choose which site it is served.
type TrustedProxies struct {
	nets []*net.IPNet
}

// NewTrustedProxies parses IPs and CIDRs. Bare IPs become single host networks.
func NewTrustedProxies(entries []string) (TrustedProxies, error) {
	tp := TrustedProxies{}
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") {
			_, network, err := net.ParseCIDR(entry)
			if err != nil {
				return TrustedProxies{}, fmt.Errorf("trusted proxies: invalid CIDR %q: %w", entry, err)
			}
			tp.nets = append(tp.nets, network)
			continue
		}
		ip := net.ParseIP(entry)
		if ip == nil {
			return TrustedProxies{}, fmt.Errorf("trusted proxies: invalid IP %q", entry)
		}
		bits := 128
		if ip.To4() != nil {
			bits = 32
		}
		tp.nets = append(tp.nets, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
	}
	return tp, nil
}

// Empty reports whether no peer is trusted.
func (t TrustedProxies) Empty() bool { return len(t.nets) == 0 }

// Contains reports whether ip is trusted.
func (t TrustedProxies) Contains(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, network := range t.nets {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// ContainsRemote reports whether a "host:port" remote address is trusted.
func (t TrustedProxies) ContainsRemote(remoteAddr string) bool {
	if t.Empty() {
		return false
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	host = strings.Trim(host, "[]")
	return t.Contains(net.ParseIP(host))
}
