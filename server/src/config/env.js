/**
 * Loads and validates environment variables once, at start-up.
 * Failing fast here is better than failing later while encrypting a customer's PAN.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const HEX_64 = /^[0-9a-fA-F]{64}$/;

function requireHexKey(name) {
  const value = process.env[name];
  if (!value || !HEX_64.test(value)) {
    throw new Error(
      `${name} must be set to 64 hex characters (32 bytes). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return Buffer.from(value, 'hex');
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  databaseUrl: process.env.DATABASE_URL,
  encryptionKey: requireHexKey('ENCRYPTION_KEY'),
  hashKey: requireHexKey('HASH_KEY'),
};

if (!env.databaseUrl) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
}

module.exports = env;
