package main

// 站点版本清单与「服务端检查更新」。
//
// 版本清单是构建产物根目录里的 version.json（仓库里的源文件是
// web/public/version.json），只有标题、说明、版本号、发布渠道四个字段。
// 浏览器端与启动器用同一套规则解析它：web/src/lib/siteUpdate.ts 是前端那一份，
// 这里的 parseManifest / compareVersions 与它一一对应。两边都要改，否则会出现
// 「页面说有新版本、服务端说没有」这种自相矛盾，而且很难查。
//
// 检查更新由服务端来做，原因是浏览器直接跨域读 GitHub 会被 CORS 挡住；本机启动器
// 没有这个限制，但它同时也就成了一个「让服务端替我发请求」的入口，所以更新源必须
// 走允许列表（见 manifestFetcher），不能让页面随便指一个内网地址来探测。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	// defaultManifestSource 是默认更新源：官方仓库 main 分支里的清单。
	// 它必须与前端 UPDATE_SERVERS 的第一项一致，否则页面选了「GitHub 官方仓库」
	// 却被服务端换成别的地址，用户看到的来源就说不清了。
	defaultManifestSource = "https://raw.githubusercontent.com/practacu/practacu-press/main/web/public/version.json"

	// localManifestPath 是「读本站清单」的更新源。dist 根目录只有这一份清单，
	// 所以只接受这一个路径：别的路径一律当非法输入拒绝，而不是去 dist 里翻文件。
	// 这样这个入口永远不会变成「读本机任意文件」的通道。
	localManifestPath = "/version.json"

	// manifestBodyLimit 是清单大小上限。正常清单不到 1 KiB，64 KiB 已经非常宽松；
	// 设上限是为了让一个被接管或挂住的更新源不能把启动器的内存拖垮。
	manifestBodyLimit = 64 << 10

	// manifestTimeout 是服务端抓清单的总超时。点「检查更新」是交互操作，
	// 3 秒没有结果就该告诉用户「更新源没响应」，而不是让请求一直挂着。
	manifestTimeout = 3 * time.Second

	// updateBodyLimit 是 /__pp/update/apply 请求体上限：里面只有一个目录路径。
	updateBodyLimit = 64 << 10
)

// manifestStyles 是发布渠道的合法取值：稳定版、测试版、本地自建。
var manifestStyles = map[string]bool{
	"stable": true,
	"beta":   true,
	"local":  true,
}

// versionPattern 是清单里允许的版本号形状：三段数字，可带 v 前缀，
// 可选预发布标签与构建元数据。与前端 VERSION_PATTERN 对应（前端多接受大写的 V，
// 这里按清单约定只收小写 v；比较时两者都接受，见 versionPartsPattern）。
var versionPattern = regexp.MustCompile(`^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)

// versionPartsPattern 比清单宽松：比较时也接受大写的 V 前缀，
// 免得用户手写的 v/V 差异被当成「无法解析」，进而被误判成「版本相同」。
var versionPartsPattern = regexp.MustCompile(`^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$`)

// VersionManifest 是 version.json 的四个核心字段。
//
// 字段少是刻意的：清单要从第三方地址取回，只有能逐一校验的固定字段才安全，
// 也才不会因为上游随手加字段就让本机行为跟着变。
type VersionManifest struct {
	Title    string `json:"title"`
	Describe string `json:"describe"`
	Version  string `json:"version"`
	Style    string `json:"style"`
}

/* ---------- 清单解析 ---------- */

// parseManifest 解析并校验版本清单。
//
// 四项缺一不可，版本号必须像版本号，渠道必须是三种之一。任何一项不合格都返回错误：
// 损坏的远端清单绝不能被当成「有新版本」，否则用户会被引导去装一个不存在的东西。
// 数组、裸字符串、字段类型不对的 JSON 在这里一律是错误：json.Unmarshal 直接拒绝，
// 于是「清单是数组」「title 是数字」都不会悄悄变成零值清单。
//
// 开头允许一个 UTF-8 BOM：Windows 上 PowerShell 5.1 的 `Set-Content -Encoding utf8`
// 和不少编辑器都会写 BOM，而 `encoding/json` 遇到 BOM 会当成非法字符。手工改清单的
// 人多半就在这台 Windows 机器上，为这一个字节让「检查更新」报「清单无效」不值得，
// 所以这里先剥掉 BOM——只剥开头，正文里的其它字节照常按 JSON 解析。
func parseManifest(data []byte) (VersionManifest, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	var manifest VersionManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return VersionManifest{}, fmt.Errorf("清单不是合法的 JSON 对象：%w", err)
	}
	// 与前端一致：先去掉首尾空白再判空，避免只填了空格的字段看起来像填过。
	manifest.Title = strings.TrimSpace(manifest.Title)
	manifest.Describe = strings.TrimSpace(manifest.Describe)
	manifest.Version = strings.TrimSpace(manifest.Version)
	manifest.Style = strings.TrimSpace(manifest.Style)

	switch {
	case manifest.Title == "":
		return VersionManifest{}, errors.New("清单缺少标题（title）。")
	case manifest.Describe == "":
		return VersionManifest{}, errors.New("清单缺少说明（describe）。")
	case manifest.Version == "":
		return VersionManifest{}, errors.New("清单缺少版本号（version）。")
	case !versionPattern.MatchString(manifest.Version):
		return VersionManifest{}, errors.New("版本号格式不合法，应形如 1.2.3 或 1.2.3-beta。")
	case manifest.Style == "":
		return VersionManifest{}, errors.New("清单缺少发布渠道（style）。")
	case !manifestStyles[manifest.Style]:
		return VersionManifest{}, errors.New("发布渠道只能是 stable、beta 或 local。")
	}
	return manifest, nil
}

// localManifest 从站点文件系统里读 version.json；缺失或无效都返回 false。
//
// 内置站点、换成磁盘目录的站点都经过这里，所以调用方不需要关心 dist 从哪来，
// 也拿不到「字段全是零值」的假清单——那种清单会让比较结果毫无意义。
func localManifest(fsys fs.FS) (VersionManifest, bool) {
	if fsys == nil {
		return VersionManifest{}, false
	}
	data, err := fs.ReadFile(fsys, "version.json")
	if err != nil {
		return VersionManifest{}, false
	}
	manifest, err := parseManifest(data)
	if err != nil {
		return VersionManifest{}, false
	}
	return manifest, true
}

/* ---------- 版本比较 ---------- */

// versionParts 是拆开后的版本号：三段数字原样保留（不转 int，超长数字也不会溢出），
// 预发布标签按点拆开。
type versionParts struct {
	core [3]string
	pre  []string
}

// splitVersion 把版本号拆成「三段数字 + 预发布标签」；不合法时返回 false。
func splitVersion(version string) (versionParts, bool) {
	match := versionPartsPattern.FindStringSubmatch(strings.TrimSpace(version))
	if match == nil {
		return versionParts{}, false
	}
	parts := versionParts{core: [3]string{match[1], match[2], match[3]}}
	if match[4] != "" {
		for _, part := range strings.Split(match[4], ".") {
			if part != "" {
				parts.pre = append(parts.pre, part)
			}
		}
	}
	return parts, true
}

// compareVersions 比较两个版本号：a 新返回正数，相等返回 0，a 旧返回负数。
//
// 规则与 web/src/lib/siteUpdate.ts 的 compareUpdateVersions 相同：
// 先比三段数字，再比预发布标签（0.2.0 比 0.2.0-beta 新，beta.2 比 beta.10 旧，
// 数字段比字母段旧）。无法解析的版本号一律按「相等」处理：损坏的远端清单
// 不能让人以为有新版本，宁可什么都不提示。
//
// 与前端唯一的差别在「数字段数值相等但写法不同」（例如 02 与 2，这两种写法本身
// 就不合语义化版本规范）：这里按数值相等继续往下比，前端会直接返回 -1。
// 前端那种写法不满足反对称性（两个方向都判旧），照抄没有意义。
func compareVersions(a, b string) int {
	left, leftOK := splitVersion(a)
	right, rightOK := splitVersion(b)
	if !leftOK || !rightOK {
		return 0
	}
	for i := 0; i < 3; i++ {
		if c := compareNumericParts(left.core[i], right.core[i]); c != 0 {
			return c
		}
	}
	if len(left.pre) == 0 && len(right.pre) == 0 {
		return 0
	}
	// 有预发布标签的一方更旧。
	if len(left.pre) == 0 {
		return 1
	}
	if len(right.pre) == 0 {
		return -1
	}
	for i := 0; i < len(left.pre) && i < len(right.pre); i++ {
		if left.pre[i] == right.pre[i] {
			continue
		}
		return comparePreParts(left.pre[i], right.pre[i])
	}
	// 公共前缀一样长：标签更少的一方更旧（alpha < alpha.1）。
	switch {
	case len(left.pre) < len(right.pre):
		return -1
	case len(left.pre) > len(right.pre):
		return 1
	}
	return 0
}

// comparePreParts 比较两个预发布标签段：数字段按数值比，数字段比字母段旧，
// 其余按字面比较。
func comparePreParts(left, right string) int {
	leftNumeric := isDigits(left)
	rightNumeric := isDigits(right)
	switch {
	case leftNumeric && rightNumeric:
		return compareNumericParts(left, right)
	case leftNumeric:
		return -1
	case rightNumeric:
		return 1
	case left > right:
		return 1
	default:
		return -1
	}
}

// compareNumericParts 按数值比较两段纯数字。
//
// 先去掉前导零、再比长度、最后比字面：这样既不依赖 int（beta.99999999999999999999
// 这种超长数字也不会溢出排错位置），又能正确实现「beta.2 比 beta.10 旧」。
func compareNumericParts(left, right string) int {
	left = strings.TrimLeft(left, "0")
	right = strings.TrimLeft(right, "0")
	switch {
	case len(left) > len(right):
		return 1
	case len(left) < len(right):
		return -1
	case left > right:
		return 1
	case left < right:
		return -1
	}
	return 0
}

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

/* ---------- 更新源策略与取数 ---------- */

// updateFailure 是检查更新失败的分类。
//
// HTTP 层据此选择状态码：地址写错是调用方的问题（400），地址不被允许是策略拒绝
// （403），上游出错或超时是更新源的问题（502/504）。分开的另一个原因是页面文案：
// 用户看到「更新源没响应」会去换镜像，看到「地址不被允许」才该去改设置。
type updateFailure struct {
	kind    string
	message string
}

func (e *updateFailure) Error() string { return e.message }

// 失败分类。kind 不直接当 HTTP 状态码用，映射在 updateFailureResponse 里。
const (
	updateSourceInvalid   = "source_invalid"
	updateSourceForbidden = "source_forbidden"
	updateUpstreamFailed  = "upstream_failed"
	updateUpstreamTimeout = "upstream_timeout"
	updateManifestInvalid = "invalid_manifest"
)

func updateFailed(kind, message string) *updateFailure {
	return &updateFailure{kind: kind, message: message}
}

// updateFailureResponse 把失败分类映射成状态码与页面认识的错误码。
//
// 更新源被允许列表挡下是 403 permission_denied（与 web/scripts/serve.mjs 的
// 同名接口一致）：地址本身是合法的，只是服务端拒绝替它发请求，所以不是「参数写错了」。
// 地址写错（解析不了、不是清单路径）才是 400 validation_failed。
func updateFailureResponse(err error) (status int, code, message string) {
	var failure *updateFailure
	if !errors.As(err, &failure) {
		// 没有分类的错误当成上游失败：它一定来自取数/解析链路。
		return 502, "upstream_failed", err.Error()
	}
	switch failure.kind {
	case updateSourceInvalid:
		return 400, "validation_failed", failure.message
	case updateSourceForbidden:
		return 403, "permission_denied", failure.message
	case updateUpstreamTimeout:
		return 504, "upstream_timeout", failure.message
	case updateManifestInvalid:
		return 502, "upstream_failed", failure.message
	default:
		return 502, "upstream_failed", failure.message
	}
}

// manifestSource 是校验通过的更新源。
type manifestSource struct {
	raw    string // 回显给页面的地址
	remote string // 远端清单地址；本站源为空
	local  bool   // 从当前 dist 里读 /version.json
}

// manifestFetcher 按允许列表取回远端版本清单。
//
// 允许列表单独放在结构体里，是为了让测试能注入自己的主机（httptest 的地址每次都变），
// 而生产环境仍然只有官方仓库、镜像与 Gitee。这个结构体存在的根本原因是 SSRF：
// /__pp/update 虽然只对本机开放，但它仍然是一个「让服务端替我发请求」的入口，
// 如果不限制主机，本机的任何页面（包括被注入的脚本）都能借它探测内网端口、
// 读取内网服务。所以默认只认 https + 明确列出的几台主机，别的一律拒绝。
type manifestFetcher struct {
	allowed map[string]bool
	client  *http.Client
}

// manifestHosts 是生产环境允许的更新源主机：GitHub 的 raw 与网页、jsDelivr 镜像、Gitee。
var manifestHosts = []string{
	"raw.githubusercontent.com",
	"github.com",
	"cdn.jsdelivr.net",
	"gitee.com",
}

func newManifestFetcher(extraHosts ...string) *manifestFetcher {
	allowed := make(map[string]bool, len(manifestHosts)+len(extraHosts))
	for _, host := range manifestHosts {
		allowed[host] = true
	}
	for _, host := range extraHosts {
		host = strings.ToLower(strings.TrimSpace(host))
		if host != "" {
			allowed[host] = true
		}
	}
	return &manifestFetcher{allowed: allowed, client: &http.Client{}}
}

// httpClient 返回本次抓取要用的 client：复制一份并强制不跟跳转。
//
// 允许列表是按主机定的，跟一次跳转就可能落到列表外的主机上，那等于把 SSRF 防线
// 交给更新源自己决定。复制而不是改字段，是为了不把这条策略写到调用方传入的
// client 上（测试注入的是 httptest 的 client，还要继续用它的证书配置）。
// 官方地址与镜像都是直出 200，不跟跳转不会误伤。
func (f *manifestFetcher) httpClient() *http.Client {
	client := http.Client{}
	if f.client != nil {
		client = *f.client
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &client
}

// defaultManifestFetcher 是生产用的取数器：只认官方仓库与镜像。
var defaultManifestFetcher = newManifestFetcher()

// manifestFetcher 返回当前应用要用的取数器；测试注入优先。
func (a *app) manifestFetcher() *manifestFetcher {
	if a.fetcher != nil {
		return a.fetcher
	}
	return defaultManifestFetcher
}

// resolveSource 校验更新源，并区分「远端」与「本站」两种形态。
//
// 本站形态只接受 /version.json：它读的是已经打进 exe 的 dist，不产生网络请求，
// 这样离线安装也能自检清单是否与站点文件一致。远端形态只接受 https + 允许列表内
// 的主机，明文 http 会让清单在传输途中被改写（换掉版本号或下载地址）。
//
// 两种失败要分开：地址根本写错（解析不了、不是清单路径）是 400，地址合法但不被
// 允许（明文 http、主机不在列表里）是 403。页面据此能说清是「你填错了」还是
// 「这里不允许访问这个地址」。
func (f *manifestFetcher) resolveSource(raw string) (manifestSource, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		value = defaultManifestSource
	}

	if strings.HasPrefix(value, "/") {
		clean := path.Clean(value)
		if clean != localManifestPath {
			return manifestSource{}, updateFailed(updateSourceInvalid,
				"本站更新源只能是 /version.json；其它路径不会去读本机文件。")
		}
		return manifestSource{raw: localManifestPath, local: true}, nil
	}

	parsed, err := url.Parse(value)
	if err != nil {
		return manifestSource{}, updateFailed(updateSourceInvalid,
			"更新源地址无法解析，请填 https 地址或以 / 开头的本站路径。")
	}
	if parsed.Scheme == "" {
		return manifestSource{}, updateFailed(updateSourceInvalid,
			"更新源地址不合法，请填 https 地址或以 / 开头的本站路径。")
	}
	if !strings.EqualFold(parsed.Scheme, "https") {
		return manifestSource{}, updateFailed(updateSourceForbidden,
			"更新源必须是 https 地址：明文 http 会让版本清单在传输途中被改写。")
	}
	if parsed.User != nil {
		return manifestSource{}, updateFailed(updateSourceForbidden,
			"更新源里不能带用户名或密码。")
	}
	if parsed.Hostname() == "" {
		return manifestSource{}, updateFailed(updateSourceInvalid,
			"更新源缺少主机名，请填完整的 https 地址。")
	}
	if !f.hostAllowed(parsed) {
		return manifestSource{}, updateFailed(updateSourceForbidden,
			fmt.Sprintf("更新源 %s 不在允许的名单里，只能从官方仓库或镜像读取清单。", parsed.Hostname()))
	}
	return manifestSource{raw: value, remote: value}, nil
}

// hostAllowed 判断更新源主机是否在允许列表里。
//
// 列表里存的是主机名（raw.githubusercontent.com 这种）；测试注入的表项可以带端口，
// 带端口的表项要求端口也一致，免得「允许 127.0.0.1:1234」变成「允许这台机器的任何端口」。
func (f *manifestFetcher) hostAllowed(u *url.URL) bool {
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return false
	}
	if f.allowed[host] {
		return true
	}
	return u.Port() != "" && f.allowed[strings.ToLower(u.Host)]
}

// fetch 抓取远端清单：3 秒超时、只认 JSON、状态码必须是 200、正文不超过 64 KiB。
//
// 每一步都收紧一点，是为了让「远端返回了什么」不能直接影响本机：不跟跳转
// （见 httpClient，跳转目标可能跳出允许列表）、不读超长正文、不把
// 非 200 的正文当清单解析。
func (f *manifestFetcher) fetch(ctx context.Context, remote string) (VersionManifest, error) {
	ctx, cancel := context.WithTimeout(ctx, manifestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, remote, nil)
	if err != nil {
		return VersionManifest{}, updateFailed(updateSourceInvalid, "更新源地址无法使用："+err.Error())
	}
	req.Header.Set("Accept", "application/json")

	client := f.httpClient()
	res, err := client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return VersionManifest{}, updateFailed(updateUpstreamTimeout,
				"更新源在 3 秒内没有响应，稍后再试或换一个镜像。")
		}
		return VersionManifest{}, updateFailed(updateUpstreamFailed,
			"连不上更新源："+err.Error())
	}
	defer res.Body.Close()

	// 3xx 也要当失败：重定向目标可能跳出允许列表，跟随它就绕过了 SSRF 策略。
	// 官方仓库与镜像地址都是直出 200，不需要跳转。
	if res.StatusCode != http.StatusOK {
		return VersionManifest{}, updateFailed(updateUpstreamFailed,
			fmt.Sprintf("更新源返回 HTTP %d，取不到版本清单。", res.StatusCode))
	}

	body, err := io.ReadAll(io.LimitReader(res.Body, manifestBodyLimit+1))
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return VersionManifest{}, updateFailed(updateUpstreamTimeout,
				"更新源在 3 秒内没有响应，稍后再试或换一个镜像。")
		}
		return VersionManifest{}, updateFailed(updateUpstreamFailed,
			"读取更新源的响应时中断了。")
	}
	if len(body) > manifestBodyLimit {
		return VersionManifest{}, updateFailed(updateUpstreamFailed,
			fmt.Sprintf("更新源返回的清单超过 %d KiB，已拒绝。", manifestBodyLimit>>10))
	}

	manifest, err := parseManifest(body)
	if err != nil {
		return VersionManifest{}, updateFailed(updateManifestInvalid,
			"更新源返回的清单无效："+err.Error())
	}
	return manifest, nil
}

/* ---------- HTTP 接口 ---------- */

// handleUpdateCheck 在本机服务端读取版本清单，与当前站点的清单比较。
//
// 为什么要服务端做：浏览器直接 fetch GitHub 会被 CORS 挡下，而本机启动器发请求
// 没有这个限制。代价是它变成了一个「以服务端身份发请求」的入口，所以更新源必须
// 过允许列表，且这个接口本身只对本机开放（requireLocalControl）。
//
// 返回里的 reason 是 newer / same / older；本机没有可读清单时 local 字段整个省略，
// reason 记作 same 而不是猜一个 newer —— 不知道本机版本就不该提示更新。
//
// 状态码：403 是调用方不是本机或更新源被允许列表挡下，400 是地址写错，404 是本站
// 没有清单，502 是更新源出错或清单无效，504 是更新源超时。
func (a *app) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if !requireLocalControl(w, r, "只能在运行站点的这台电脑上检查更新。") {
		return
	}
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]any{"code": "method_not_allowed", "message": "只支持 GET。"})
		return
	}

	fetcher := a.manifestFetcher()
	source, err := fetcher.resolveSource(r.URL.Query().Get("source"))
	if err != nil {
		status, code, message := updateFailureResponse(err)
		writeJSON(w, status, map[string]any{"code": code, "message": message})
		return
	}

	current, _ := a.activeDist()
	local, hasLocal := localManifest(current)

	var remote VersionManifest
	if source.local {
		if !hasLocal {
			// 本站源就是「读自己的清单」，读不到说明这份构建没带清单。
			// 这与 npm start 的静态服务一致：文件不存在是 404，不是参数写错。
			writeJSON(w, 404, map[string]any{
				"code":    "not_found",
				"message": "构建产物里没有可用的 version.json，换一个更新源再试。",
			})
			return
		}
		remote = local
	} else {
		remote, err = fetcher.fetch(r.Context(), source.remote)
		if err != nil {
			status, code, message := updateFailureResponse(err)
			writeJSON(w, status, map[string]any{"code": code, "message": message})
			return
		}
	}

	body := map[string]any{
		"ok":               true,
		"source":           source.raw,
		"fetched_at":       time.Now().UTC().Format(time.RFC3339),
		"remote":           remote,
		"update_available": false,
		"reason":           "same",
	}
	if hasLocal {
		switch order := compareVersions(remote.Version, local.Version); {
		case order > 0:
			body["update_available"] = true
			body["reason"] = "newer"
		case order < 0:
			body["reason"] = "older"
		}
		body["local"] = local
	}
	writeJSON(w, 200, body)
}

// handleUpdateApply 启用本机已经准备好的新构建，不停止进程、不重启监听。
//
// 自动下载安装还没有做（服务端只会「启用本地目录」）：下载要处理校验、断点、
// 杀毒软件误报和半途失败，属于下一张票。这里先把最危险的一步——不停服换版——
// 做成可测试的：用户或未来的安装器把构建解压到任意目录，这个接口校验后原子切换。
//
// 每个校验都对应一种「切了就起不来」的情况：没有 index.html 等于没有站点入口，
// 没有合法 version.json 等于无法记录版本、也无法再检查更新，目录不存在/不是
// 绝对路径则多半是前端拼错了路径。宁可 400 也不要切成一个白屏站点。
//
// 要求 Content-Type 是 application/json 本身就是 CSRF 防线：跨域页面想发这种请求
// 会先触发预检，而启动器不回应预检，于是请求根本发不出来。
func (a *app) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	if !requireLocalControl(w, r, "只能在运行站点的这台电脑上启用新的站点文件。") {
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"code": "method_not_allowed", "message": "只支持 POST。"})
		return
	}
	if !strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		writeJSON(w, 415, map[string]any{"code": "unsupported_media_type", "message": "请求体需要是 application/json。"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, updateBodyLimit)
	var body struct {
		Dir string `json:"dir"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{
			"code":    "validation_failed",
			"message": `请求体需要是 JSON，形如 {"dir":"C:\\path\\to\\build"}。`,
		})
		return
	}

	dir := strings.TrimSpace(body.Dir)
	manifest, clean, err := buildDirManifest(dir)
	if err != nil {
		writeJSON(w, 400, map[string]any{"code": "validation_failed", "message": err.Error()})
		return
	}
	if active := a.activeDistDir(); active != "" && sameDir(active, clean) {
		writeJSON(w, 409, map[string]any{
			"code":    "already_active",
			"message": "这个目录已经是当前正在服务的站点，不需要再切换。",
		})
		return
	}

	previous := a.promote(os.DirFS(clean), manifest.Version, clean)
	// 换上的目录必须记住，否则重启启动器又回到内置版本。
	a.persistDistDir(clean)
	writeJSON(w, 200, map[string]any{
		"ok":       true,
		"version":  manifest.Version,
		"previous": previous,
		"active":   clean,
	})
}

// buildDirManifest 校验一个本机构建目录，返回它的清单与规范化后的绝对路径。
//
// 每个校验都对应一种「切了就起不来」的情况：没有 index.html 等于没有站点入口，
// 没有合法 version.json 等于无法记录版本、也无法再检查更新，目录不存在/不是
// 绝对路径则多半是前端拼错了路径。宁可 400 也不要切成一个白屏站点。
func buildDirManifest(dir string) (VersionManifest, string, error) {
	value := strings.TrimSpace(dir)
	if value == "" {
		return VersionManifest{}, "", errors.New("需要提供要启用的站点目录。")
	}
	if !filepath.IsAbs(value) {
		return VersionManifest{}, "", errors.New("站点目录必须是绝对路径。")
	}
	clean := filepath.Clean(value)
	info, err := os.Stat(clean)
	if err != nil || !info.IsDir() {
		return VersionManifest{}, "", errors.New("站点目录不存在或不是文件夹：" + clean)
	}
	index, err := os.ReadFile(filepath.Join(clean, "index.html"))
	if err != nil || len(bytes.TrimSpace(index)) == 0 {
		return VersionManifest{}, "", errors.New("站点目录里没有可读的 index.html，换一个构建目录。")
	}
	manifest, ok := localManifest(os.DirFS(clean))
	if !ok {
		return VersionManifest{}, "", errors.New("站点目录里的 version.json 缺失或无效，无法确认新版本。")
	}
	return manifest, clean, nil
}

// restoreStagedDist 在启动时重新启用上一次换上的构建目录。
//
// 只在目录仍然可用时才启用；目录被删掉、清单损坏或路径失效都回到内置版本，
// 绝不因为「上次的记录」让启动器起不来。返回版本号与是否启用成功。
func (a *app) restoreStagedDist(dir string) (string, bool) {
	if strings.TrimSpace(dir) == "" {
		return "", false
	}
	manifest, clean, err := buildDirManifest(dir)
	if err != nil {
		return "", false
	}
	a.promote(os.DirFS(clean), manifest.Version, clean)
	return manifest.Version, true
}

// sameDir 判断两个目录路径是否指同一个目录。
//
// Windows 的路径不区分大小写，同一个目录经不同写法（大小写、结尾反斜杠）进来
// 必须算同一个，否则「重复启用同一个目录」会被当成一次正常切换。
func sameDir(left, right string) bool {
	leftAbs, leftErr := filepath.Abs(filepath.Clean(left))
	rightAbs, rightErr := filepath.Abs(filepath.Clean(right))
	if leftErr != nil || rightErr != nil {
		return false
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(leftAbs, rightAbs)
	}
	return leftAbs == rightAbs
}
