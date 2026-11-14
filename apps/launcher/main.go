// Practacu Press Windows 一键启动器。
//
// 双击运行：在本机 8080 端口启动站点（占用时自动换端口），并打开默认浏览器。
// 站点文件通过 go:embed 打进 exe，不需要安装 Node，也不需要保留 dist 目录。
//
// 运行时接口与 apps/web/scripts/serve.mjs 保持一致，前台「站点设置 → 访问端口」
//
//	GET  /__pp/runtime              当前端口与地址
//	POST /__pp/runtime/port         换端口（带一次性数据迁移）
//	GET  /__pp/state/{token}        新地址读取旧地址的浏览器数据
package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed all:web
var embedded embed.FS

const (
	appName     = "practacu-press"
	defaultPort = 8080
	stateName   = "practacu-web.json"
)

type snapshot struct {
	items   map[string]string
	expires time.Time
}

type app struct {
	dist      fs.FS
	distReady bool
	startedAt time.Time
	stateFile string

	mu        sync.RWMutex
	port      int
	server    *http.Server
	snapshots map[string]snapshot
	live      *liveRuntime
	liveErr   string
	mode      string
}

func main() {
	enableUTF8Console()

	a := &app{
		startedAt: time.Now(),
		stateFile: resolveStateFile(),
		snapshots: map[string]snapshot{},
		mode:      modeDemo,
	}
	if sub, err := fs.Sub(embedded, "web/dist"); err == nil {
		a.dist = sub
		if info, err := fs.Stat(sub, "index.html"); err == nil && !info.IsDir() {
			a.distReady = true
		}
	}

	portArg := flag.Int("port", 0, "监听端口（默认 8080，可用 PP_WEB_PORT 或后台设置覆盖）")
	noBrowser := flag.Bool("no-browser", false, "启动后不自动打开浏览器")
	modeArg := flag.String("mode", modeAuto, "运行方式：auto（有 API 就用真实环境）、demo、live")
	apiArg := flag.String("api", "", "PractacuPressAPI.exe 的路径（默认在 exe 同目录查找）")
	dataArg := flag.String("data", "", "数据目录（默认 exe 同目录 data）")
	flag.Parse()

	state := readState(a.stateFile)

	preferred := *portArg
	if preferred == 0 {
		if v := strings.TrimSpace(os.Getenv("PP_WEB_PORT")); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 65536 {
				preferred = n
			}
		}
	}
	if preferred == 0 {
		preferred = state.Port
	}
	if preferred == 0 {
		preferred = defaultPort
	}

	if !a.distReady {
		fmt.Println("这个启动器里没有内置站点文件。")
		fmt.Println("请从官方压缩包解压后再运行；自行构建请先执行 npm run build 并重新打包。")
		pause()
		return
	}

	// 已经有实例在跑：直接打开它，不要再起一份 API 去抢同一个 SQLite 文件。
	for _, candidate := range candidatePorts(preferred) {
		if runningOn(candidate) {
			target := originForPort(candidate)
			fmt.Printf("\n站点已经在运行：%s\n", target)
			if !*noBrowser {
				_ = openBrowser(target)
				fmt.Println("已为你打开浏览器。")
			} else {
				fmt.Println("这个窗口可以直接关闭。")
			}
			time.Sleep(2 * time.Second)
			return
		}
	}

	desired, modeErr := normalizeMode(*modeArg)
	if modeErr != nil {
		fmt.Printf("\n%s\n", modeErr)
		pause()
		return
	}

	apiBinary := findAPIBinary(*apiArg)
	wantLive := desired == modeLive || (desired == modeAuto && apiBinary != "")
	if desired == modeLive && apiBinary == "" {
		fmt.Println("\n没有找到 PractacuPressAPI.exe，无法启动真实环境。")
		fmt.Println("请从官方压缩包解压完整文件夹后再运行，或用 --mode demo 只看界面。")
		pause()
		return
	}

	if wantLive {
		fmt.Println("正在启动本机 API…")
		live, err := startLive(liveOptions{
			apiBinary: apiBinary,
			dataDir:   resolveDataDir(*dataArg),
			stateFile: a.stateFile,
		})
		if err != nil {
			a.liveErr = err.Error()
			fmt.Printf("\n本机 API 没能启动：%s\n", err)
			fmt.Println("先以演示模式继续：界面可以正常使用，真实环境暂时连接不上。")
		} else {
			a.live = live
			a.mode = modeLive
			defer live.stop()
		}
	}

	chosen := 0
	var lastErr error
	for _, candidate := range candidatePorts(preferred) {
		if runningOn(candidate) {
			target := originForPort(candidate)
			fmt.Printf("\n站点已经在运行：%s\n", target)
			if !*noBrowser {
				_ = openBrowser(target)
				fmt.Println("已为你打开浏览器。")
			} else {
				fmt.Println("这个窗口可以直接关闭。")
			}
			time.Sleep(2 * time.Second)
			return
		}
		if err := a.start(candidate); err != nil {
			lastErr = err
			if !isAddrInUse(err) && !isDenied(err) {
				break
			}
			if candidate == preferred {
				fmt.Printf("端口 %d 不可用（%s），正在尝试其他端口…\n", candidate, shortErr(err))
			}
			continue
		}
		chosen = candidate
		break
	}

	if chosen == 0 {
		fmt.Printf("\n启动失败：%v\n", lastErr)
		fmt.Println("请检查端口占用，或换一个端口后重试：PractacuPress.exe --port 8081")
		pause()
		return
	}

	target := originForPort(chosen)
	printBanner(a, target, chosen, preferred)

	if !*noBrowser {
		if err := openBrowser(target); err != nil {
			fmt.Printf("没能自动打开浏览器，请手动访问 %s\n", target)
		}
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig

	fmt.Println("\n正在停止…")
	a.mu.RLock()
	srv := a.server
	a.mu.RUnlock()
	if srv != nil {
		_ = srv.Close()
	}
	if a.live != nil {
		a.live.stop()
	}
	fmt.Println("已停止。这个窗口可以直接关闭。")
}

func printBanner(a *app, target string, port int, preferred int) {
	fmt.Println()
	fmt.Println("  ┌──────────────────────────────────────────────────┐")
	fmt.Println("  │  Practacu Press                                  │")
	fmt.Println("  └──────────────────────────────────────────────────┘")
	fmt.Printf("   访问地址   %s\n", target)
	fmt.Printf("   监听端口   %d", port)
	if port == defaultPort {
		fmt.Print("（默认）")
	}
	fmt.Println()
	if a.live != nil {
		fmt.Println("   运行方式   真实环境（Go API + SQLite，同源代理）")
		fmt.Printf("   数据目录   %s\n", a.live.dataDir)
		fmt.Printf("   本机 API   127.0.0.1:%d", a.live.apiPort)
		if a.live.security {
			fmt.Println(" · 安全服务已启动")
		} else {
			fmt.Println(" · 未附带安全服务")
		}
		if !a.live.security {
			fmt.Println("   提示       发布文章与完成上传需要安全服务；缺少时会被拒绝")
		}
		if strings.TrimSpace(os.Getenv("PUBLIC_BASE_URL")) == "" {
			fmt.Println("   提示       未设置 PUBLIC_BASE_URL：绝对链接默认按 https 推导")
			fmt.Printf("              需要通知邮件或第三方登录时，先设置 PUBLIC_BASE_URL=%s 再启动\n", originForPort(port))
		}
	} else {
		fmt.Println("   运行方式   演示模式（只有前端，数据保存在浏览器）")
		if a.liveErr != "" {
			fmt.Println("   真实环境   不可用，详见上方提示")
		}
	}
	fmt.Println("   修改端口   管理后台 → 站点设置 → 访问端口")
	if port != preferred {
		fmt.Printf("   提示       端口 %d 不可用，本次改用 %d 端口\n", preferred, port)
	}
	fmt.Println()
	fmt.Println("   关闭这个窗口即可停止站点。")
	fmt.Println()
}

func pause() {
	fmt.Print("按回车键退出…")
	var line string
	_, _ = fmt.Scanln(&line)
}

/* ---------- 监听与端口 ---------- */

// candidatePorts 返回按优先级排列的候选端口：首选端口最优先，其次是
// 8080/8081/8082 这组常用本地端口，最后才回退到标准 HTTP 80 端口。
// 默认端口现在是 8080，所以 8080 被占用时会先试相邻端口，80 只作为最后的兜底。
func candidatePorts(preferred int) []int {
	list := []int{preferred}
	for _, p := range []int{8080, 8081, 8082, 80} {
		if p != preferred {
			list = append(list, p)
		}
	}
	return list
}

func (a *app) start(port int) error {
	listeners, err := bindAll(port)
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler:           a,
		ReadHeaderTimeout: 5 * time.Second,
	}

	a.mu.Lock()
	old := a.server
	a.server = server
	a.port = port
	a.mu.Unlock()

	for _, listener := range listeners {
		go func(l net.Listener) { _ = server.Serve(l) }(listener)
	}
	if old != nil {
		// 等当前切换请求的响应写回，再关旧端口。
		time.AfterFunc(400*time.Millisecond, func() { _ = old.Close() })
	}
	return nil
}

func bindAll(port int) ([]net.Listener, error) {
	hosts := []string{"127.0.0.1", "::1"}
	if v := strings.TrimSpace(os.Getenv("PP_WEB_HOST")); v != "" {
		hosts = []string{v}
	}
	var listeners []net.Listener
	var lastErr error
	for _, host := range hosts {
		listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err != nil {
			lastErr = err
			if isAddrInUse(err) || isDenied(err) {
				closeListeners(listeners)
				return nil, err
			}
			// 某个协议栈不可用（例如禁用 IPv6），换下一个。
			continue
		}
		listeners = append(listeners, listener)
	}
	if len(listeners) == 0 {
		if lastErr == nil {
			lastErr = errors.New("没有可用的监听地址")
		}
		return nil, lastErr
	}
	return listeners, nil
}

func closeListeners(listeners []net.Listener) {
	for _, l := range listeners {
		_ = l.Close()
	}
}

func isAddrInUse(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "address already in use") || strings.Contains(text, "only one usage")
}

func isDenied(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, syscall.EACCES) {
		return true
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "permission denied") || strings.Contains(text, "access is denied")
}

func shortErr(err error) string {
	if isAddrInUse(err) {
		return "已被其他程序占用"
	}
	if isDenied(err) {
		return "没有权限"
	}
	return err.Error()
}

/* ---------- HTTP ---------- */

// contentSecurityPolicy is the conservative policy for the launcher's own pages.
//
// The site is served from this origin: scripts, styles and images are same origin
// module assets. Inline styles stay allowed because the theme layer injects
// <style> elements at runtime. Inline scripts stay blocked; the single inline script in
// the shell today is the dark-mode bootstrap in apps/web/index.html, and the browser
// refuses it (a reader who picked dark mode gets one light frame on a cold load).
// Moving that snippet to an external file — or hashing it into `script-src` — is the fix;
// do not relax the whole directive to 'unsafe-inline'. A third-party reverse proxy
// terminates TLS, but the policy belongs to the page and is always sent from here first.
//
// The captcha providers are one deliberate exception on the script and connect
// directives: the settings page can switch a site's human verification on, and the
// widget only works if this origin may load the provider's script. Only the
// documented hosts are allowed, and only the directives a widget needs.
//
// `frame-src` is not an allow-list of third parties; it has to cover every frame this
// page itself builds:
//
//   - `'self'`: the page builder renders the real front end in a same-origin <iframe>
//     (`components/builder/PreviewFrame.tsx`), and the admin panel embeds other
//     same-origin admin pages the same way. Leaving `'self'` out makes the browser
//     replace the preview with its own "this content is blocked" page, which is the
//     page editor looking broken for every author, on every install.
//   - `https:` / `http:`: the "website" block has an iframe mode where the author types
//     any address (https in practice; plain http on a loopback install), and the
//     captcha providers' challenge frames live on https too.
//
// `frame-ancestors 'self'` is what actually stops other sites from framing this one;
// `frame-src` only says what this page may embed, so it must stay permissive enough
// for the editor that authors use every day.
//
// `font-src` repeats the `data:` allowance for the same reason: the bundler inlines the
// small KaTeX faces as data URIs, and without it the maths faces in an article silently
// fall back to the system font.
const contentSecurityPolicy = "default-src 'self'; " +
	"img-src 'self' data: https:; " +
	"font-src 'self' data:; " +
	"style-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://*.hcaptcha.com https://www.gstatic.com; " +
	"script-src 'self' https://challenges.cloudflare.com https://js.hcaptcha.com https://www.google.com https://www.gstatic.com; " +
	"frame-src 'self' https: http:; " +
	"connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com https://www.google.com; " +
	"frame-ancestors 'self'; " +
	"base-uri 'self'; " +
	"form-action 'self'"

// setSecurityHeaders applies the static site's security headers to every response.
//
// It runs before routing so API responses proxied through the launcher carry them
// too. The API sets X-Content-Type-Options itself; setting the same value twice is
// harmless and keeps the launcher correct when the API is unavailable.
func setSecurityHeaders(h http.Header) {
	h.Set("Content-Security-Policy", contentSecurityPolicy)
	h.Set("X-Frame-Options", "SAMEORIGIN")
	h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
	h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	h.Set("X-Content-Type-Options", "nosniff")
}

func (a *app) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// The API sets the same browser security headers itself; letting the launcher set
	// them on proxied responses too would duplicate every header (Go's reverse proxy
	// appends upstream values). Static and control-plane responses are the launcher's
	// own, so they get the headers here.
	if !isAPIPath(r.URL.Path) {
		setSecurityHeaders(w.Header())
	}

	switch {
	case r.URL.Path == "/__pp/runtime":
		a.handleRuntime(w, r)
	case r.URL.Path == "/__pp/runtime/port":
		a.handlePortChange(w, r)
	case strings.HasPrefix(r.URL.Path, "/__pp/state/"):
		a.handleStateImport(w, r)
	case strings.HasPrefix(r.URL.Path, "/__pp/"):
		writeJSON(w, 404, map[string]any{"code": "not_found", "message": "没有这个运行时接口。"})
	case isAPIPath(r.URL.Path):
		a.serveAPI(w, r)
	default:
		a.serveStatic(w, r)
	}
}

// serveAPI forwards API traffic to the child process.
//
// Static hosting alone answers /api with 404, which the setup wizard reads as "no
// backend here". With the launcher owning the API, the page and the API share one
// origin, so no CORS configuration and no address entry are needed.
func (a *app) serveAPI(w http.ResponseWriter, r *http.Request) {
	a.mu.RLock()
	live := a.live
	a.mu.RUnlock()

	if live == nil {
		setSecurityHeaders(w.Header())
		message := "启动器只提供静态站点，本机没有运行 API。"
		if a.liveErr != "" {
			message = "本机 API 未能启动：" + a.liveErr
		}
		writeJSON(w, http.StatusNotFound, map[string]any{
			"code":    "backend_unavailable",
			"message": message,
		})
		return
	}
	live.proxy.ServeHTTP(w, r)
}

// handleRuntime reports the port and health of the local site.
//
// The endpoint is part of the local control plane, so it is restricted to loopback
// peers *and* loopback Host headers. A same-machine reverse proxy forwards with a
// loopback peer address, which is why the peer address alone is not enough: the
// public hostname it was addressed to shows up in Host, and that is what tells the
// two apart. The response is deliberately small: the page only needs mode, port and
// origin plus enough API state to explain a failed start. Installation paths,
// internal API addresses, log files and process ids stay on this machine.
func (a *app) handleRuntime(w http.ResponseWriter, r *http.Request) {
	if !requireLocalControl(w, r, "只允许在本机查看运行时信息。") {
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, 405, map[string]any{"code": "method_not_allowed", "message": "只支持 GET。"})
		return
	}
	a.mu.RLock()
	port := a.port
	live := a.live
	mode := a.mode
	liveErr := a.liveErr
	a.mu.RUnlock()

	api := map[string]any{"managed": false, "ready": false}
	if live != nil {
		api = map[string]any{
			"managed":  true,
			"ready":    live.ready.Load(),
			"security": live.security,
		}
	} else if liveErr != "" {
		api["error"] = liveErr
	}

	writeJSON(w, 200, map[string]any{
		"mode":         "static",
		"runtime_mode": mode,
		"name":         appName,
		"port":         port,
		"origin":       originFor(r, port),
		"dist_ready":   a.distReady,
		"api":          api,
	})
}

func (a *app) handlePortChange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"code": "method_not_allowed", "message": "只支持 POST。"})
		return
	}
	if !requireLocalControl(w, r, "只能在运行站点的这台电脑上修改端口。") {
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || !strings.EqualFold(parsed.Host, r.Host) {
			writeJSON(w, 403, map[string]any{"code": "permission_denied", "message": "只接受来自本站页面的修改请求。"})
			return
		}
	}
	if !strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		writeJSON(w, 415, map[string]any{"code": "unsupported_media_type", "message": "请求体需要是 application/json。"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 6<<20)
	var body struct {
		Port  int               `json:"port"`
		State map[string]string `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{"code": "validation_failed", "message": "请求体需要是 JSON。"})
		return
	}
	if body.Port < 1 || body.Port > 65535 {
		writeJSON(w, 400, map[string]any{"code": "validation_failed", "message": "端口需要是 1–65535 之间的整数。"})
		return
	}

	a.mu.RLock()
	previous := a.port
	a.mu.RUnlock()

	if body.Port == previous {
		writeJSON(w, 200, map[string]any{
			"ok": true, "port": body.Port, "previous": previous,
			"origin": originFor(r, body.Port), "unchanged": true,
		})
		return
	}

	if err := a.start(body.Port); err != nil {
		message := fmt.Sprintf("无法监听端口 %d：%s", body.Port, shortErr(err))
		if isAddrInUse(err) {
			message = fmt.Sprintf("端口 %d 已被其他程序占用，换一个端口再试。", body.Port)
		} else if isDenied(err) {
			message = fmt.Sprintf("没有权限监听端口 %d。1024 以下的端口需要管理员权限。", body.Port)
		}
		status := 409
		if !isAddrInUse(err) && !isDenied(err) {
			status = 500
		}
		writeJSON(w, status, map[string]any{"ok": false, "code": "listen_failed", "message": message})
		return
	}

	a.persistPort(body.Port)
	token := a.rememberState(body.State)

	writeJSON(w, 200, map[string]any{
		"ok": true, "port": body.Port, "previous": previous,
		"origin": originFor(r, body.Port), "import_token": token,
	})
}

func (a *app) handleStateImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]any{"code": "method_not_allowed", "message": "只支持 GET。"})
		return
	}
	if !requireLocalControl(w, r, "只能在本机读取迁移数据。") {
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/__pp/state/")
	if len(token) != 32 || !isHex(token) {
		writeJSON(w, 404, map[string]any{"code": "not_found", "message": "迁移数据不存在或已过期。"})
		return
	}

	a.mu.Lock()
	entry, ok := a.snapshots[token]
	delete(a.snapshots, token)
	a.mu.Unlock()

	if !ok || time.Now().After(entry.expires) {
		writeJSON(w, 404, map[string]any{"code": "not_found", "message": "迁移数据不存在或已过期。"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "items": entry.items})
}

func (a *app) rememberState(state map[string]string) string {
	if len(state) == 0 {
		return ""
	}
	items := map[string]string{}
	total := 0
	for key, value := range state {
		if !strings.HasPrefix(key, "pp.") || len(value) > 1<<20 {
			continue
		}
		total += len(key) + len(value)
		if total > 4<<20 {
			return ""
		}
		items[key] = value
	}
	if len(items) == 0 {
		return ""
	}
	token := randomToken()
	now := time.Now()
	a.mu.Lock()
	for key, entry := range a.snapshots {
		if now.After(entry.expires) {
			delete(a.snapshots, key)
		}
	}
	a.snapshots[token] = snapshot{items: items, expires: now.Add(2 * time.Minute)}
	a.mu.Unlock()
	return token
}

func (a *app) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, 405, map[string]any{"code": "method_not_allowed", "message": "静态服务只支持 GET。"})
		return
	}

	clean := path.Clean("/" + r.URL.Path)
	rel := strings.TrimPrefix(clean, "/")
	if rel == "" {
		rel = "index.html"
	}
	if info, err := fs.Stat(a.dist, rel); err == nil && info.IsDir() {
		rel = path.Join(rel, "index.html")
	}

	if info, err := fs.Stat(a.dist, rel); err == nil && !info.IsDir() {
		a.setCache(w, rel)
		http.FileServer(http.FS(a.dist)).ServeHTTP(w, r)
		return
	}

	// 只有导航请求才回退到 index.html，缺失的静态资源要如实 404。
	if path.Ext(clean) == "" && r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") {
		data, err := fs.ReadFile(a.dist, "index.html")
		if err != nil {
			writeJSON(w, 500, map[string]any{"code": "internal", "message": "站点入口文件缺失。"})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		_, _ = w.Write(data)
		return
	}

	writeJSON(w, 404, map[string]any{"code": "not_found", "message": "没有找到 " + r.URL.Path + "。"})
}

func (a *app) setCache(w http.ResponseWriter, rel string) {
	switch {
	case strings.HasPrefix(rel, "assets/"):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	case strings.HasSuffix(rel, ".html"):
		w.Header().Set("Cache-Control", "no-store")
	default:
		w.Header().Set("Cache-Control", "no-cache")
	}
}

/* ---------- 工具 ---------- */

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func originFor(r *http.Request, port int) string {
	host := r.Host
	if strings.HasPrefix(host, "[") {
		if i := strings.Index(host, "]"); i > 0 {
			host = host[:i+1]
		}
	} else if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	proto := "http"
	if strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
		proto = "https"
	}
	if (proto == "http" && port == 80) || (proto == "https" && port == 443) {
		return proto + "://" + host
	}
	return fmt.Sprintf("%s://%s:%d", proto, host, port)
}

func originForPort(port int) string {
	if port == 80 {
		return "http://localhost"
	}
	return fmt.Sprintf("http://localhost:%d", port)
}

func isLoopbackRemote(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	return isLoopbackHost(host)
}

// isLoopbackHost reports whether a Host header names this machine.
//
// Only the literal loopback names count: localhost, 127.0.0.0/8 and ::1, with or
// without a port. A same-machine reverse proxy keeps forwarding to the loopback
// listener, so RemoteAddr alone cannot tell a local operator from a proxied public
// request; the Host header it preserves can.
func isLoopbackHost(hostport string) bool {
	host := strings.TrimSpace(hostport)
	if host == "" {
		return false
	}
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	} else if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// requireLocalControl is the guard for the /__pp/* control plane.
//
// Both checks are needed: the peer address stops a directly exposed launcher from
// answering strangers, and the Host check stops a reverse proxy on the same machine
// from turning a public request into a "local" one. Forwarding headers are refused
// as well, because a proxy that rewrites Host to the loopback address (the default
// for a bare proxy_pass) would otherwise look exactly like a local request; a local
// browser never sends X-Forwarded-*/Forwarded. It writes the 403 response itself and
// reports whether the caller may continue.
func requireLocalControl(w http.ResponseWriter, r *http.Request, message string) bool {
	if isLoopbackRemote(r.RemoteAddr) && isLoopbackHost(r.Host) && !hasForwardingHeaders(r) {
		return true
	}
	writeJSON(w, http.StatusForbidden, map[string]any{
		"code":    "permission_denied",
		"message": message,
	})
	return false
}

// hasForwardingHeaders reports whether a reverse proxy marked this request as
// forwarded. The launcher's own same-origin pages never add these headers.
func hasForwardingHeaders(r *http.Request) bool {
	for _, name := range []string{
		"X-Forwarded-For",
		"X-Forwarded-Host",
		"X-Forwarded-Proto",
		"X-Real-IP",
		"Forwarded",
	} {
		if strings.TrimSpace(r.Header.Get(name)) != "" {
			return true
		}
	}
	return false
}

func isHex(value string) bool {
	for _, c := range value {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func randomToken() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func runningOn(port int) bool {
	client := http.Client{Timeout: 900 * time.Millisecond}
	res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/__pp/runtime", port))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var info struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(res.Body).Decode(&info); err != nil {
		return false
	}
	return info.Name == appName
}

func openBrowser(target string) error {
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
}

func resolveStateFile() string {
	exe, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(exe)
		test := filepath.Join(dir, ".pp-write-test")
		if err := os.WriteFile(test, []byte("x"), 0o644); err == nil {
			_ = os.Remove(test)
			return filepath.Join(dir, stateName)
		}
	}
	if cfg, err := os.UserConfigDir(); err == nil {
		dir := filepath.Join(cfg, "PractacuPress")
		if err := os.MkdirAll(dir, 0o755); err == nil {
			return filepath.Join(dir, stateName)
		}
	}
	return stateName
}

func (a *app) persistPort(port int) {
	state := readState(a.stateFile)
	state.Port = port
	_ = writeState(a.stateFile, state)
}

// enableUTF8Console 让 cmd.exe 正确显示中文（默认代码页是 GBK）。
func enableUTF8Console() {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	_, _, _ = kernel32.NewProc("SetConsoleOutputCP").Call(65001)
	_, _, _ = kernel32.NewProc("SetConsoleCP").Call(65001)
}
