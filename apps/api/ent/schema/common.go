// Package schema declares the persistence model.
//
// Portable by construction: string UUIDv7 primary keys, UTC timestamps, explicit
// status strings, and JSON only for payloads that are never queried. No database
// enums, arrays, partial indexes or RETURNING clauses are used, so the same model
// is valid on SQLite, MySQL and PostgreSQL (design §6.2).
//
// Foreign keys are declared as plain indexed columns rather than Ent edges. Most
// relations in this model are polymorphic (comment/reaction/bookmark targets,
// content revisions), which no single-dialect foreign key can express, so
// referential integrity is enforced by the application service inside the same
// transaction that writes the child row. Keeping every relation as a column makes
// that rule uniform.
package schema

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"

	"github.com/google/uuid"
)

// nowUTC is the single clock used by schema defaults. Storing UTC everywhere is
// what lets the API format ISO 8601 without per-dialect timezone handling.
func nowUTC() time.Time { return time.Now().UTC() }

// newID returns a time ordered UUIDv7. Application side IDs keep insert order and
// avoid depending on dialect auto increment behaviour.
func newID() string { return uuid.Must(uuid.NewV7()).String() }

// idField returns the shared UUIDv7 primary key.
func idField() ent.Field {
	return field.String("id").
		MaxLen(36).
		Unique().
		Immutable().
		DefaultFunc(newID)
}

// createdField returns the immutable creation timestamp.
func createdField() ent.Field {
	return field.Time("created_at").Immutable().Default(nowUTC)
}

// updatedField returns the maintained modification timestamp.
func updatedField() ent.Field {
	return field.Time("updated_at").Default(nowUTC).UpdateDefault(nowUTC)
}

// siteIDField returns the mandatory site scope column.
func siteIDField() ent.Field {
	return field.String("site_id").MaxLen(36).NotEmpty().Immutable()
}

// oneOf builds a schema level validator for a closed set of string values.
//
// It rejects values outside the set on write, so a typo becomes an error instead
// of a silently invalid state. The allowed set is sorted to keep error messages
// and generated docs deterministic.
func oneOf(allowed ...string) func(string) error {
	set := make(map[string]struct{}, len(allowed))
	for _, v := range allowed {
		set[v] = struct{}{}
	}
	keys := make([]string, 0, len(set))
	for v := range set {
		keys = append(keys, v)
	}
	sort.Strings(keys)
	joined := strings.Join(keys, ", ")
	return func(s string) error {
		if _, ok := set[s]; ok {
			return nil
		}
		return fmt.Errorf("must be one of: %s", joined)
	}
}
