package plugins

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/practacu/practacu-press/packages/contracts/openapi"
	"gopkg.in/yaml.v3"
)

// ContractJSON composes the shipped OpenAPI document with every enabled
// plugin's route operations.
//
// The base document stays the single source of truth for the host API. Plugin
// operations are additive and namespaced under /plugins/{id}; a plugin cannot
// replace a host operation, add a server, or reference a shared schema. The
// result is cached until the enabled set changes.
func (h *Host) ContractJSON() ([]byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.closed {
		return nil, fmt.Errorf("plugins: host is closed")
	}
	if !h.dirty && h.contract != nil {
		return append([]byte(nil), h.contract...), nil
	}
	document, err := composeContract(h.plugins, h.order)
	if err != nil {
		return nil, err
	}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("plugins: encode composed contract: %w", err)
	}
	h.contract = encoded
	h.dirty = false
	return append([]byte(nil), encoded...), nil
}

// composeContract is pure so the merge rules can be tested without a Host.
func composeContract(plugins map[string]*Plugin, order []string) (map[string]any, error) {
	var document map[string]any
	if err := yaml.Unmarshal(openapi.YAML(), &document); err != nil {
		return nil, fmt.Errorf("plugins: decode base contract: %w", err)
	}
	if document == nil {
		return nil, fmt.Errorf("plugins: base contract is empty")
	}

	paths, ok := document["paths"].(map[string]any)
	if !ok {
		paths = make(map[string]any)
		document["paths"] = paths
	}
	tags, _ := document["tags"].([]any)
	contributors := make([]any, 0, len(order))

	for _, id := range order {
		plugin, exists := plugins[id]
		if !exists || plugin.State != StateEnabled || plugin.Manifest.Backend == nil {
			continue
		}
		added := make([]string, 0, len(plugin.Manifest.Backend.Routes))
		for _, route := range plugin.Manifest.Backend.Routes {
			fullPath := "/plugins/" + plugin.Manifest.ID + route.Path
			if _, conflict := paths[fullPath]; conflict {
				return nil, fmt.Errorf("plugins: %s contributes a duplicate contract path %s", id, fullPath)
			}
			var operation map[string]any
			if err := json.Unmarshal(route.Contract, &operation); err != nil {
				return nil, fmt.Errorf("plugins: %s route %s contract: %w", id, route.Path, err)
			}
			operation["tags"] = []any{plugin.Manifest.ID}
			operation["x-pp-plugin"] = map[string]any{
				"id":          plugin.Manifest.ID,
				"version":     plugin.Manifest.Version,
				"permissions": SortedPermissionList(plugin.Manifest.Permissions),
				"auth":        routeAuth(route),
			}
			paths[fullPath] = operation
			added = append(added, fullPath)
		}
		if len(added) == 0 {
			continue
		}
		sort.Strings(added)
		tags = append(tags, map[string]any{
			"name":        plugin.Manifest.ID,
			"description": fmt.Sprintf("%s (plugin %s %s)", plugin.Manifest.Name, plugin.Manifest.ID, plugin.Manifest.Version),
			"x-pp-plugin": true,
		})
		contributors = append(contributors, map[string]any{
			"id":      plugin.Manifest.ID,
			"name":    plugin.Manifest.Name,
			"version": plugin.Manifest.Version,
			"paths":   added,
		})
	}
	document["tags"] = tags
	if len(contributors) > 0 {
		document["x-pp-plugins"] = contributors
	}
	return document, nil
}

func routeAuth(route Route) string {
	if route.Auth == "" {
		return "public"
	}
	return route.Auth
}
