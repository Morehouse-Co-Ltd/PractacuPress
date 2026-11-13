package captcha

import (
	"errors"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// Problem translates a guard failure into the API error model.
//
// The split follows the retry advice the visitor needs:
//
//   - 400 with `field: captcha_token` when the token is missing, refused, replayed
//     or too weak: the client has to solve the challenge again;
//   - 503 when the provider (or the site's own configuration store) could not be
//     reached: nothing is wrong with the visitor's input, so the UI should offer a
//     retry instead of blaming them.
//
// Every branch carries `details.reason` from Reason, which is the stable value the
// SPA translates.
func Problem(err error) *apperr.Problem {
	if err == nil {
		return nil
	}
	reason := Reason(err)
	field := "captcha_token"

	switch {
	case errors.Is(err, ErrTokenMissing):
		return apperr.ValidationField("captcha token is required", field, "required").
			WithDetail("reason", reason).
			WithMessage("请先完成人机验证。")

	case errors.Is(err, ErrReplay):
		return apperr.ValidationField("captcha token was already used", field, "already_used").
			WithDetail("reason", reason).
			WithMessage("这次验证已经使用过，请重新验证后再提交。")

	case errors.Is(err, ErrRejected), errors.Is(err, ErrScoreTooLow), errors.Is(err, ErrActionMismatch):
		return apperr.ValidationField("captcha token was rejected", field, "invalid").
			WithDetail("reason", reason).
			WithMessage("人机验证没有通过，请重试。")

	case errors.Is(err, ErrTimeout), errors.Is(err, ErrUpstream), errors.Is(err, ErrPolicyUnavailable):
		return apperr.New(apperr.CodeSecurityUnavailable).
			WithDetail("reason", reason).
			WithMessage("人机验证服务暂不可用，请稍后再试。")

	case errors.Is(err, ErrNotConfigured):
		// Normally unreachable: the guard treats a missing secret as "not
		// enforced". Kept so a future caller cannot turn it into an opaque 500.
		return apperr.New(apperr.CodeProviderNotConfigured).
			WithDetail("reason", reason).
			WithMessage("本站还没有配置人机验证密钥。")

	default:
		return apperr.Internal(err).WithDetail("reason", reason)
	}
}
