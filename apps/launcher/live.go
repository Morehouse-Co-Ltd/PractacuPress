package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Binaries the launcher looks for next to itself.
const (
	apiBinaryName      = "PractacuPressAPI.exe"
	securityBinaryName = "practacu-security.exe"

	apiPortStart      = 8791
	securityPortStart = 9001
	apiReadyTimeout   = 45 * time.Second
	securityWaitLimit = 12 * time.Second
)

// Runtime modes printed in the banner and reported by /__pp/runtime.
const (
	modeAuto = "auto"
	modeDemo = "demo"
	modeLive = "live"
)

// liveRuntime owns the Go API child process and the same origin reverse proxy that
// makes it reachable from the page without any address configured.
//
// The API listens on a loopback port of its own; the browser only ever talks to the
// launcher origin, so cookies, CSRF double submit and the WebSocket ticket flow all
// behave exactly as they do behind a reverse proxy in production.
type liveRuntime struct {
	apiPort      int
	securityPort int
	baseURL      *url.URL
	proxy        *httputil.ReverseProxy
	ready        atomic.Bool
	pid          int
	security     bool
	dataDir      string
	logPath      string
	errPath      string

	mu          sync.Mutex
	apiCmd      *exec.Cmd
	securityCmd *exec.Cmd
	job         *childJob
	stopped     bool
}

type liveOptions struct {
	apiBinary string
	dataDir   string
	stateFile string
}

// normalizeMode accepts the --mode vocabulary and reports the canonical value.
func normalizeMode(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", modeAuto:
		return modeAuto, nil
	case modeDemo, "static":
		return modeDemo, nil
	case modeLive, "real":
		return modeLive, nil
	default:
		return "", fmt.Errorf("未知的运行方式 %q：可选 auto、demo、live。", raw)
	}
}

// findAPIBinary resolves PractacuPressAPI.exe: an explicit path wins, otherwise the
// exe directory and its api/ subfolder are searched.
func findAPIBinary(explicit string) string {
	if explicit != "" {
		if info, err := os.Stat(explicit); err == nil && !info.IsDir() {
			return explicit
		}
		return ""
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	dir := filepath.Dir(exe)
	for _, candidate := range []string{
		filepath.Join(dir, apiBinaryName),
		filepath.Join(dir, "api", apiBinaryName),
	} {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func findSecurityBinary() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	candidate := filepath.Join(filepath.Dir(exe), securityBinaryName)
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate
	}
	return ""
}

// startLive brings the API up behind the launcher.
//
// The security service is started first when the package ships it: the API dials it
// once at startup and never retries, so a service that comes up later would leave
// publishing and uploads failing closed for the whole session.
func startLive(opts liveOptions) (*liveRuntime, error) {
	if opts.apiBinary == "" {
		return nil, errors.New("没有找到 " + apiBinaryName)
	}
	if err := os.MkdirAll(opts.dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建数据目录：%w", err)
	}

	state := readState(opts.stateFile)
	key, err := ensureSigningKey(opts.stateFile, &state)
	if err != nil {
		return nil, fmt.Errorf("准备签名密钥：%w", err)
	}

	live := &liveRuntime{
		dataDir: opts.dataDir,
		logPath: filepath.Join(opts.dataDir, "api.log"),
		errPath: filepath.Join(opts.dataDir, "api.err.log"),
		job:     newChildJob(),
	}

	if securityBinary := findSecurityBinary(); securityBinary != "" {
		if port, startErr := live.startSecurity(securityBinary); startErr != nil {
			fmt.Printf("  安全服务未能启动（%s），发布与上传会被拒绝。\n", shortErr(startErr))
		} else {
			live.securityPort = port
			live.security = true
		}
	}
	if live.securityPort == 0 {
		live.securityPort = pickFreePort(securityPortStart)
	}

	apiPort, portErr := pickFreePortStrict(apiPortStart)
	if portErr != nil {
		return nil, portErr
	}
	live.apiPort = apiPort
	live.baseURL = &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(apiPort))}
	live.proxy = newAPIProxy(live.baseURL)

	if err := live.startAPI(opts.apiBinary, apiEnv(live, key)); err != nil {
		live.stop()
		return nil, err
	}
	return live, nil
}

// apiEnv is the environment the child API runs with. It is desktop specific:
// development strictness, SQLite next to the exe, loopback only, and the stable
// signing key the launcher keeps.
func apiEnv(live *liveRuntime, signingKey string) []string {
	// PUBLIC_BASE_URL is deliberately not pinned here: the browser-facing port can
	// change at runtime, and the API derives the request origin from the proxied
	// Host. Pinning the startup port would make reset links stale after a port
	// change. An operator who needs absolute links sets the variable in the
	// environment, which os.Environ() already carries into the child; the startup
	// banner points at it when it is missing.
	return []string{
		"APP_ENV=development",
		"HTTP_ADDR=" + net.JoinHostPort("127.0.0.1", strconv.Itoa(live.apiPort)),
		"DATABASE_DRIVER=sqlite",
		"DATABASE_DSN=" + sqliteDSN(filepath.Join(live.dataDir, "practacu.db")),
		"SECURITY_GRPC_ADDR=" + net.JoinHostPort("127.0.0.1", strconv.Itoa(live.securityPort)),
		"STORAGE_DRIVER=local",
		"STORAGE_DIR=" + filepath.Join(live.dataDir, "media"),
		"BACKUP_DIR=" + filepath.Join(live.dataDir, "backups"),
		"PP_DESKTOP=1",
		"COOKIE_SECURE=false",
		// The page is served from the same origin, so cookies must work over plain
		// HTTP; a single local operator also should not trip the shared budget.
		"RATE_LIMIT_PER_MINUTE=1200",
		"AUTH_JWT_ED25519_PRIVATE_KEY=" + signingKey,
	}
}

func (l *liveRuntime) startAPI(binary string, env []string) error {
	logFile, err := os.OpenFile(l.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("打开 api.log：%w", err)
	}
	errFile, err := os.OpenFile(l.errPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		_ = logFile.Close()
		return fmt.Errorf("打开 api.err.log：%w", err)
	}

	cmd := exec.Command(binary)
	cmd.Dir = l.dataDir
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdout = logFile
	cmd.Stderr = errFile
	cmd.SysProcAttr = hiddenWindow()

	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		_ = errFile.Close()
		return fmt.Errorf("启动本机 API：%w", err)
	}
	l.job.assign(cmd.Process)

	l.mu.Lock()
	l.apiCmd = cmd
	l.pid = cmd.Process.Pid
	l.mu.Unlock()

	exited := make(chan error, 1)
	go func() {
		exited <- cmd.Wait()
		_ = logFile.Close()
		_ = errFile.Close()
	}()

	if err := waitForReady(l.baseURL.String()+"/readyz", apiReadyTimeout, exited); err != nil {
		tail := tailFile(l.errPath, 12)
		if tail == "" {
			tail = tailFile(l.logPath, 12)
		}
		if tail != "" {
			return fmt.Errorf("%w\n%s", err, tail)
		}
		return err
	}

	l.ready.Store(true)
	return nil
}

func (l *liveRuntime) startSecurity(binary string) (int, error) {
	port, err := pickFreePortStrict(securityPortStart)
	if err != nil {
		return 0, err
	}

	logFile, err := os.OpenFile(filepath.Join(l.dataDir, "security.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return 0, err
	}

	cmd := exec.Command(binary)
	cmd.Dir = l.dataDir
	cmd.Env = append(os.Environ(), "SECURITY_GRPC_BIND="+net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = hiddenWindow()

	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return 0, err
	}
	l.job.assign(cmd.Process)

	l.mu.Lock()
	l.securityCmd = cmd
	l.mu.Unlock()
	go func() {
		_ = cmd.Wait()
		_ = logFile.Close()
	}()

	deadline := time.Now().Add(securityWaitLimit)
	for time.Now().Before(deadline) {
		conn, dialErr := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 300*time.Millisecond)
		if dialErr == nil {
			_ = conn.Close()
			return port, nil
		}
		time.Sleep(150 * time.Millisecond)
	}

	l.stopSecurity()
	return 0, errors.New("安全服务在超时时间内没有开始监听")
}

// stop terminates the child processes. It is safe to call twice.
func (l *liveRuntime) stop() {
	if l == nil {
		return
	}
	l.mu.Lock()
	if l.stopped {
		l.mu.Unlock()
		return
	}
	l.stopped = true
	api := l.apiCmd
	security := l.securityCmd
	l.mu.Unlock()

	l.ready.Store(false)
	killProcess(api)
	killProcess(security)
}

func (l *liveRuntime) stopSecurity() {
	l.mu.Lock()
	cmd := l.securityCmd
	l.securityCmd = nil
	l.mu.Unlock()
	killProcess(cmd)
}

func killProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	// The wait goroutine started next to Start reaps the child; waiting here would
	// race with it.
	_ = cmd.Process.Kill()
}

// newAPIProxy forwards /api, /healthz, /readyz and the generated crawler files to
// the child API.
//
// The Host header is left untouched on purpose: the API resolves the site by
// hostname, and the browser-facing host is exactly the one the operator installed.
func newAPIProxy(base *url.URL) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(base)
	proxy.FlushInterval = -1
	proxy.Transport = &http.Transport{
		// Never route loopback traffic through the user's HTTP proxy: a machine wide
		// corporate proxy would otherwise intercept the local API.
		Proxy:                 nil,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
	}
	original := proxy.Director
	proxy.Director = func(r *http.Request) {
		original(r)
		if r.Header.Get("X-Forwarded-Proto") == "" {
			r.Header.Set("X-Forwarded-Proto", "http")
		}
		r.Header.Set("X-PP-Runtime", "launcher")
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"code":    "backend_unavailable",
			"message": "本机 API 没有响应，可能已经停止。请关闭启动器窗口后重新运行。",
			"details": map[string]any{"path": r.URL.Path},
		})
	}
	return proxy
}

// isAPIPath reports whether a request belongs to the API rather than the static site.
//
// Sitemap.xml, robots.txt and the feeds are generated per site by the API, so they
// must be proxied too; the embedded static bundle has no such files. /plugins/
// serves the frontend half of extensions: those bundles are same-origin classic
// scripts, so they must come from the API rather than the embedded asset folder.
func isAPIPath(path string) bool {
	if path == "/healthz" ||
		path == "/readyz" ||
		path == "/sitemap.xml" ||
		path == "/robots.txt" ||
		path == "/rss.xml" ||
		path == "/atom.xml" ||
		// Named in the implementation plan as an alias of the RSS feed.
		path == "/feed.xml" ||
		path == "/api" ||
		strings.HasPrefix(path, "/api/") ||
		strings.HasPrefix(path, "/plugins/") {
		return true
	}
	// Category and tag feeds: /category/<slug>/rss.xml and /tag/<slug>/atom.xml.
	// Only these paths go to the API; the human-facing /category/<slug> pages stay
	// in the SPA.
	if strings.HasPrefix(path, "/category/") || strings.HasPrefix(path, "/tag/") {
		return strings.HasSuffix(path, "/rss.xml") || strings.HasSuffix(path, "/atom.xml")
	}
	return false
}

func waitForReady(url string, timeout time.Duration, exited <-chan error) error {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	deadline := time.Now().Add(timeout)
	var lastErr error

	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			if err == nil {
				return errors.New("本机 API 启动后立即退出。")
			}
			return fmt.Errorf("本机 API 启动失败：%w", err)
		default:
		}

		res, err := client.Get(url)
		if err == nil {
			body, _ := io.ReadAll(io.LimitReader(res.Body, 256))
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK && strings.Contains(string(body), `"ready"`) {
				return nil
			}
			lastErr = fmt.Errorf("/readyz 返回 %d", res.StatusCode)
		} else {
			lastErr = err
		}
		time.Sleep(300 * time.Millisecond)
	}
	if lastErr == nil {
		lastErr = errors.New("超时")
	}
	return fmt.Errorf("本机 API 在 %s 内没有就绪：%w", timeout.Round(time.Second), lastErr)
}

// pickFreePort asks the OS for a loopback port.
func pickFreePort(start int) int {
	if port, err := pickFreePortStrict(start); err == nil {
		return port
	}
	if port, err := pickFreePortStrict(0); err == nil {
		return port
	}
	return start
}

// pickFreePortStrict finds a free port at or after start by binding and releasing it.
// The window between release and the child's bind is short; the API reports a bind
// failure and the launcher surfaces it instead of silently continuing.
func pickFreePortStrict(start int) (int, error) {
	for port := start; port < start+40; port++ {
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			continue
		}
		_ = listener.Close()
		return port, nil
	}
	if start == 0 {
		return 0, errors.New("找不到可用的本机端口")
	}
	return 0, fmt.Errorf("端口 %d–%d 都被占用", start, start+39)
}

// tailFile returns the last n lines of a text file, used to explain a startup failure.
func tailFile(path string, n int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
