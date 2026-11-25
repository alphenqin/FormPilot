PRAGMA journal_mode=WAL;
PRAGMA secure_delete=ON;
CREATE TABLE IF NOT EXISTS plans (owner TEXT NOT NULL, task TEXT NOT NULL, revision INTEGER NOT NULL, expires INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(owner,task));
CREATE TABLE IF NOT EXISTS operations (owner TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL, payload BLOB, PRIMARY KEY(owner,id));
PRAGMA user_version=1;
