// Package apperr defines the API error model.
//
// Every failure a client can observe is a Problem, serialized as
// application/problem+json (RFC 9457). This package is the only place that maps
// a failure onto an HTTP status: services and handlers describe what went wrong,
// they never choose a status code.
package apperr

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ContentType is the media type of every Problem response.
const ContentType = "application/problem+json"

const typeBase = "https://docs.practacu.press/errors/"

// Problem is a machine readable API error.
type Problem struct {
	Type      string         `json:"type"`
	Title     string         `json:"title"`
	Status    int            `json:"status"`
	Code      Code           `json:"code"`
	Message   string         `json:"message"`
	Details   map[string]any `json:"details"`
	RequestID string         `json:"request_id"`

	// cause is the underlying failure. It is logged, never serialized: the wire
	// format must not leak database, filesystem or upstream stack information.
	cause error
}

// New builds a Problem from the fixed table for code.
//
// An unknown code degrades to CodeInternal rather than inventing a status.
func New(code Code) *Problem {
	s, ok := specs[code]
	if !ok {
		code = CodeInternal
		s = specs[CodeInternal]
	}
	return &Problem{
		Type:    typeBase + string(code),
		Title:   s.title,
		Status:  s.status,
		Code:    code,
		Message: s.message,
		Details: map[string]any{},
	}
}

// Cause returns the wrapped underlying error, if any. It is what the logging
// layer records.
func (p *Problem) Cause() error { return p.cause }

// Unwrap supports errors.Is and errors.As over the wrapped cause.
func (p *Problem) Unwrap() error { return p.cause }

// Error implements the error interface.
func (p *Problem) Error() string {
	return fmt.Sprintf("%s (%d %s): %s", p.Code, p.Status, p.Title, p.Message)
}

// WithMessage replaces the user facing message, for cases where the specific
// field or resource matters to the client.
func (p *Problem) WithMessage(msg string) *Problem {
	p.Message = msg
	return p
}

// WithDetail records a structured, non sensitive detail for the client.
func (p *Problem) WithDetail(key string, value any) *Problem {
	if p.Details == nil {
		p.Details = map[string]any{}
	}
	p.Details[key] = value
	return p
}

// WithRequestID attaches the request correlation id.
func (p *Problem) WithRequestID(id string) *Problem {
	p.RequestID = id
	return p
}

// WithCause attaches the underlying error for logging.
func (p *Problem) WithCause(err error) *Problem {
	p.cause = err
	return p
}

// MarshalJSON guarantees details serializes as an object, never null.
func (p Problem) MarshalJSON() ([]byte, error) {
	type alias Problem
	if p.Details == nil {
		p.Details = map[string]any{}
	}
	return json.Marshal(alias(p))
}

// FromError normalises any error into a Problem.
//
// A nil error yields nil. A Problem is returned as is. Anything else becomes an
// opaque internal error: the original message is preserved only as the cause for
// logging and is never sent to the client.
func FromError(err error) *Problem {
	if err == nil {
		return nil
	}
	var p *Problem
	if errors.As(err, &p) {
		return p
	}
	return New(CodeInternal).WithCause(err)
}

// Is reports whether err carries code.
func Is(err error, code Code) bool {
	var p *Problem
	if !errors.As(err, &p) {
		return false
	}
	return p.Code == code
}

// The constructors below cover the codes that callers use most often.

// Validation reports a rejected request payload.
func Validation(detail string) *Problem {
	return New(CodeValidationFailed).WithDetail("reason", detail)
}

// FieldError names the input that failed and the rule it broke, in a vocabulary
// the client can translate. `Reason` stays free text for operators.
type FieldError struct {
	Field  string
	Rule   string
	Reason string
}

// Error implements the error interface.
func (e *FieldError) Error() string { return e.Reason }

// ValidationField is Validation with the machine readable field/rule attached.
//
// Both keys are optional: an empty field or rule is omitted, so a failure that cannot
// identify its input keeps today's payload shape.
func ValidationField(detail string, field, rule string) *Problem {
	p := Validation(detail)
	if field != "" {
		p.WithDetail("field", field)
	}
	if rule != "" {
		p.WithDetail("rule", rule)
	}
	return p
}

// Unauthenticated reports a missing or invalid credential.
func Unauthenticated() *Problem { return New(CodeUnauthenticated) }

// PermissionDenied reports an authenticated caller without the required grant.
func PermissionDenied() *Problem { return New(CodePermissionDenied) }

// NotFound reports a missing resource. resource is logged as a detail and must
// not contain user supplied text.
func NotFound(resource string) *Problem {
	return New(CodeNotFound).WithDetail("resource", resource)
}

// Conflict reports a state conflict, optionally with a more specific code.
func Conflict(code Code) *Problem {
	if code == "" {
		code = CodeConflict
	}
	return New(code)
}

// RateLimited reports an exceeded quota.
func RateLimited() *Problem { return New(CodeRateLimited) }

// Internal reports an unexpected failure. err is retained for logs only.
func Internal(err error) *Problem {
	p := New(CodeInternal)
	if err != nil {
		p.cause = err
	}
	return p
}
