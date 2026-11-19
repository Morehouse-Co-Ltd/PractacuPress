package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// The provider tests run the real flow code against httptest servers: endpoints
// are injected, so no test reaches Google or GitHub and none needs a real client
// registration.

const (
	testOAuthVerifier = "test-verifier-0123456789-0123456789-abcdefghij"
	testOAuthState    = "state-9f2c"
	testOAuthRedirect = "https://press.example/api/v1/auth/oauth/google/callback"
)

// newTestProvider builds one provider against the given endpoints. A nil client
// exercises the default 10s client path.
func newTestProvider(t *testing.T, newProvider func(string, string, OAuthEndpoints, *http.Client) (OAuthProvider, error), endpoints OAuthEndpoints) OAuthProvider {
	t.Helper()
	provider, err := newProvider("client-id", "client-secret", endpoints, nil)
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	return provider
}

// parseAuthorizeURL parses an authorize URL and its query.
func parseAuthorizeURL(t *testing.T, raw string) (string, url.Values) {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse authorize URL %q: %v", raw, err)
	}
	return parsed.Path, parsed.Query()
}

// TestOAuthGoogleAuthorizeURLCarriesPKCE pins the authorization request: OIDC
// response type, the scope set, the state and an S256 challenge derived from the
// verifier. Without the challenge the verifier would be useless at exchange time.
func TestOAuthGoogleAuthorizeURLCarriesPKCE(t *testing.T) {
	endpoints := OAuthEndpoints{
		AuthorizeURL: "https://accounts.google.test/o/oauth2/v2/auth",
		TokenURL:     "https://accounts.google.test/token",
		ProfileURL:   "https://accounts.google.test/userinfo",
	}
	provider := newTestProvider(t, NewGoogleOAuth, endpoints)

	if got := provider.Name(); got != "google" {
		t.Fatalf("Name() = %q, want google", got)
	}
	raw := provider.AuthorizeURL(testOAuthState, testOAuthVerifier, testOAuthRedirect)

	_, query := parseAuthorizeURL(t, raw)
	want := map[string]string{
		"response_type":         "code",
		"client_id":             "client-id",
		"redirect_uri":          testOAuthRedirect,
		"scope":                 "openid email profile",
		"state":                 testOAuthState,
		"code_challenge_method": "S256",
	}
	for key, expected := range want {
		if got := query.Get(key); got != expected {
			t.Errorf("query %s = %q, want %q", key, got, expected)
		}
	}
	sum := sha256.Sum256([]byte(testOAuthVerifier))
	if expected := base64.RawURLEncoding.EncodeToString(sum[:]); query.Get("code_challenge") != expected {
		t.Errorf("code_challenge = %q, want S256 of the verifier %q", query.Get("code_challenge"), expected)
	}
	if query.Get("code_verifier") != "" {
		t.Errorf("authorize URL must not leak the verifier, got %q", query.Get("code_verifier"))
	}
}

// TestOAuthGoogleExchangeSuccess checks the token request shape and the token
// mapping.
func TestOAuthGoogleExchangeSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("token method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("Content-Type"); got != "application/x-www-form-urlencoded" {
			t.Errorf("Content-Type = %q", got)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		want := map[string]string{
			"grant_type":    "authorization_code",
			"code":          "auth-code",
			"redirect_uri":  testOAuthRedirect,
			"client_id":     "client-id",
			"client_secret": "client-secret",
			"code_verifier": testOAuthVerifier,
		}
		for key, expected := range want {
			if got := r.PostForm.Get(key); got != expected {
				t.Errorf("form %s = %q, want %q", key, got, expected)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"at-1","token_type":"Bearer","expires_in":3599}`))
	}))
	defer server.Close()

	provider := newTestProvider(t, NewGoogleOAuth, OAuthEndpoints{TokenURL: server.URL})
	token, err := provider.Exchange(context.Background(), "auth-code", testOAuthVerifier, testOAuthRedirect)
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if token.AccessToken != "at-1" || token.TokenType != "Bearer" || token.ExpiresIn != 3599 {
		t.Fatalf("token = %+v, want at-1/Bearer/3599", token)
	}
}

// TestOAuthGoogleExchangeRejected covers a provider refusal: the caller must be
// able to tell "code is bad" from "the network broke".
func TestOAuthGoogleExchangeRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"Bad Request"}`))
	}))
	defer server.Close()

	provider := newTestProvider(t, NewGoogleOAuth, OAuthEndpoints{TokenURL: server.URL})
	_, err := provider.Exchange(context.Background(), "stale-code", testOAuthVerifier, testOAuthRedirect)
	if !errors.Is(err, ErrOAuthExchangeFailed) {
		t.Fatalf("Exchange error = %v, want ErrOAuthExchangeFailed", err)
	}
}

// TestOAuthGoogleFetchProfileMapsEmailVerification pins the userinfo mapping,
// including the claim that decides whether the address may be trusted.
func TestOAuthGoogleFetchProfileMapsEmailVerification(t *testing.T) {
	cases := []struct {
		name        string
		emailJSON   string
		wantSubject string
		wantEmail   string
		wantName    string
		wantAvatar  string
		wantVerify  bool
	}{
		{
			name:        "verified",
			emailJSON:   `"email":"reader@example.com","email_verified":true`,
			wantSubject: "google-sub-1",
			wantEmail:   "reader@example.com",
			wantName:    "Reader Person",
			wantAvatar:  "https://cdn.example/avatar.png",
			wantVerify:  true,
		},
		{
			name:        "unverified",
			emailJSON:   `"email":"reader@example.com","email_verified":false`,
			wantSubject: "google-sub-1",
			wantEmail:   "reader@example.com",
			wantName:    "Reader Person",
			wantAvatar:  "https://cdn.example/avatar.png",
			wantVerify:  false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body := `{"sub":"google-sub-1",` + testCase.emailJSON +
				`,"name":"Reader Person","picture":"https://cdn.example/avatar.png"}`
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := r.Header.Get("Authorization"); got != "Bearer google-token" {
					t.Errorf("Authorization = %q", got)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()

			provider := newTestProvider(t, NewGoogleOAuth, OAuthEndpoints{ProfileURL: server.URL})
			profile, err := provider.FetchProfile(context.Background(), OAuthToken{AccessToken: "google-token"})
			if err != nil {
				t.Fatalf("FetchProfile: %v", err)
			}
			if profile.Subject != testCase.wantSubject {
				t.Errorf("Subject = %q, want %q", profile.Subject, testCase.wantSubject)
			}
			if profile.Email != testCase.wantEmail {
				t.Errorf("Email = %q, want %q", profile.Email, testCase.wantEmail)
			}
			if profile.DisplayName != testCase.wantName {
				t.Errorf("DisplayName = %q, want %q", profile.DisplayName, testCase.wantName)
			}
			if profile.AvatarURL != testCase.wantAvatar {
				t.Errorf("AvatarURL = %q, want %q", profile.AvatarURL, testCase.wantAvatar)
			}
			if profile.EmailVerified != testCase.wantVerify {
				t.Errorf("EmailVerified = %v, want %v", profile.EmailVerified, testCase.wantVerify)
			}
			if got, ok := profile.Raw["sub"].(string); !ok || got != testCase.wantSubject {
				t.Errorf("Raw[sub] = %v, want %q", profile.Raw["sub"], testCase.wantSubject)
			}
		})
	}
}

// TestOAuthGithubAuthorizeURLScope pins the scope: /user/emails needs
// user:email, and without read:user the profile call is refused.
func TestOAuthGithubAuthorizeURLScope(t *testing.T) {
	endpoints := OAuthEndpoints{AuthorizeURL: "https://github.test/login/oauth/authorize"}
	provider := newTestProvider(t, NewGithubOAuth, endpoints)

	if got := provider.Name(); got != "github" {
		t.Fatalf("Name() = %q, want github", got)
	}
	_, query := parseAuthorizeURL(t, provider.AuthorizeURL(testOAuthState, testOAuthVerifier, testOAuthRedirect))
	want := map[string]string{
		"response_type": "code",
		"client_id":     "client-id",
		"redirect_uri":  testOAuthRedirect,
		"scope":         "read:user user:email",
		"state":         testOAuthState,
	}
	for key, expected := range want {
		if got := query.Get(key); got != expected {
			t.Errorf("query %s = %q, want %q", key, got, expected)
		}
	}
}

// TestOAuthGithubExchangeAsksForJSON pins the Accept header: GitHub answers form
// encoded unless JSON is requested, and the form body carries no token.
func TestOAuthGithubExchangeAsksForJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("Accept = %q, want application/json", got)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		if got := r.PostForm.Get("code"); got != "gh-code" {
			t.Errorf("form code = %q, want gh-code", got)
		}
		if got := r.PostForm.Get("client_secret"); got != "client-secret" {
			t.Errorf("form client_secret = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"gh-token","token_type":"bearer","scope":"read:user,user:email"}`))
	}))
	defer server.Close()

	provider := newTestProvider(t, NewGithubOAuth, OAuthEndpoints{TokenURL: server.URL})
	token, err := provider.Exchange(context.Background(), "gh-code", testOAuthVerifier, testOAuthRedirect)
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if token.AccessToken != "gh-token" {
		t.Fatalf("AccessToken = %q, want gh-token", token.AccessToken)
	}
}

// TestOAuthGithubFetchProfilePrefersPrimaryVerifiedEmail checks the two call
// profile: identity from /user, address from /user/emails, primary+verified
// winning over a merely verified or merely primary address.
func TestOAuthGithubFetchProfilePrefersPrimaryVerifiedEmail(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer gh-token" {
			t.Errorf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":4242,"login":"reader","name":"Reader Person","email":"","avatar_url":"https://avatars.example/u/4242"}`))
	})
	mux.HandleFunc("/user/emails", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer gh-token" {
			t.Errorf("emails Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
			{"email":"other@example.com","primary":false,"verified":true},
			{"email":"primary-unverified@example.com","primary":false,"verified":false},
			{"email":"primary@example.com","primary":true,"verified":true}
		]`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	provider := newTestProvider(t, NewGithubOAuth, OAuthEndpoints{
		ProfileURL: server.URL + "/user",
		EmailsURL:  server.URL + "/user/emails",
	})
	profile, err := provider.FetchProfile(context.Background(), OAuthToken{AccessToken: "gh-token"})
	if err != nil {
		t.Fatalf("FetchProfile: %v", err)
	}
	if profile.Subject != "4242" {
		t.Errorf("Subject = %q, want 4242", profile.Subject)
	}
	if profile.Email != "primary@example.com" {
		t.Errorf("Email = %q, want primary@example.com", profile.Email)
	}
	if !profile.EmailVerified {
		t.Error("EmailVerified = false, want true")
	}
	if profile.DisplayName != "Reader Person" {
		t.Errorf("DisplayName = %q, want Reader Person", profile.DisplayName)
	}
	if profile.AvatarURL != "https://avatars.example/u/4242" {
		t.Errorf("AvatarURL = %q", profile.AvatarURL)
	}
}

// TestOAuthGithubFetchProfileWithoutVerifiedEmail checks the cautious branch: an
// address nobody verified is kept but must not be marked verified.
func TestOAuthGithubFetchProfileWithoutVerifiedEmail(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":77,"login":"reader","name":"","email":"public@example.com","avatar_url":""}`))
	})
	mux.HandleFunc("/user/emails", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
			{"email":"primary@example.com","primary":true,"verified":false},
			{"email":"second@example.com","primary":false,"verified":false}
		]`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	provider := newTestProvider(t, NewGithubOAuth, OAuthEndpoints{
		ProfileURL: server.URL + "/user",
		EmailsURL:  server.URL + "/user/emails",
	})
	profile, err := provider.FetchProfile(context.Background(), OAuthToken{AccessToken: "gh-token"})
	if err != nil {
		t.Fatalf("FetchProfile: %v", err)
	}
	if profile.EmailVerified {
		t.Error("EmailVerified = true, want false when GitHub verified nothing")
	}
	if profile.Email != "primary@example.com" {
		t.Errorf("Email = %q, want the primary address primary@example.com", profile.Email)
	}
}

// TestOAuthGithubFetchProfileServerError checks a broken profile endpoint is
// reported as a profile failure rather than yielding an empty identity.
func TestOAuthGithubFetchProfileServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer server.Close()

	provider := newTestProvider(t, NewGithubOAuth, OAuthEndpoints{ProfileURL: server.URL + "/user"})
	_, err := provider.FetchProfile(context.Background(), OAuthToken{AccessToken: "gh-token"})
	if !errors.Is(err, ErrOAuthProfileFailed) {
		t.Fatalf("FetchProfile error = %v, want ErrOAuthProfileFailed", err)
	}
}

// TestOAuthProviderDisabledWithoutCredentials checks the configuration guard: a
// provider with no registration is reported as disabled, not as a broken flow.
func TestOAuthProviderDisabledWithoutCredentials(t *testing.T) {
	cases := []struct {
		name     string
		newFunc  func(string, string, OAuthEndpoints, *http.Client) (OAuthProvider, error)
		clientID string
		secret   string
	}{
		{name: "google", newFunc: NewGoogleOAuth},
		{name: "github", newFunc: NewGithubOAuth},
		{name: "google no secret", newFunc: NewGoogleOAuth, clientID: "client-id"},
		{name: "github no id", newFunc: NewGithubOAuth, secret: "client-secret"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			provider, err := testCase.newFunc(testCase.clientID, testCase.secret, OAuthEndpoints{}, nil)
			if !errors.Is(err, ErrOAuthProviderDisabled) {
				t.Fatalf("constructor error = %v, want ErrOAuthProviderDisabled", err)
			}
			if provider != nil {
				t.Fatalf("provider = %v, want nil", provider)
			}
		})
	}
}

// TestOAuthEndpointsAreInjectableJsonShape is a compile level guard that the
// endpoint struct keeps the four documented fields; the flow tests above depend
// on all of them being honoured.
func TestOAuthEndpointsInjectable(t *testing.T) {
	endpoints := OAuthEndpoints{
		AuthorizeURL: "https://a.example/auth",
		TokenURL:     "https://a.example/token",
		ProfileURL:   "https://a.example/profile",
		EmailsURL:    "https://a.example/emails",
	}
	encoded, err := json.Marshal(endpoints)
	if err != nil {
		t.Fatalf("marshal endpoints: %v", err)
	}
	var decoded OAuthEndpoints
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal endpoints: %v", err)
	}
	if decoded != endpoints {
		t.Fatalf("endpoints round trip = %+v, want %+v", decoded, endpoints)
	}
}
