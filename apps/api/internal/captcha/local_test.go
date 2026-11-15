package captcha

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

func newLocalTestStore(t *testing.T, options ...func(*LocalStoreConfig)) *LocalStore {
	t.Helper()
	cfg := LocalStoreConfig{}
	for _, option := range options {
		option(&cfg)
	}
	return NewLocalStore(cfg)
}

// answerFor reads the expected answer out of the store, the way an in-process
// caller (a test, a smoke check) would. The HTTP path never sees this value.
func answerFor(t *testing.T, store *LocalStore, challengeID string) LocalAnswer {
	t.Helper()
	store.mu.Lock()
	defer store.mu.Unlock()
	stored, ok := store.challenges[challengeID]
	require.True(t, ok, "challenge %q is not pending", challengeID)
	return stored.expected
}

// issueAndSolve mints a token without a browser.
func issueAndSolve(t *testing.T, store *LocalStore, scene Scene) string {
	t.Helper()
	challenge, err := store.Issue(scene)
	require.NoError(t, err)
	token, _, err := store.Solve(challenge.ID, answerFor(t, store, challenge.ID), scene)
	require.NoError(t, err)
	return token
}

func TestLocalStoreIssuesAndRedeemsAToken(t *testing.T) {
	store := newLocalTestStore(t)
	verifier := NewVerifier(Config{Local: store})
	require.True(t, verifier.Configured(ProviderLocal), "the local provider needs no secret")
	require.Contains(t, verifier.ConfiguredProviders(), ProviderLocal)

	challenge, err := store.Issue(SceneLogin)
	require.NoError(t, err)
	require.NotEmpty(t, challenge.ID)
	require.True(t, challenge.Kind.Valid())
	require.NotEmpty(t, challenge.Prompt)
	require.False(t, challenge.ExpiresAt.IsZero())

	token, expiresAt, err := store.Solve(challenge.ID, answerFor(t, store, challenge.ID), SceneLogin)
	require.NoError(t, err)
	require.NotEmpty(t, token)
	require.True(t, expiresAt.After(time.Now()))

	result, err := verifier.Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    token,
		Scene:    SceneLogin,
	})
	require.NoError(t, err)
	require.Equal(t, ProviderLocal, result.Provider)

	// The token is single use: the second protected request is refused locally.
	_, err = verifier.Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    token,
		Scene:    SceneLogin,
	})
	require.ErrorIs(t, err, ErrReplay)
}

// TestLocalChallengeKindsRotate pins the three interactions the provider promises:
// slider, click and select. A regression that always issues one kind would make
// the "three types" claim a lie even though every single challenge still works.
func TestLocalChallengeKindsRotate(t *testing.T) {
	store := newLocalTestStore(t)
	seen := map[LocalKind]int{}

	for i := 0; i < 60; i++ {
		challenge, err := store.Issue(SceneLogin)
		require.NoError(t, err)
		seen[challenge.Kind]++

		answer := answerFor(t, store, challenge.ID)
		switch challenge.Kind {
		case LocalKindSlider:
			require.True(t, strings.HasPrefix(challenge.Background, "data:image/png;base64,"))
			require.True(t, strings.HasPrefix(challenge.Piece, "data:image/png;base64,"))
			require.Equal(t, localSliderWidth, challenge.Width)
			require.Equal(t, localSliderHeight, challenge.Height)
			require.Equal(t, localSliderPiece, challenge.PieceSize)
			require.Equal(t, localSliderWidth-localSliderPiece, challenge.MaxOffset)
			require.GreaterOrEqual(t, challenge.PieceTop, localSliderTopMargin)
			require.LessOrEqual(t, challenge.PieceTop, localSliderHeight-localSliderPiece-localSliderTopMargin)
			require.NotNil(t, answer.X, "a slider challenge must expect an X offset")
			require.GreaterOrEqual(t, *answer.X, localSliderMargin)
			require.LessOrEqual(t, *answer.X, challenge.MaxOffset-localSliderMargin)
		case LocalKindClick:
			require.True(t, strings.HasPrefix(challenge.Image, "data:image/png;base64,"))
			require.Equal(t, localClickWidth, challenge.Width)
			require.Equal(t, localClickHeight, challenge.Height)
			require.GreaterOrEqual(t, challenge.TargetCount, 3)
			require.LessOrEqual(t, challenge.TargetCount, 4)
			require.Len(t, answer.Points, challenge.TargetCount)
			assertLocalPointsInside(t, answer.Points, challenge.Width, challenge.Height)
			assertLocalPointsSeparated(t, answer.Points, localClickSpacing)
		case LocalKindSelect:
			require.True(t, strings.HasPrefix(challenge.Image, "data:image/png;base64,"))
			require.Equal(t, localSelectRows, challenge.Rows)
			require.Equal(t, localSelectCols, challenge.Cols)
			require.Equal(t, localSelectRows*localSelectCell, challenge.Height)
			require.Equal(t, localSelectCols*localSelectCell, challenge.Width)
			require.GreaterOrEqual(t, challenge.TargetCount, 3)
			require.LessOrEqual(t, challenge.TargetCount, 4)
			require.Len(t, answer.Tiles, challenge.TargetCount)
			assertLocalTilesValid(t, answer.Tiles, challenge.Rows*challenge.Cols)
		default:
			t.Fatalf("unknown challenge kind %q", challenge.Kind)
		}
	}

	for _, kind := range LocalKinds {
		require.Positive(t, seen[kind], "the provider never issued a %s challenge", kind)
	}
}

func assertLocalPointsInside(t *testing.T, points []LocalPoint, width, height int) {
	t.Helper()
	for _, point := range points {
		require.GreaterOrEqual(t, point.X, 0)
		require.Less(t, point.X, width)
		require.GreaterOrEqual(t, point.Y, 0)
		require.Less(t, point.Y, height)
	}
}

func assertLocalPointsSeparated(t *testing.T, points []LocalPoint, spacing int) {
	t.Helper()
	for i := range points {
		for j := i + 1; j < len(points); j++ {
			dx := points[i].X - points[j].X
			dy := points[i].Y - points[j].Y
			require.GreaterOrEqual(t, dx*dx+dy*dy, spacing*spacing,
				"two targets are closer than the shapes' own size")
		}
	}
}

func assertLocalTilesValid(t *testing.T, tiles []int, cells int) {
	t.Helper()
	seen := map[int]bool{}
	for _, tile := range tiles {
		require.GreaterOrEqual(t, tile, 0)
		require.Less(t, tile, cells)
		require.False(t, seen[tile], "a grid cell cannot be selected twice")
		seen[tile] = true
	}
}

// TestLocalChallengeImagesDecode proves the payload really is a picture of the
// declared size; a broken encoder would otherwise surface as a blank box in every
// form.
func TestLocalChallengeImagesDecode(t *testing.T) {
	store := newLocalTestStore(t)
	checked := map[LocalKind]bool{}

	for i := 0; i < 40 && len(checked) < len(LocalKinds); i++ {
		challenge, err := store.Issue(SceneLogin)
		require.NoError(t, err)
		if challenge.Kind == LocalKindSlider {
			background := decodeLocalImage(t, challenge.Background)
			require.Equal(t, localSliderWidth, background.Bounds().Dx())
			require.Equal(t, localSliderHeight, background.Bounds().Dy())
			piece := decodeLocalImage(t, challenge.Piece)
			require.Equal(t, localSliderPiece, piece.Bounds().Dx())
			require.Equal(t, localSliderPiece, piece.Bounds().Dy())
		} else {
			picture := decodeLocalImage(t, challenge.Image)
			require.Equal(t, challenge.Width, picture.Bounds().Dx())
			require.Equal(t, challenge.Height, picture.Bounds().Dy())
		}
		checked[challenge.Kind] = true
	}
	require.Len(t, checked, len(LocalKinds))
}

// TestLocalSliderSocketIsDarkened covers the visual premise of the slider: the
// piece is copied before the socket is shaded, so the socket centre must be darker
// than the piece centre. Without the shade the visitor could not see where to drop.
func TestLocalSliderSocketIsDarkened(t *testing.T) {
	store := newLocalTestStore(t)
	var challenge LocalChallenge
	for i := 0; i < 60; i++ {
		issued, err := store.Issue(SceneLogin)
		require.NoError(t, err)
		if issued.Kind == LocalKindSlider {
			challenge = issued
			break
		}
	}
	require.Equal(t, LocalKindSlider, challenge.Kind, "no slider challenge in 60 tries")

	background := decodeLocalImage(t, challenge.Background)
	piece := decodeLocalImage(t, challenge.Piece)
	half := localSliderPiece / 2
	socketR, socketG, socketB, _ := background.At(*answerFor(t, store, challenge.ID).X+half, challenge.PieceTop+half).RGBA()
	pieceR, pieceG, pieceB, _ := piece.At(half, half).RGBA()
	require.Less(t, int(socketR)+int(socketG)+int(socketB), int(pieceR)+int(pieceG)+int(pieceB),
		"the socket must be shaded so the visitor can see the drop target")
}

func decodeLocalImage(t *testing.T, dataURL string) image.Image {
	t.Helper()
	const prefix = "data:image/png;base64,"
	require.True(t, strings.HasPrefix(dataURL, prefix), "not a PNG data URL")
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(dataURL, prefix))
	require.NoError(t, err)
	picture, err := png.Decode(bytes.NewReader(raw))
	require.NoError(t, err)
	return picture
}

// wrongAnswer builds a plausible but incorrect answer for the challenge kind.
func wrongAnswer(t *testing.T, kind LocalKind, answer LocalAnswer) LocalAnswer {
	t.Helper()
	switch kind {
	case LocalKindSlider:
		require.NotNil(t, answer.X)
		off := *answer.X + localSliderTolerance + 1
		return LocalAnswer{X: &off}
	case LocalKindClick:
		require.NotEmpty(t, answer.Points)
		return LocalAnswer{Points: append([]LocalPoint(nil), answer.Points[1:]...)}
	case LocalKindSelect:
		require.NotEmpty(t, answer.Tiles)
		for candidate := 0; candidate < localSelectRows*localSelectCols; candidate++ {
			if !containsLocalInt(answer.Tiles, candidate) {
				tiles := append(append([]int(nil), answer.Tiles...), candidate)
				return LocalAnswer{Tiles: tiles}
			}
		}
	}
	t.Fatalf("cannot build a wrong answer for kind %q", kind)
	return LocalAnswer{}
}

// TestLocalAnswersAreCheckedPerKind walks one fresh challenge of each kind through
// the right and the wrong answer. The wrong answers are the near misses a
// tolerance bug would let through.
func TestLocalAnswersAreCheckedPerKind(t *testing.T) {
	store := newLocalTestStore(t)
	checked := map[LocalKind]bool{}

	for i := 0; i < 90 && len(checked) < len(LocalKinds); i++ {
		challenge, err := store.Issue(SceneLogin)
		require.NoError(t, err)
		if checked[challenge.Kind] {
			continue
		}
		checked[challenge.Kind] = true
		expected := answerFor(t, store, challenge.ID)

		// A wrong answer burns the challenge, so ask for a fresh one for the
		// successful attempt.
		wrong := wrongAnswer(t, challenge.Kind, expected)
		_, _, err = store.Solve(challenge.ID, wrong, SceneLogin)
		require.ErrorIs(t, err, ErrRejected, "a wrong %s answer must be refused", challenge.Kind)

		fresh, err := store.Issue(SceneLogin)
		require.NoError(t, err)
		if fresh.Kind != challenge.Kind {
			continue
		}
		_, _, err = store.Solve(fresh.ID, answerFor(t, store, fresh.ID), SceneLogin)
		require.NoError(t, err, "the right %s answer must be accepted", challenge.Kind)
	}
	require.Len(t, checked, len(LocalKinds))
}

func TestLocalChallengeIsSingleUse(t *testing.T) {
	store := newLocalTestStore(t)
	challenge, err := store.Issue(SceneRegister)
	require.NoError(t, err)
	answer := answerFor(t, store, challenge.ID)

	_, _, err = store.Solve(challenge.ID, answer, SceneRegister)
	require.NoError(t, err)

	// Re-submitting the same challenge must not mint a second token.
	_, _, err = store.Solve(challenge.ID, answer, SceneRegister)
	require.ErrorIs(t, err, ErrRejected)
}

func TestLocalWrongAnswerConsumesTheChallenge(t *testing.T) {
	store := newLocalTestStore(t)
	challenge, err := store.Issue(SceneLogin)
	require.NoError(t, err)
	answer := answerFor(t, store, challenge.ID)

	_, _, err = store.Solve(challenge.ID, wrongAnswer(t, challenge.Kind, answer), SceneLogin)
	require.ErrorIs(t, err, ErrRejected)

	// The challenge was burned by the wrong attempt, so a script cannot probe the
	// answer space on one picture.
	_, _, err = store.Solve(challenge.ID, answer, SceneLogin)
	require.ErrorIs(t, err, ErrRejected)
}

func TestLocalTokenIsBoundToItsScene(t *testing.T) {
	store := newLocalTestStore(t)
	verifier := NewVerifier(Config{Local: store})
	token := issueAndSolve(t, store, SceneLogin)

	_, err := verifier.Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    token,
		Scene:    SceneRegister,
	})
	require.ErrorIs(t, err, ErrActionMismatch)

	// A token offered to the wrong form is not burned, so the correct form can still
	// spend it: the failure is a form bug, not a solved challenge.
	_, err = verifier.Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    token,
		Scene:    SceneLogin,
	})
	require.NoError(t, err)
}

func TestLocalChallengesAndTokensExpire(t *testing.T) {
	now := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	store := newLocalTestStore(t, func(cfg *LocalStoreConfig) {
		cfg.Now = func() time.Time { return now }
		cfg.ChallengeTTL = time.Minute
		cfg.TokenTTL = 5 * time.Minute
	})

	challenge, err := store.Issue(SceneLogin)
	require.NoError(t, err)
	answer := answerFor(t, store, challenge.ID)
	now = now.Add(2 * time.Minute)
	_, _, err = store.Solve(challenge.ID, answer, SceneLogin)
	require.ErrorIs(t, err, ErrRejected, "an expired challenge must be refused")

	token := issueAndSolve(t, store, SceneLogin)
	now = now.Add(6 * time.Minute)
	_, err = NewVerifier(Config{Local: store}).Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    token,
		Scene:    SceneLogin,
	})
	require.ErrorIs(t, err, ErrRejected, "an expired token must be refused")
}

func TestLocalRedeemRequiresAnIssuedToken(t *testing.T) {
	store := newLocalTestStore(t)
	verifier := NewVerifier(Config{Local: store})

	_, err := verifier.Verify(context.Background(), Request{Provider: ProviderLocal, Token: "  "})
	require.ErrorIs(t, err, ErrTokenMissing)

	_, err = verifier.Verify(context.Background(), Request{Provider: ProviderLocal, Token: "made-up", Scene: SceneLogin})
	require.ErrorIs(t, err, ErrRejected)
}

func TestLocalProviderWithoutAStoreIsNotConfigured(t *testing.T) {
	verifier := NewVerifier(Config{})
	require.False(t, verifier.Configured(ProviderLocal))
	_, err := verifier.Verify(context.Background(), Request{Provider: ProviderLocal, Token: "x"})
	require.ErrorIs(t, err, ErrNotConfigured)
}

// localEngine mounts the captcha handler with the same problem middleware the real
// router installs, so the assertions are on the HTTP answer a browser gets.
func localEngine(t *testing.T, store *LocalStore) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(gin.CustomRecovery(func(c *gin.Context, _ any) {
		c.Status(http.StatusInternalServerError)
	}))
	engine.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) == 0 {
			return
		}
		problem, ok := c.Errors[0].Err.(*apperr.Problem)
		if !ok {
			return
		}
		c.AbortWithStatusJSON(problem.Status, problem)
	})
	NewHandler(HandlerConfig{
		Local:     store,
		RequestID: func(*gin.Context) string { return "req-local" },
	}).Routes(engine.Group("/api/v1"))
	return engine
}

func getLocalChallenge(t *testing.T, engine *gin.Engine, scene string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet, "/api/v1/captcha/local/challenge?scene="+scene, nil,
	))
	return recorder
}

func postLocalVerify(t *testing.T, engine *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/captcha/local/verify", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, request)
	return recorder
}

func TestLocalEndpointsIssueAndSolveAChallenge(t *testing.T) {
	store := newLocalTestStore(t)
	engine := localEngine(t, store)

	recorder := getLocalChallenge(t, engine, "login")
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
	var challenge LocalChallenge
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &challenge))
	require.NotEmpty(t, challenge.ID)
	require.True(t, challenge.Kind.Valid())
	require.NotContains(t, recorder.Body.String(), "answer", "the response must not carry the answer")

	expected := answerFor(t, store, challenge.ID)
	payload, err := json.Marshal(map[string]any{
		"challenge_id": challenge.ID,
		"answer":       expected,
		"scene":        "login",
	})
	require.NoError(t, err)

	solved := postLocalVerify(t, engine, string(payload))
	require.Equal(t, http.StatusOK, solved.Code)
	var solvedBody localVerifyResponse
	require.NoError(t, json.Unmarshal(solved.Body.Bytes(), &solvedBody))
	require.NotEmpty(t, solvedBody.Token)
	require.False(t, solvedBody.ExpiresAt.IsZero())

	// The token the endpoint returned is exactly what the protected handler's
	// verifier path accepts.
	_, err = NewVerifier(Config{Local: store}).Verify(context.Background(), Request{
		Provider: ProviderLocal,
		Token:    solvedBody.Token,
		Scene:    SceneLogin,
	})
	require.NoError(t, err)
}

func TestLocalVerifyRefusesAWrongAnswer(t *testing.T) {
	store := newLocalTestStore(t)
	engine := localEngine(t, store)
	challengeRecorder := getLocalChallenge(t, engine, "login")
	var challenge LocalChallenge
	require.NoError(t, json.Unmarshal(challengeRecorder.Body.Bytes(), &challenge))
	answer := wrongAnswer(t, challenge.Kind, answerFor(t, store, challenge.ID))

	payload, err := json.Marshal(map[string]any{
		"challenge_id": challenge.ID,
		"answer":       answer,
		"scene":        "login",
	})
	require.NoError(t, err)

	recorder := postLocalVerify(t, engine, string(payload))
	require.Equal(t, http.StatusBadRequest, recorder.Code)
	var problem apperr.Problem
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &problem))
	require.Equal(t, apperr.CodeValidationFailed, problem.Code)
	require.Equal(t, "captcha_invalid", problem.Details["reason"])
	require.Equal(t, "req-local", problem.RequestID)
}

func TestLocalEndpointsValidateTheirInput(t *testing.T) {
	engine := localEngine(t, newLocalTestStore(t))

	missingScene := getLocalChallenge(t, engine, "")
	require.Equal(t, http.StatusBadRequest, missingScene.Code)

	unknownScene := getLocalChallenge(t, engine, "mystery")
	require.Equal(t, http.StatusBadRequest, unknownScene.Code)

	missingBody := postLocalVerify(t, engine, `{}`)
	require.Equal(t, http.StatusBadRequest, missingBody.Code)

	missingAnswer := postLocalVerify(t, engine, `{"challenge_id":"x","scene":"login"}`)
	require.Equal(t, http.StatusBadRequest, missingAnswer.Code)
	var problem apperr.Problem
	require.NoError(t, json.Unmarshal(missingAnswer.Body.Bytes(), &problem))
	require.Equal(t, "answer_required", problem.Details["reason"])

	malformed := postLocalVerify(t, engine, `not json`)
	require.Equal(t, http.StatusBadRequest, malformed.Code)
}

func TestLocalEndpointsAnswerUnavailableWithoutAStore(t *testing.T) {
	engine := localEngine(t, nil)

	for _, recorder := range []*httptest.ResponseRecorder{
		getLocalChallenge(t, engine, "login"),
		postLocalVerify(t, engine, `{"challenge_id":"x","answer":{"x":1},"scene":"login"}`),
	} {
		require.Equal(t, http.StatusServiceUnavailable, recorder.Code)
		var problem apperr.Problem
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &problem))
		require.Equal(t, apperr.CodeSecurityUnavailable, problem.Code)
		require.Equal(t, "captcha_unavailable", problem.Details["reason"])
	}
}

// TestGuardEnforcesTheLocalProvider is the end-to-end local path through the guard:
// the site selected the local provider without a site key, the process wires the
// store, and a protected request must present a token the store issued.
func TestGuardEnforcesTheLocalProvider(t *testing.T) {
	store := newLocalTestStore(t)
	document := []byte(`{"verification":{"enabled":true,"provider":"local",` +
		`"site_key":"","on_login":true,"on_register":true}}`)
	guard := NewGuard(GuardConfig{
		Verifier:      NewVerifier(Config{Local: store}),
		Customization: func(context.Context, string) ([]byte, error) { return document, nil },
	})

	policy, err := guard.Policy(context.Background(), "site")
	require.NoError(t, err)
	require.True(t, policy.SecretConfigured)
	require.True(t, policy.Effective, "the local provider needs no site key or secret")
	require.True(t, policy.SceneEnforced(SceneLogin))

	// Without a token the protected request is refused and never reaches a provider.
	err = guard.Require(context.Background(), RequireInput{SiteID: "site", Scene: SceneLogin})
	require.ErrorIs(t, err, ErrTokenMissing)

	token := issueAndSolve(t, store, SceneLogin)
	require.NoError(t, guard.Require(context.Background(), RequireInput{
		SiteID: "site", Scene: SceneLogin, Token: token,
	}))
}

// TestLocalIssuedKindsStayWithinTheAdvertisedVocabulary protects the JSON contract
// the frontend switches on: an unknown kind would render nothing and lock every
// protected form.
func TestLocalIssuedKindsStayWithinTheAdvertisedVocabulary(t *testing.T) {
	store := newLocalTestStore(t)
	advertised := map[string]bool{}
	for _, kind := range LocalKinds {
		advertised[string(kind)] = true
	}
	for i := 0; i < 30; i++ {
		challenge, err := store.Issue(SceneLogin)
		require.NoError(t, err)
		require.Contains(t, advertised, string(challenge.Kind))
	}
	require.Equal(t, []LocalKind{LocalKindSlider, LocalKindClick, LocalKindSelect}, LocalKinds)
}

func TestLocalAnswerEmptyDetectsMissingSolution(t *testing.T) {
	require.True(t, LocalAnswer{}.Empty())
	x := 4
	require.False(t, LocalAnswer{X: &x}.Empty())
	require.False(t, LocalAnswer{Points: []LocalPoint{{X: 1, Y: 2}}}.Empty())
	require.False(t, LocalAnswer{Tiles: []int{0}}.Empty())
}

// TestLocalDecoyShapesNeverContainTheTarget keeps the two "find the shape" kinds
// solvable: a decoy star in the click picture (or a decoy circle in the select
// grid) would make the prompt wrong instead of the visitor wrong.
func TestLocalDecoyShapesNeverContainTheTarget(t *testing.T) {
	require.NotContains(t, localClickDecoys, "star")
	require.NotContains(t, localSelectDecoys, "circle")
}

// TestLocalVerifyRejectsAShapeFromAnotherKind keeps the three answer shapes apart:
// a select answer submitted to a click challenge must not accidentally match.
func TestLocalVerifyRejectsAShapeFromAnotherKind(t *testing.T) {
	store := newLocalTestStore(t)
	for i := 0; i < 60; i++ {
		challenge, err := store.Issue(SceneLogin)
		require.NoError(t, err)
		switch challenge.Kind {
		case LocalKindClick:
			_, _, err = store.Solve(challenge.ID, LocalAnswer{Tiles: []int{0, 1}}, SceneLogin)
			require.ErrorIs(t, err, ErrRejected)
			return
		case LocalKindSelect:
			_, _, err = store.Solve(challenge.ID, LocalAnswer{Points: []LocalPoint{{X: 1, Y: 1}}}, SceneLogin)
			require.ErrorIs(t, err, ErrRejected)
			return
		}
	}
	t.Fatal("no click or select challenge in 60 tries")
}
