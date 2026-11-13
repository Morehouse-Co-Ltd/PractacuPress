package site

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Capability is one entry of the site's capability matrix.
//
// The identifiers are shared with the frontend (`apps/web/src/lib/permissions.ts`).
// Keeping them stable is what lets the server enforce exactly the matrix the
// administrator saw in the dashboard.
type Capability string

// The capability surface of a site.
const (
	CapabilityReadContent      Capability = "read_content"
	CapabilityComment          Capability = "comment"
	CapabilityWriteContent     Capability = "write_content"
	CapabilityModerateContent  Capability = "moderate_content"
	CapabilityModerateComment  Capability = "moderate_comment"
	CapabilityManageMember     Capability = "manage_member"
	CapabilityManageSite       Capability = "manage_site"
	CapabilityViewLog          Capability = "view_log"
	CapabilityManagePermission Capability = "manage_permission"
)

// AllCapabilities is the closed set of capability ids, in display order.
var AllCapabilities = []Capability{
	CapabilityReadContent,
	CapabilityComment,
	CapabilityWriteContent,
	CapabilityModerateContent,
	CapabilityModerateComment,
	CapabilityManageMember,
	CapabilityManageSite,
	CapabilityViewLog,
	CapabilityManagePermission,
}

// PermissionSet is the expanded capability matrix of one group.
//
// A nil set means "not loaded, fall back to the server role". Every member the
// store loads carries a set, so an explicit `false` is authoritative: that is what
// makes revoking a capability effective on the next request.
type PermissionSet map[Capability]bool

// Allows reports whether the set enables capability.
func (set PermissionSet) Allows(capability Capability) bool {
	if set == nil {
		return false
	}
	return set[capability]
}

// HasAnyAdminCapability reports whether the set contains at least one dashboard
// capability. "Enter the dashboard" only means something when there is something
// to open.
func (set PermissionSet) HasAnyAdminCapability() bool {
	for _, capability := range AllCapabilities {
		if capability == CapabilityReadContent || capability == CapabilityComment {
			continue
		}
		if set[capability] {
			return true
		}
	}
	return false
}

// Built-in permission group keys. These are permanent identifiers: the display
// name can change, the key never does.
const (
	GroupGuest     = "guest"
	GroupMember    = "member"
	GroupModerator = "moderator"
	GroupAdmin     = "admin"
	GroupOwner     = "owner"
)

// BuiltinGroupKeys is the fixed order the dashboard renders the built-in groups in.
var BuiltinGroupKeys = []string{GroupGuest, GroupMember, GroupModerator, GroupAdmin, GroupOwner}

// PermissionGroup is one site's capability group.
type PermissionGroup struct {
	Key          string
	Name         string
	BaseRole     Role
	Capabilities PermissionSet
	AdminAccess  bool
	Builtin      bool
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// IsBuiltin reports whether key names one of the four fixed groups.
func IsBuiltinGroupKey(key string) bool {
	for _, candidate := range BuiltinGroupKeys {
		if candidate == key {
			return true
		}
	}
	return false
}

// GroupKeyForRole maps a server role to its built-in permission group.
func GroupKeyForRole(role Role) string {
	switch role {
	case RolePlatformAdmin:
		return GroupOwner
	case RoleSiteAdmin:
		return GroupAdmin
	case RoleEditor:
		return GroupModerator
	case RoleMember:
		return GroupMember
	default:
		return GroupMember
	}
}

// RoleForBuiltinGroup maps a built-in group key back to its server role. The
// guest group has no account, so its role is the zero value.
func RoleForBuiltinGroup(key string) (Role, bool) {
	switch key {
	case GroupGuest:
		return "", true
	case GroupMember:
		return RoleMember, true
	case GroupModerator:
		return RoleEditor, true
	case GroupAdmin:
		return RoleSiteAdmin, true
	case GroupOwner:
		return RolePlatformAdmin, true
	default:
		return "", false
	}
}

// DefaultCapabilities returns the matrix the built-in group of a role starts with.
func DefaultCapabilities(role Role) PermissionSet {
	set := PermissionSet{}
	for _, capability := range AllCapabilities {
		set[capability] = false
	}
	switch role {
	case RolePlatformAdmin:
		for _, capability := range AllCapabilities {
			set[capability] = true
		}
	case RoleSiteAdmin:
		for _, capability := range []Capability{
			CapabilityReadContent,
			CapabilityComment,
			CapabilityWriteContent,
			CapabilityModerateContent,
			CapabilityModerateComment,
			CapabilityManageMember,
			CapabilityManageSite,
			CapabilityViewLog,
			CapabilityManagePermission,
		} {
			set[capability] = true
		}
	case RoleEditor:
		for _, capability := range []Capability{
			CapabilityReadContent,
			CapabilityComment,
			CapabilityWriteContent,
			CapabilityModerateContent,
			CapabilityModerateComment,
		} {
			set[capability] = true
		}
	case RoleMember:
		for _, capability := range []Capability{
			CapabilityReadContent,
			CapabilityComment,
			CapabilityWriteContent,
		} {
			set[capability] = true
		}
	default:
		set[CapabilityReadContent] = true
	}
	return set
}

// DefaultPermissionGroups returns the groups a site starts with.
//
// The built-in labels are empty on purpose: an empty name means "use the
// interface language's built-in label", so a site that never renamed a group
// still follows Chinese or English.
func DefaultPermissionGroups() []PermissionGroup {
	return []PermissionGroup{
		{
			Key:          GroupGuest,
			BaseRole:     "",
			Capabilities: DefaultCapabilities(""),
			AdminAccess:  false,
			Builtin:      true,
		},
		{
			Key:          GroupMember,
			BaseRole:     RoleMember,
			Capabilities: DefaultCapabilities(RoleMember),
			AdminAccess:  false,
			Builtin:      true,
		},
		{
			Key:          GroupModerator,
			BaseRole:     RoleEditor,
			Capabilities: DefaultCapabilities(RoleEditor),
			AdminAccess:  true,
			Builtin:      true,
		},
		{
			Key:          GroupAdmin,
			BaseRole:     RoleSiteAdmin,
			Capabilities: DefaultCapabilities(RoleSiteAdmin),
			AdminAccess:  true,
			Builtin:      true,
		},
		{
			Key:          GroupOwner,
			BaseRole:     RolePlatformAdmin,
			Capabilities: DefaultCapabilities(RolePlatformAdmin),
			AdminAccess:  true,
			Builtin:      true,
		},
	}
}

// customGroupCapabilities is the ceiling of a custom group.
//
// A custom group may narrow a role, never exceed it: `manage_permission` and
// `platform_admin` stay exclusive to the built-in owner group so a delegated
// group can never rewrite the matrix that restricts it.
func customGroupCapabilities(role Role) PermissionSet {
	set := DefaultCapabilities(role)
	set[CapabilityManagePermission] = false
	return set
}

// builtinGroupCapabilities is the ceiling of a built-in group.
//
// The built-in groups are operator owned: an administrator may switch any
// capability off or on to express local policy, but the guest and owner rows are
// forced into the only shapes that keep the site recoverable.
func builtinGroupCapabilities(key string) PermissionSet {
	switch key {
	case GroupGuest:
		set := PermissionSet{}
		for _, capability := range AllCapabilities {
			set[capability] = false
		}
		set[CapabilityReadContent] = true
		return set
	case GroupOwner:
		set := PermissionSet{}
		for _, capability := range AllCapabilities {
			set[capability] = true
		}
		return set
	default:
		set := PermissionSet{}
		for _, capability := range AllCapabilities {
			set[capability] = true
		}
		return set
	}
}

// NormalizePermissionGroup applies the invariants the dashboard and the server
// both rely on:
//
//   - the guest group can only read content and never enters the dashboard;
//   - the owner group always keeps every capability and dashboard access;
//   - member and moderator never configure permissions;
//   - a custom group never holds manage_permission.
//
// Unknown capability ids are dropped, so a stale client cannot store a matrix the
// server does not understand.
func NormalizePermissionGroup(group PermissionGroup) PermissionGroup {
	normalized := PermissionGroup{
		Key:         group.Key,
		Name:        strings.TrimSpace(group.Name),
		BaseRole:    group.BaseRole,
		AdminAccess: group.AdminAccess,
		Builtin:     group.Builtin,
		CreatedAt:   group.CreatedAt,
		UpdatedAt:   group.UpdatedAt,
	}
	// Trim by runes, not bytes: a Chinese label of exactly 60 characters is 180
	// bytes, and slicing the byte string would leave an invalid UTF-8 tail that the
	// ent rune-count validator then rejects.
	if utf8.RuneCountInString(normalized.Name) > 60 {
		normalized.Name = string([]rune(normalized.Name)[:60])
	}

	ceiling := builtinGroupCapabilities(group.Key)
	if !group.Builtin {
		ceiling = customGroupCapabilities(group.BaseRole)
	}
	set := PermissionSet{}
	for _, capability := range AllCapabilities {
		set[capability] = group.Capabilities.Allows(capability) && ceiling.Allows(capability)
	}
	normalized.Capabilities = set

	switch group.Key {
	case GroupGuest:
		normalized.BaseRole = ""
		normalized.AdminAccess = false
	case GroupOwner:
		normalized.BaseRole = RolePlatformAdmin
		normalized.AdminAccess = true
		for _, capability := range AllCapabilities {
			normalized.Capabilities[capability] = true
		}
	case GroupMember, GroupModerator:
		normalized.Capabilities[CapabilityManagePermission] = false
	}
	if !group.Builtin {
		normalized.Capabilities[CapabilityManagePermission] = false
		// A custom group with no dashboard capability cannot justify keeping the
		// entrance open; the caller may still choose to close it explicitly.
		if normalized.AdminAccess && !normalized.Capabilities.HasAnyAdminCapability() {
			normalized.AdminAccess = false
		}
	}
	return normalized
}

// PermissionGroupInput is one create or update of a group.
//
// Key is the path parameter; the remaining fields are replace semantics, which is
// what the dashboard sends after every local edit.
type PermissionGroupInput struct {
	Name         string
	BaseRole     Role
	Capabilities []Capability
	AdminAccess  bool
}

// ErrPermissionGroupNotFound means the requested group key does not exist.
var ErrPermissionGroupNotFound = errors.New("site: permission group not found")

// ErrPermissionGroupReadOnly means the change is not allowed on the target group.
var ErrPermissionGroupReadOnly = errors.New("site: permission group is read only")

// PermissionGroupRepository is the optional persistence port behind permission
// groups. It is split from Repository so existing fakes keep compiling.
type PermissionGroupRepository interface {
	// ListPermissionGroups returns the groups of a site ordered built-in first.
	ListPermissionGroups(ctx context.Context, siteID string) ([]PermissionGroup, error)
	// UpsertPermissionGroup creates or replaces one group and records the audit
	// entry atomically. The returned group is the stored value.
	UpsertPermissionGroup(ctx context.Context, siteID string, in PermissionGroup, audit AuditEntry) (PermissionGroup, error)
	// SetMemberGroup writes the group key and the role it maps to in one update.
	SetMemberGroup(ctx context.Context, siteID, userID, groupKey string, role Role, audit AuditEntry) error
}

// ListPermissionGroups returns the capability groups of a site.
//
// Reading the matrix is not privileged: every signed-in member needs it to know
// which parts of the interface are available to it. The values themselves are not
// secret, and the server still enforces every write.
func (s *Service) ListPermissionGroups(ctx context.Context, actor Member, siteID string) ([]PermissionGroup, error) {
	if actor.SiteID != siteID || !actor.IsActive() {
		return nil, ErrPermissionDenied
	}
	return s.permissionGroups(ctx, siteID)
}

// SavePermissionGroup creates or updates one group.
//
// Only a member whose matrix holds `manage_permission` may call it, which by the
// invariants above means a built-in administrator: a custom group can never be
// granted the capability.
func (s *Service) SavePermissionGroup(
	ctx context.Context,
	actor Member,
	siteID, key string,
	in PermissionGroupInput,
	requestID string,
) (PermissionGroup, error) {
	if err := authorize(actor, siteID, ActionManagePermission); err != nil {
		return PermissionGroup{}, err
	}
	role, builtin := RoleForBuiltinGroup(key)
	if !builtin && !validCustomGroupKey(key) {
		return PermissionGroup{}, formatInvalid("group key must be 2-36 lowercase letters, digits, hyphen or underscore")
	}
	if !builtin && in.BaseRole == RolePlatformAdmin {
		// A custom group can never be handed the platform role: that would let it
		// rewrite every site's policy, and no custom group may hold the permission
		// capability anyway.
		return PermissionGroup{}, ErrPermissionGroupReadOnly
	}

	group := PermissionGroup{
		Key:          key,
		Name:         in.Name,
		BaseRole:     in.BaseRole,
		Capabilities: capabilitySetOf(in.Capabilities),
		AdminAccess:  in.AdminAccess,
		Builtin:      builtin,
	}
	if builtin {
		// Renaming is allowed; pointing a built-in group at another role is not,
		// because the role mapping is what keeps the server authorization intact.
		group.BaseRole = role
	}
	if !builtin && group.BaseRole == "" {
		group.BaseRole = RoleMember
	}
	if !builtin &&
		group.BaseRole != RoleMember &&
		group.BaseRole != RoleEditor &&
		group.BaseRole != RoleSiteAdmin {
		return PermissionGroup{}, formatInvalid("base_role must be member, editor or site_admin")
	}
	normalized := NormalizePermissionGroup(group)
	persist, ok := s.repo.(PermissionGroupRepository)
	if !ok {
		return PermissionGroup{}, errors.New("site: permission groups are not configured")
	}
	return persist.UpsertPermissionGroup(ctx, siteID, normalized, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.permission_group.saved",
		Target:    key,
		RequestID: requestID,
		Detail: map[string]any{
			"name":         normalized.Name,
			"builtin":      normalized.Builtin,
			"base_role":    string(normalized.BaseRole),
			"admin_access": normalized.AdminAccess,
		},
		At: s.now(),
	})
}

// AssignMemberGroup moves one member into a capability group.
//
// The role is updated together with the group key: the group's base role is the
// account's real server role, so every module that still authorizes by role sees
// the same decision, while the capability guard applies the finer matrix on top.
func (s *Service) AssignMemberGroup(
	ctx context.Context,
	actor Member,
	siteID, userID, groupKey string,
	requestID string,
) error {
	if err := authorize(actor, siteID, ActionManageMembers); err != nil {
		return err
	}
	group, err := s.findPermissionGroup(ctx, siteID, groupKey)
	if err != nil {
		return err
	}
	if group.Key == GroupGuest {
		return formatInvalid("the guest group has no account and cannot be assigned")
	}
	if group.BaseRole == RolePlatformAdmin && actor.Role != RolePlatformAdmin {
		return ErrPermissionDenied
	}
	if !CanAssignRole(actor, group.BaseRole) {
		return ErrPermissionDenied
	}

	target, err := s.repo.FindMember(ctx, siteID, userID)
	if err != nil {
		if errors.Is(err, ErrMemberNotFound) {
			return ErrTargetNotFound
		}
		return err
	}
	if target.Role == RolePlatformAdmin && actor.Role != RolePlatformAdmin {
		return ErrPermissionDenied
	}
	if target.Role == RolePlatformAdmin && group.BaseRole != RolePlatformAdmin {
		admins, countErr := s.repo.CountMembersByRole(ctx, siteID, RolePlatformAdmin)
		if countErr != nil {
			return countErr
		}
		if admins <= 1 {
			return ErrLastPlatformAdmin
		}
	}

	persist, ok := s.repo.(PermissionGroupRepository)
	if !ok {
		return errors.New("site: permission groups are not configured")
	}
	return persist.SetMemberGroup(ctx, siteID, userID, group.Key, group.BaseRole, AuditEntry{
		SiteID:    siteID,
		ActorID:   actor.UserID,
		Action:    "site.member.group_changed",
		Target:    userID,
		RequestID: requestID,
		Detail: map[string]any{
			"from_role":  string(target.Role),
			"to_role":    string(group.BaseRole),
			"from_group": target.GroupKey,
			"to_group":   group.Key,
		},
		At: s.now(),
	})
}

// permissionGroups loads the groups, seeding the built-in rows on first use.
//
// Seeding reads the legacy matrix from the saved design document when it exists,
// so an installation that already tuned the front-end matrix keeps its settings
// instead of silently reverting to the factory defaults.
func (s *Service) permissionGroups(ctx context.Context, siteID string) ([]PermissionGroup, error) {
	persist, ok := s.repo.(PermissionGroupRepository)
	if !ok {
		return nil, errors.New("site: permission groups are not configured")
	}
	groups, err := persist.ListPermissionGroups(ctx, siteID)
	if err != nil {
		return nil, err
	}
	present := make(map[string]struct{}, len(groups))
	for _, group := range groups {
		present[group.Key] = struct{}{}
	}

	seeds := s.seedPermissionGroups(ctx, siteID)
	seeded := false
	for _, seed := range seeds {
		if _, ok := present[seed.Key]; ok {
			continue
		}
		seeded = true
		if _, upsertErr := persist.UpsertPermissionGroup(ctx, siteID, NormalizePermissionGroup(seed), AuditEntry{}); upsertErr != nil {
			// A concurrent request may have inserted the same row; listing again
			// below returns the winning values.
			continue
		}
	}
	if !seeded {
		return groups, nil
	}
	stored, err := persist.ListPermissionGroups(ctx, siteID)
	if err != nil {
		return nil, err
	}
	if len(stored) == 0 {
		return groups, nil
	}
	return stored, nil
}

// findPermissionGroup loads one group by key.
func (s *Service) findPermissionGroup(ctx context.Context, siteID, key string) (PermissionGroup, error) {
	groups, err := s.permissionGroups(ctx, siteID)
	if err != nil {
		return PermissionGroup{}, err
	}
	for _, group := range groups {
		if group.Key == key {
			return group, nil
		}
	}
	return PermissionGroup{}, ErrPermissionGroupNotFound
}

// seedPermissionGroups returns the initial rows. A saved design document that
// already carries a matrix wins over the factory defaults.
func (s *Service) seedPermissionGroups(ctx context.Context, siteID string) []PermissionGroup {
	seeds := DefaultPermissionGroups()
	saved, err := s.repo.Customization(ctx, siteID)
	if err != nil || len(saved.Document) == 0 {
		return seeds
	}
	var document struct {
		Permissions map[string]struct {
			AdminAccess  bool            `json:"admin_access"`
			Capabilities map[string]bool `json:"capabilities"`
		} `json:"permissions"`
	}
	if err := json.Unmarshal(saved.Document, &document); err != nil || len(document.Permissions) == 0 {
		return seeds
	}
	for index := range seeds {
		legacy, ok := document.Permissions[seeds[index].Key]
		if !ok || len(legacy.Capabilities) == 0 {
			continue
		}
		set := PermissionSet{}
		for _, capability := range AllCapabilities {
			value, present := legacy.Capabilities[string(capability)]
			set[capability] = present && value
		}
		seeds[index].Capabilities = set
		seeds[index].AdminAccess = legacy.AdminAccess
	}
	return seeds
}

// capabilitySetOf expands a capability list into the full matrix.
func capabilitySetOf(capabilities []Capability) PermissionSet {
	set := PermissionSet{}
	for _, capability := range AllCapabilities {
		set[capability] = false
	}
	for _, capability := range capabilities {
		if _, known := set[capability]; known {
			set[capability] = true
		}
	}
	return set
}

// CapabilityList returns the enabled ids in display order, which is what the
// persistence layer stores and the API returns.
func (set PermissionSet) CapabilityList() []string {
	out := make([]string, 0, len(AllCapabilities))
	for _, capability := range AllCapabilities {
		if set.Allows(capability) {
			out = append(out, string(capability))
		}
	}
	sort.Strings(out)
	return out
}

// validCustomGroupKey accepts a short stable identifier. The leading letter keeps
// it distinguishable from a future status value and safe in URLs. The 36 character
// ceiling matches audit_logs.target_id: the save writes the key as the audit target,
// so a longer key would make the whole transaction fail validation.
func validCustomGroupKey(key string) bool {
	if len(key) < 2 || len(key) > 36 {
		return false
	}
	for index, char := range key {
		switch {
		case char >= 'a' && char <= 'z':
		case index > 0 && char >= '0' && char <= '9':
		case index > 0 && (char == '-' || char == '_'):
		default:
			return false
		}
	}
	return true
}
