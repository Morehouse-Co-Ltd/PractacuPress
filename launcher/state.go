package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// launcherState is the small file the launcher keeps next to the exe (or under the
// user config directory when that folder is read only).
//
// It deliberately holds no secrets other than the site signing key: that key has to
// survive restarts, otherwise every restart would log the operator out.
type launcherState struct {
	Port      int    `json:"port,omitempty"`
	JWTKey    string `json:"jwt_key,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
	// DistDir 是上一次「手动更新」启用的站点目录。
	//
	// 换了构建却不记住，重启启动器就会悄悄退回内置版本：用户以为升级成功，第二天
	// 打开又变成旧版。启动时只在这个目录仍然可用（存在、有 index.html 与合法清单）
	// 时才启用它，目录被删掉就诚实地回到内置版本。
	DistDir string `json:"dist_dir,omitempty"`
}

func readState(file string) launcherState {
	var state launcherState
	data, err := os.ReadFile(file)
	if err != nil {
		return state
	}
	if json.Unmarshal(data, &state) != nil {
		return launcherState{}
	}
	if state.Port < 1 || state.Port > 65535 {
		state.Port = 0
	}
	return state
}

// writeState persists the launcher state, falling back to the user config
// directory when the exe folder is read only (Program Files, read only share).
//
// The signing key is the one secret in here, so it is sealed with the platform
// secret store before it reaches the disk (DPAPI on Windows). A value that is
// already sealed is written unchanged, and a legacy plain base64 value is migrated
// on the next write.
func writeState(file string, state launcherState) error {
	if state.JWTKey != "" && !isSealedSecret(state.JWTKey) {
		if raw, err := base64.StdEncoding.DecodeString(state.JWTKey); err == nil {
			// A failed seal is not fatal: keep the readable value rather than
			// refusing to save the port, and try again on the next write.
			if sealed, sealErr := sealSecret(raw); sealErr == nil {
				state.JWTKey = sealed
			}
		}
	}
	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	payload, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(file, payload, 0o644); err == nil {
		return nil
	}
	dir, dirErr := os.UserConfigDir()
	if dirErr != nil {
		return dirErr
	}
	target := filepath.Join(dir, "PractacuPress")
	if err := os.MkdirAll(target, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(target, stateName), payload, 0o644)
}

// ensureSigningKey returns the base64 PKCS#8 Ed25519 key used to sign access tokens,
// creating and persisting it the first time.
//
// Without a stable key the API mints an ephemeral one per process, so every restart
// of the launcher silently logs the operator out. The returned value is the plain
// base64 key handed to the child API; the state file keeps it sealed (see
// writeState). A state file written by an older launcher still holds plain base64,
// so reading it is accepted and the next write migrates it to the sealed form.
func ensureSigningKey(file string, state *launcherState) (string, error) {
	if state.JWTKey != "" {
		if raw, err := openSecret(state.JWTKey); err == nil {
			if key, err := x509.ParsePKCS8PrivateKey(raw); err == nil {
				if _, ok := key.(ed25519.PrivateKey); ok {
					encoded := base64.StdEncoding.EncodeToString(raw)
					if !isSealedSecret(state.JWTKey) {
						// Legacy plaintext state: rewrite it sealed (a no-op on
						// platforms without a secret store).
						state.JWTKey = encoded
						_ = writeState(file, *state)
					}
					return encoded, nil
				}
			}
		}
	}

	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		return "", err
	}
	encoded := base64.StdEncoding.EncodeToString(der)
	state.JWTKey = encoded
	if err := writeState(file, *state); err != nil {
		// A key that cannot be persisted still works for this run; the next start
		// simply mints a new one.
		return encoded, nil
	}
	return encoded, nil
}

// resolveDataDir picks where the SQLite database, uploaded media and logs live.
//
// The folder next to the exe keeps everything portable (copy the folder, keep the
// site). When that folder is read only, the user config directory is used instead.
func resolveDataDir(explicit string) string {
	if explicit != "" {
		dir, err := filepath.Abs(explicit)
		if err == nil {
			_ = os.MkdirAll(dir, 0o755)
			return dir
		}
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Join(filepath.Dir(exe), "data")
		if os.MkdirAll(dir, 0o755) == nil {
			test := filepath.Join(dir, ".pp-write-test")
			if err := os.WriteFile(test, []byte("x"), 0o644); err == nil {
				_ = os.Remove(test)
				return dir
			}
		}
	}
	if config, err := os.UserConfigDir(); err == nil {
		dir := filepath.Join(config, "PractacuPress", "data")
		if os.MkdirAll(dir, 0o755) == nil {
			return dir
		}
	}
	return "."
}

// sqliteDSN builds a file URI the pure Go SQLite driver understands.
//
// The pragmas match the ones db.SQLiteDSN sets for development: foreign keys on,
// WAL journal, and a busy timeout so the launcher's reads never collide with a
// running write. Spaces and URI delimiters are escaped; the rest of the path is
// kept verbatim because the driver, like the development script, accepts
// file:C:/path/to.db.
func sqliteDSN(path string) string {
	forward := strings.ReplaceAll(path, "\\", "/")
	forward = strings.NewReplacer(
		"%", "%25",
		" ", "%20",
		"#", "%23",
		"?", "%3F",
	).Replace(forward)
	return "file:" + forward + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
}
