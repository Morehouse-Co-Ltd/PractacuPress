package main

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/messagingstore"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/platform/fieldcrypto"
)

// buildFieldCipher resolves the key that seals personal fields.
//
// FIELD_ENCRYPTION_KEY is the production path: a base64 32-byte AES-256 key that
// lives in the environment, not next to the data. Development and test installs
// fall back to a key file beside the database so a local site keeps its addresses
// and messages readable across restarts; the config loader already rejects that
// fallback in production.
func buildFieldCipher(cfg config.Config, logger *slog.Logger) (*fieldcrypto.Cipher, error) {
	if cfg.FieldEncryptionKey != "" {
		key, err := fieldcrypto.DecodeKey(cfg.FieldEncryptionKey)
		if err != nil {
			return nil, fmt.Errorf("FIELD_ENCRYPTION_KEY: %w", err)
		}
		cipher, err := fieldcrypto.New(key)
		if err != nil {
			return nil, fmt.Errorf("FIELD_ENCRYPTION_KEY: %w", err)
		}
		return cipher, nil
	}

	path := filepath.Join(extensionDataDir(cfg), ".field-encryption.key")
	key, err := fieldcrypto.LoadOrCreateKeyFile(path)
	if err != nil {
		return nil, fmt.Errorf("load development field key: %w", err)
	}
	logger.Warn("sealing personal fields with a key stored next to the data; "+
		"set FIELD_ENCRYPTION_KEY for a deployment", "path", path)
	cipher, err := fieldcrypto.New(key)
	if err != nil {
		return nil, err
	}
	return cipher, nil
}

// buildBackupKey resolves the key for whole-instance backup packages.
//
// A nil result means the deployment did not enable encrypted backups; the backup
// service then writes plaintext packages, which production refuses at config load.
func buildBackupKey(cfg config.Config) ([]byte, error) {
	if !cfg.BackupEncryption {
		return nil, nil
	}
	key, err := fieldcrypto.DecodeKey(cfg.BackupEncryptionKey)
	if err != nil {
		return nil, fmt.Errorf("BACKUP_ENCRYPTION_KEY: %w", err)
	}
	return key, nil
}

// runFieldBackfills seals rows written before field encryption existed.
//
// It runs on every boot and is idempotent. A failure is logged rather than fatal:
// the row stays readable (the readers pass legacy plaintext through), and the next
// boot retries. Silently skipping would be worse than a loud warning, so each
// failure is reported with the count that did succeed.
func runFieldBackfills(
	ctx context.Context,
	handle *db.DB,
	cipher *fieldcrypto.Cipher,
	logger *slog.Logger,
) {
	if cipher == nil {
		return
	}

	identities, err := authstore.BackfillIdentityEncryption(ctx, handle.Client, cipher)
	if err != nil {
		logger.Error("seal legacy identity addresses", "error", err)
	} else {
		for _, warning := range identities.Warnings {
			logger.Warn("identity address left unsealed", "detail", warning)
		}
		if identities.Sealed > 0 {
			logger.Info("sealed legacy identity addresses",
				"scanned", identities.Scanned, "sealed", identities.Sealed)
		}
	}

	messages, err := messagingstore.BackfillMessageEncryption(ctx, handle.Client, cipher)
	if err != nil {
		logger.Error("seal legacy private messages", "error", err)
	} else if messages > 0 {
		logger.Info("sealed legacy private messages", "sealed", messages)
	}
}
