CREATE TABLE IF NOT EXISTS execution_locks (owner TEXT PRIMARY KEY, execution TEXT NOT NULL, expires INTEGER NOT NULL);
PRAGMA user_version=2;
