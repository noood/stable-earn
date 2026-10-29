-- Public wallet addresses belong to the signed-in user, independently of exchange keys.
CREATE TABLE IF NOT EXISTS wallet_configs (
  user_id TEXT PRIMARY KEY,
  address TEXT NOT NULL CHECK (
    length(address) = 42 AND substr(address, 1, 2) = '0x'
    AND substr(address, 3) NOT GLOB '*[^0-9a-f]*'
    AND address != '0x0000000000000000000000000000000000000000'
  ),
  updated_at TEXT NOT NULL
);
