package site

import "net"

// isPublicAddress reports whether host is a literal public IP address.
//
// It backs the domain-less production rule: when a single site has no domain, its
// hostname fallback only accepts a public IP literal, so a misconfigured deployment
// cannot be reached through localhost or a private address by accident. Ordinary
// hostnames are rejected here on purpose: names resolve with DNS and are exactly what
// the domain setting exists to configure.
func isPublicAddress(host string) bool {
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() ||
		ip.IsMulticast() ||
		ip.IsInterfaceLocalMulticast() {
		return false
	}
	return true
}
