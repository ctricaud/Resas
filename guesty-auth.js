/**
 * guesty-auth.js
 * Gestion du token OAuth2 Guesty avec cache en base SQLite.
 *
 * Usage :
 *   const { getGuestyToken } = require('./guesty-auth');
 *   const token = await getGuestyToken(db);
 *   // → "eyJra..."  (Bearer token, valide 24h)
 */

'use strict';

const GUESTY_CLIENT_ID     = '0oaqf53n8oTcDNWDY5d7';
const GUESTY_CLIENT_SECRET = '5RISAMWeMLEPfFOVxRpKu8IWG1Hu-YXAzHgsy1Odd4yECDNseBqVmafKcRHYOaB9';
const TOKEN_ENDPOINT       = 'https://open-api.guesty.com/oauth2/token';

// Marge de sécurité : on renouvelle 5 minutes avant expiration
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Initialisation de la table config (à appeler une fois au démarrage)
// ─────────────────────────────────────────────────────────────────────────────
function initConfigTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Récupère un token valide (depuis le cache ou en en demandant un nouveau)
// ─────────────────────────────────────────────────────────────────────────────
async function getGuestyToken(db) {
  // S'assurer que la table existe
  initConfigTable(db);

  // Lire le cache
  const tokenRow     = db.prepare("SELECT value FROM config WHERE key = 'guesty_token'").get();
  const expiresRow   = db.prepare("SELECT value FROM config WHERE key = 'guesty_token_expires_at'").get();

  if (tokenRow && expiresRow) {
    const expiresAt = parseInt(expiresRow.value, 10);
    if (Date.now() < expiresAt - REFRESH_MARGIN_MS) {
      // Token encore valide → on le retourne directement
      return tokenRow.value;
    }
  }

  // Token absent ou expiré → on en demande un nouveau
  console.log('[Guesty Auth] Demande d\'un nouveau token...');
  const token = await fetchNewToken();

  // Stocker dans la base (expires_in = 86400 s = 24h)
  const expiresAt = Date.now() + 86400 * 1000;
  const upsert = db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const upsertMany = db.transaction(() => {
    upsert.run('guesty_token', token);
    upsert.run('guesty_token_expires_at', String(expiresAt));
  });
  upsertMany();

  console.log('[Guesty Auth] Nouveau token stocké, valide jusqu\'à', new Date(expiresAt).toLocaleString('fr-FR'));
  return token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Appel HTTP vers l'API Guesty pour obtenir un token frais
// ─────────────────────────────────────────────────────────────────────────────
async function fetchNewToken() {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      clientId:     GUESTY_CLIENT_ID,
      clientSecret: GUESTY_CLIENT_SECRET
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`[Guesty Auth] Échec de l'obtention du token (${response.status}): ${errText}`);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error('[Guesty Auth] Réponse inattendue, pas de access_token : ' + JSON.stringify(data));
  }

  return data.access_token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaire : forcer le renouvellement (ex: si l'API répond 401)
// ─────────────────────────────────────────────────────────────────────────────
function invalidateToken(db) {
  initConfigTable(db);
  const del = db.prepare("DELETE FROM config WHERE key IN ('guesty_token', 'guesty_token_expires_at')");
  del.run();
  console.log('[Guesty Auth] Token invalidé, sera renouvelé au prochain appel.');
}

module.exports = { getGuestyToken, invalidateToken, initConfigTable };
