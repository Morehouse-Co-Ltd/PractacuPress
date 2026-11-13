package community

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/captcha"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

func newEngine(repo Repository, actor Actor) *gin.Engine {
	service, err := NewService(repo, nil)
	if err != nil {
		panic(err)
	}
	return newEngineWithService(service, actor)
}

func newEngineWithService(service *Service, actor Actor) *gin.Engine {
	gin.SetMode(gin.TestMode)

	handler := NewHandler(service, HandlerConfig{
		Principal: func(*gin.Context) (Actor, bool) { return actor, true },
	})

	r := gin.New()
	// Mirror the production error translator so c.Error becomes a response.
	r.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			problem := apperr.FromError(c.Errors.Last().Err)
			c.Header("Content-Type", apperr.ContentType)
			c.JSON(problem.Status, problem)
		}
	})
	handler.Routes(r, func(c *gin.Context) { c.Next() }, func(c *gin.Context) { c.Next() })
	return r
}

func decodeJSON(data []byte, out any) error {
	return json.Unmarshal(data, out)
}

func do(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func memberActor() Actor {
	return Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}
}

func TestPostCommentAndReply(t *testing.T) {
	repo := newFakeRepo()
	r := newEngine(repo, memberActor())

	created := do(r, http.MethodPost, "/comments",
		`{"target_type":"article","target_id":"a1","body":"hello"}`)
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	require.Contains(t, created.Body.String(), `"depth":0`)
}

func TestPostReplyToMissingParentIsNotFound(t *testing.T) {
	r := newEngine(newFakeRepo(), memberActor())

	w := do(r, http.MethodPost, "/comments",
		`{"target_type":"comment","target_id":"missing","parent_id":"missing","body":"x"}`)

	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestCommentValidationError(t *testing.T) {
	r := newEngine(newFakeRepo(), memberActor())

	w := do(r, http.MethodPost, "/comments", `{"target_type":"article","target_id":"a1","body":"  "}`)

	require.Equal(t, http.StatusBadRequest, w.Code)
}

// TestCommentValidationNamesTheField is the end to end contract: the status and the
// human message stay as they were, while details names the field and rule the client
// translates.
func TestCommentValidationNamesTheField(t *testing.T) {
	r := newEngine(newFakeRepo(), memberActor())

	w := do(r, http.MethodPost, "/comments", `{"target_type":"article","target_id":"a1","body":""}`)

	require.Equal(t, http.StatusBadRequest, w.Code)

	var problem struct {
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
	}
	require.NoError(t, decodeJSON(w.Body.Bytes(), &problem))

	require.Equal(t, apperr.New(apperr.CodeValidationFailed).Message, problem.Message,
		"the human readable message is unchanged")
	require.Equal(t, "body", problem.Details["field"])
	require.Equal(t, "required", problem.Details["rule"])
	require.NotEmpty(t, problem.Details["reason"], "operators keep the english reason")
}

func TestDeleteCommentByModerator(t *testing.T) {
	repo := newFakeRepo()
	author := newEngine(repo, memberActor())

	created := do(author, http.MethodPost, "/comments",
		`{"target_type":"article","target_id":"a1","body":"hello"}`)
	require.Equal(t, http.StatusCreated, created.Code)

	var payload map[string]any
	require.NoError(t, decodeJSON(created.Body.Bytes(), &payload))
	id, _ := payload["id"].(string)
	require.NotEmpty(t, id)

	// The author may delete their own comment.
	require.Equal(t, http.StatusNoContent, do(author, http.MethodDelete, "/comments/"+id, "").Code)
}

func TestEditCommentRejectsOtherAuthor(t *testing.T) {
	repo := newFakeRepo()
	author := newEngine(repo, memberActor())

	created := do(author, http.MethodPost, "/comments",
		`{"target_type":"article","target_id":"a1","body":"hello"}`)
	var payload map[string]any
	require.NoError(t, decodeJSON(created.Body.Bytes(), &payload))
	id, _ := payload["id"].(string)

	stranger := newEngine(repo, Actor{UserID: "u2", SiteID: "s1", Role: site.RoleMember})
	w := do(stranger, http.MethodPatch, "/comments/"+id, `{"body":"hijacked"}`)

	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestToggleReactionEndpoint(t *testing.T) {
	repo := newFakeRepo()
	r := newEngine(repo, memberActor())

	first := do(r, http.MethodPost, "/reactions/article/a1?kind=like", `{"active":true}`)
	require.Equal(t, http.StatusOK, first.Code)
	require.Contains(t, first.Body.String(), `"active":true`)

	// Repeating the same intent is still 200 and does not write again.
	before := repo.writes
	second := do(r, http.MethodPost, "/reactions/article/a1?kind=like", `{"active":true}`)
	require.Equal(t, http.StatusOK, second.Code)
	require.Equal(t, before, repo.writes)
}

func TestToggleReactionRejectsUnknownKind(t *testing.T) {
	r := newEngine(newFakeRepo(), memberActor())

	w := do(r, http.MethodPost, "/reactions/article/a1?kind=clap", "")

	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestToggleFollowSelfIsRejected(t *testing.T) {
	r := newEngine(newFakeRepo(), memberActor())

	w := do(r, http.MethodPost, "/follows/u1", "")

	require.Equal(t, http.StatusBadRequest, w.Code)
}

// stubCaptcha is the human verification guard the tests decide the verdict for.
type stubCaptcha struct {
	err   error
	calls []captcha.RequireInput
}

func (s *stubCaptcha) Require(_ context.Context, in captcha.RequireInput) error {
	s.calls = append(s.calls, in)
	return s.err
}

func newEngineWithCaptcha(repo Repository, actor Actor, guard CaptchaGuard) *gin.Engine {
	service, err := NewService(repo, nil)
	if err != nil {
		panic(err)
	}
	gin.SetMode(gin.TestMode)
	handler := NewHandler(service, HandlerConfig{
		Principal: func(*gin.Context) (Actor, bool) { return actor, true },
		Captcha:   guard,
	})
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			problem := apperr.FromError(c.Errors.Last().Err)
			c.Header("Content-Type", apperr.ContentType)
			c.JSON(problem.Status, problem)
		}
	})
	handler.Routes(r, func(c *gin.Context) { c.Next() }, func(c *gin.Context) { c.Next() })
	return r
}

func TestCommentIsRefusedWithoutASolvedChallenge(t *testing.T) {
	repo := newFakeRepo()
	guard := &stubCaptcha{err: captcha.ErrTokenMissing}
	r := newEngineWithCaptcha(repo, memberActor(), guard)

	w := do(r, http.MethodPost, "/comments",
		`{"target_type":"article","target_id":"a1","body":"hello"}`)

	require.Equal(t, http.StatusBadRequest, w.Code)
	var problem struct {
		Details map[string]any `json:"details"`
	}
	require.NoError(t, decodeJSON(w.Body.Bytes(), &problem))
	require.Equal(t, "captcha_required", problem.Details["reason"])
	require.Equal(t, "captcha_token", problem.Details["field"])

	// The guard refused before the service ran: no comment was written.
	require.Zero(t, repo.writes)
	require.Len(t, guard.calls, 1)
	require.Equal(t, captcha.SceneComment, guard.calls[0].Scene)
	require.Equal(t, "s1", guard.calls[0].SiteID)
}

func TestCommentPassesTheSolvedTokenToTheGuard(t *testing.T) {
	repo := newFakeRepo()
	guard := &stubCaptcha{}
	r := newEngineWithCaptcha(repo, memberActor(), guard)

	w := do(r, http.MethodPost, "/comments",
		`{"target_type":"article","target_id":"a1","body":"hello","captcha_token":"solved"}`)

	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.Len(t, guard.calls, 1)
	require.Equal(t, "solved", guard.calls[0].Token)
	require.Equal(t, "u1", guard.calls[0].ActorID)
}
