package securitygo

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Argon2 resource-limit boundaries.
const (
	Argon2ConcurrencyMin      = 1
	Argon2ConcurrencyMax      = 32
	Argon2ConcurrencyCPUCap   = 4
	Argon2ConcurrencyFallback = 2

	DefaultArgon2Timeout = 10 * time.Second
	MinArgon2Timeout     = 100 * time.Millisecond
	MaxArgon2Timeout     = 60 * time.Second
)

// Limits are the Argon2 resource bounds in force.
type Limits struct {
	Concurrency int
	Timeout     time.Duration
}

// ResolveLimits reads the Argon2 resource limits from environment variables.
func ResolveLimits() Limits {
	return Limits{
		Concurrency: resolveConcurrency(os.Getenv("SECURITY_ARGON2_CONCURRENCY"), runtime.NumCPU()),
		Timeout:     resolveTimeout(os.Getenv("SECURITY_ARGON2_TIMEOUT_MS")),
	}
}

func parseConcurrency(raw string) (int, bool) {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < Argon2ConcurrencyMin || value > Argon2ConcurrencyMax {
		return 0, false
	}
	return value, true
}

func fallbackConcurrency(cpus int) int {
	if cpus <= 0 {
		return Argon2ConcurrencyFallback
	}
	if cpus > Argon2ConcurrencyCPUCap {
		return Argon2ConcurrencyCPUCap
	}
	return cpus
}

func resolveConcurrency(raw string, cpus int) int {
	if value, ok := parseConcurrency(raw); ok {
		return value
	}
	return fallbackConcurrency(cpus)
}

func resolveTimeout(raw string) time.Duration {
	milliseconds, err := strconv.ParseUint(strings.TrimSpace(raw), 10, 64)
	if err == nil {
		timeout := time.Duration(milliseconds) * time.Millisecond
		if timeout >= MinArgon2Timeout && timeout <= MaxArgon2Timeout {
			return timeout
		}
	}
	return DefaultArgon2Timeout
}
