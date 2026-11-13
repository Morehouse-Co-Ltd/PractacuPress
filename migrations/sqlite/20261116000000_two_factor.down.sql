DROP INDEX IF EXISTS recoverycode_user_id_used_at;
DROP INDEX IF EXISTS recoverycode_user_id_code_hash;
DROP TABLE IF EXISTS recovery_codes;

DROP INDEX IF EXISTS twofactor_enabled;
DROP INDEX IF EXISTS two_factors_user_id_key;
DROP TABLE IF EXISTS two_factors;
