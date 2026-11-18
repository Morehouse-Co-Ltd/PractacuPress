// Command hello is the reference WASM plugin for the plugin-host spike.
//
// It is compiled for wasip1 and therefore has no filesystem, network or
// environment access. The host writes one JSON envelope to stdin and reads one
// JSON envelope from stdout. Every capability the plugin uses is granted by the
// manifest and listed in the request's "capabilities" field.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

type envelope struct {
	ABI     string          `json:"abi"`
	Plugin  string          `json:"plugin_id"`
	Hook    string          `json:"hook"`
	Route   string          `json:"route"`
	Handler string          `json:"handler"`
	Payload json.RawMessage `json:"payload"`
}

type contentPayload struct {
	HTML   string `json:"html"`
	SiteID string `json:"site_id"`
	Kind   string `json:"kind"`
}

type routePayload struct {
	Method string              `json:"method"`
	Path   string              `json:"path"`
	Query  map[string][]string `json:"query"`
	Body   string              `json:"body"`
	SiteID string              `json:"site_id"`
	Role   string              `json:"role"`
}

func main() {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fail("read_error", err.Error())
		return
	}
	var request envelope
	if err := json.Unmarshal(raw, &request); err != nil {
		fail("bad_request", err.Error())
		return
	}
	if request.Plugin != "com.example.hello" {
		fail("unknown_plugin", "this module only serves com.example.hello")
		return
	}

	// A deliberate slow path lets the host's timeout test be a real timeout
	// instead of a mock. It is only reachable through the sample route.
	if request.Route == "/hello" && strings.Contains(string(request.Payload), `"sleep"`) {
		time.Sleep(2 * time.Second)
	}

	switch {
	case request.Hook == "content.render":
		handleRender(request.Payload)
	case request.Route != "":
		handleRoute(request)
	default:
		fail("unknown_hook", "no hook or route in request")
	}
}

func handleRender(raw json.RawMessage) {
	var payload contentPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		fail("bad_payload", err.Error())
		return
	}
	marker := fmt.Sprintf(`<div data-pp-plugin="com.example.hello" data-pp-site="%s">Hello from a sandboxed WASM plugin</div>`, htmlEscape(payload.SiteID))
	result, _ := json.Marshal(map[string]any{
		"ok": true,
		"result": map[string]any{
			"html": payload.HTML + marker,
		},
	})
	os.Stdout.Write(result)
}

func handleRoute(request envelope) {
	var payload routePayload
	if err := json.Unmarshal(request.Payload, &payload); err != nil {
		fail("bad_payload", err.Error())
		return
	}
	switch request.Route {
	case "/hello":
		body, _ := json.Marshal(map[string]any{
			"message": "hello from " + request.Plugin,
			"site_id": payload.SiteID,
			"method":  payload.Method,
		})
		respond(200, "application/json", string(body))
	case "/admin/ping":
		body, _ := json.Marshal(map[string]any{
			"role":    payload.Role,
			"message": "admin route reached",
		})
		respond(200, "application/json", string(body))
	default:
		respond(404, "application/json", `{"error":"no such plugin route"}`)
	}
}

func respond(status int, contentType, body string) {
	result, _ := json.Marshal(map[string]any{
		"ok": true,
		"result": map[string]any{
			"status":  status,
			"headers": map[string]string{"Content-Type": contentType},
			"body":    body,
		},
	})
	os.Stdout.Write(result)
}

func fail(code, message string) {
	result, _ := json.Marshal(map[string]any{
		"ok": false,
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
	os.Stdout.Write(result)
}

func htmlEscape(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return replacer.Replace(value)
}
