'use strict';

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const initSqlJs  = require('sql.js');

const app  = express();
const PORT = 3010;
const DB_PATH = path.join(__dirname, 'reservations.db');

// ── Credentials Guesty ───────────────────────────────────────────────────────
const GUESTY_CLIENT_ID     = '0oaqf53n8oTcDNWDY5d7';
const GUESTY_CLIENT_SECRET = '5RISAMWeMLEPfFOVxRpKu8IWG1Hu-YXAzHgsy1Odd4yECDNseBqVmafKcRHYOaB9';
const GUESTY_TOKEN_URL     = 'https://open-api.guesty.com/oauth2/token';
const REFRESH_MARGIN_MS    = 5 * 60 * 1000; // renouveler 5 min avant expiration

// ── Fichiers statiques ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Chargement de la base ────────────────────────────────────────────────────
let db;

async function startServer() {
  const SQL  = await initSqlJs();
  const file = fs.readFileSync(DB_PATH);
  db = new SQL.Database(file);

  console.log('✅  Base SQLite chargée depuis', DB_PATH);

  // ── Helpers SQL ─────────────────────────────────────────────────────────────

  // SELECT → tableau d'objets
  function query(sql, params = []) {
    const stmt    = db.prepare(sql);
    const results = [];
    stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  // INSERT / UPDATE / CREATE → et sauvegarde sur disque
  function run(sql, params = []) {
    db.run(sql, params);
    saveDb();
  }

  // Persiste la base en mémoire vers le fichier .db
  function saveDb() {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }

  // ── Table config (token Guesty, etc.) ───────────────────────────────────────
  run(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // ── Guesty Auth ─────────────────────────────────────────────────────────────

  // Retourne un token valide (cache ou nouveau)
  async function getGuestyToken() {
    const rows = query("SELECT key, value FROM config WHERE key IN ('guesty_token', 'guesty_token_expires_at')");
    const cache = {};
    rows.forEach(r => { cache[r.key] = r.value; });

    if (cache['guesty_token'] && cache['guesty_token_expires_at']) {
      const expiresAt = parseInt(cache['guesty_token_expires_at'], 10);
      if (Date.now() < expiresAt - REFRESH_MARGIN_MS) {
        return cache['guesty_token']; // token encore valide
      }
    }

    // Token absent ou expiré → en demander un nouveau
    console.log('[Guesty] Demande d\'un nouveau token...');
    const guestyParams = new URLSearchParams();
    guestyParams.append('grant_type',    'client_credentials');
    guestyParams.append('client_id',     GUESTY_CLIENT_ID);
    guestyParams.append('client_secret', GUESTY_CLIENT_SECRET);
    guestyParams.append('scope',         'open-api');
    const response = await fetch(GUESTY_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body:    guestyParams.toString()
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Guesty token error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    if (!data.access_token) throw new Error('Réponse Guesty sans access_token : ' + JSON.stringify(data));

    const expiresAt = Date.now() + 86400 * 1000; // 24h
    run(`INSERT INTO config (key, value) VALUES ('guesty_token', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [data.access_token]);
    run(`INSERT INTO config (key, value) VALUES ('guesty_token_expires_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(expiresAt)]);

    console.log('[Guesty] Nouveau token stocké, valide jusqu\'au', new Date(expiresAt).toLocaleString('fr-FR'));
    return data.access_token;
  }

  // Invalide le token en cache (à appeler si l'API répond 401)
  function invalidateGuestyToken() {
    run("DELETE FROM config WHERE key IN ('guesty_token', 'guesty_token_expires_at')");
    console.log('[Guesty] Token invalidé.');
  }

  // ── Helper : fetch paginé Guesty ─────────────────────────────────────────────
  async function guestyGetAll(token, endpoint, fields) {
    const PAGE = 100;
    let skip   = 0;
    let all    = [];
    while (true) {
      const url      = `https://open-api.guesty.com/v1${endpoint}?limit=${PAGE}&skip=${skip}&fields=${encodeURIComponent(fields)}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      });
      if (!response.ok) {
        const txt = await response.text();
        throw new Error(`Guesty GET ${endpoint} (${response.status}): ${txt}`);
      }
      const json    = await response.json();
      const results = json.results || (json.data && json.data.results) || [];
      const total   = json.count  || json.total || 0;
      all = all.concat(results);
      if (results.length < PAGE || all.length >= total) break;
      skip += PAGE;
    }
    return all;
  }

  // ── Helpers HTML communs ─────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderLogBox(log) {
    if (!log || log.length === 0) return '<div class="empty-log">Aucune opération effectuée.</div>';
    return log.map(e => {
      const cls = {
        info: 'log-info', ok: 'log-ok', ajout: 'log-ajout',
        maj: 'log-maj', suppr: 'log-suppr', warn: 'log-warn', err: 'log-err'
      }[e.type] || 'log-info';
      return `<div class="${cls}">${escHtml(e.msg)}</div>`;
    }).join('\n');
  }

  function pageShell(title, subtitle, bodyContent) {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>${escHtml(title)} — Suivi Réservations</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; color: #e8e8e8; font-family: 'Nunito', sans-serif; min-height: 100vh; padding: 2rem; }
    h1   { font-family: 'Bebas Neue', sans-serif; font-size: 2.4rem; letter-spacing: .08em;
           background: linear-gradient(135deg, #f5c842, #e8a020); -webkit-background-clip: text;
           -webkit-text-fill-color: transparent; margin-bottom: .4rem; }
    .subtitle { color: #888; font-size: .9rem; margin-bottom: 2rem; }
    .card  { background: #141414; border: 1px solid #2a2a2a; border-radius: 12px; padding: 1.8rem; margin-bottom: 1.5rem; }
    .card h2 { font-family: 'Bebas Neue', sans-serif; font-size: 1.4rem; letter-spacing: .06em;
               color: #f5c842; margin-bottom: 1rem; }
    p    { line-height: 1.6; color: #bbb; margin-bottom: .8rem; }
    .notice { background: #1a1500; border: 1px solid #3a2f00; border-radius: 8px;
              padding: .9rem 1.1rem; color: #c8a020; font-size: .88rem; margin-bottom: 1rem; }
    .btn { display: inline-block; padding: .75rem 2rem; border-radius: 8px;
           font-family: 'Nunito', sans-serif; font-weight: 700; font-size: 1rem;
           cursor: pointer; border: none; transition: all .2s; text-decoration: none; }
    .btn-gold { background: linear-gradient(135deg, #f5c842, #e8a020); color: #0a0a0a; }
    .btn-gold:hover { transform: translateY(-2px); box-shadow: 0 4px 20px rgba(245,200,66,.35); }
    .btn-back { background: #1e1e1e; color: #888; border: 1px solid #333; margin-left: 1rem; }
    .btn-back:hover { color: #e8e8e8; border-color: #555; }
    .log-box   { background: #0d0d0d; border: 1px solid #2a2a2a; border-radius: 8px;
                 padding: 1.2rem; font-family: 'Courier New', monospace; font-size: .82rem;
                 max-height: 560px; overflow-y: auto; line-height: 1.7; }
    .log-info  { color: #7a7a7a; }
    .log-ok    { color: #4caf82; }
    .log-ajout { color: #56b4d3; }
    .log-maj   { color: #f5c842; }
    .log-suppr { color: #e06c75; }
    .log-warn  { color: #e8a020; }
    .log-err   { color: #ff6b6b; font-weight: bold; }
    .empty-log { color: #444; font-style: italic; padding: .5rem 0; }
    form { display: inline; }
  </style>
</head>
<body>
  <h1>${escHtml(title)}</h1>
  <p class="subtitle">${subtitle}</p>
  ${bodyContent}
</body>
</html>`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── Pages HTML statiques ────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.get('/reservations', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'reservations.html')));

  app.get('/listings', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'listings.html')));

  app.get('/suivi-prises', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'suivi-prises.html')));

  app.get('/owners', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'owners.html')));

  // ═══════════════════════════════════════════════════════════════════════════
  // ── MAJ Propriétaires (/maj-owners) ────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/maj-owners', (req, res) => {
    res.send(pageShell(
      'MAJ Propriétaires',
      'Synchronisation avec l\'API Guesty — table <code>owners</code>',
      `<div class="card">
        <h2>Lancer la synchronisation</h2>
        <p>Cette opération interroge l'API Guesty, compare avec la base locale et applique les ajouts, mises à jour et suppressions nécessaires.</p>
        <p>Les propriétaires encore rattachés à des listings ne seront <strong>pas supprimés</strong> (protection d'intégrité).</p>
        <form method="POST" action="/maj-owners">
          <button type="submit" class="btn btn-gold">🔄 Synchroniser maintenant</button>
        </form>
        <a href="/" class="btn btn-back">← Accueil</a>
      </div>`
    ));
  });

  app.post('/maj-owners', async (req, res) => {
    const log = [];
    const ts  = new Date().toLocaleString('fr-FR');
    log.push({ type: 'info', msg: `Synchronisation démarrée le ${ts}` });

    try {
      // 1. Token
      log.push({ type: 'info', msg: 'Récupération du token Guesty…' });
      const token = await getGuestyToken();
      log.push({ type: 'ok',   msg: 'Token obtenu.' });

      // 2. Owners depuis Guesty
      log.push({ type: 'info', msg: 'Récupération des propriétaires depuis Guesty…' });
      const remote = await guestyGetAll(token, '/owners', '_id firstName lastName fullName');
      log.push({ type: 'ok',   msg: `${remote.length} propriétaire(s) reçu(s) depuis Guesty.` });

      // Normaliser le nom affiché
      const ownerNom = o => {
        if (o.fullName && o.fullName.trim()) return o.fullName.trim();
        return [o.firstName, o.lastName].filter(Boolean).map(s => s.trim()).join(' ') || '(sans nom)';
      };

      // 3. Diff local ↔ distant
      const localRows = query('SELECT id, nom FROM owners');
      const localMap  = new Map(localRows.map(r => [r.id, r.nom]));
      const remoteMap = new Map(remote.map(o => [o._id, ownerNom(o)]));

      let nbAjout = 0, nbMaj = 0, nbSupp = 0, nbInchange = 0;

      // Ajouts & mises à jour
      for (const [id, nom] of remoteMap) {
        if (!localMap.has(id)) {
          run('INSERT INTO owners (id, nom) VALUES (?, ?)', [id, nom]);
          log.push({ type: 'ajout', msg: `AJOUT    [${id}] → "${nom}"` });
          nbAjout++;
        } else if (localMap.get(id) !== nom) {
          run('UPDATE owners SET nom = ? WHERE id = ?', [nom, id]);
          log.push({ type: 'maj', msg: `MAJ      [${id}] "${localMap.get(id)}" → "${nom}"` });
          nbMaj++;
        } else {
          nbInchange++;
        }
      }

      // Suppressions — seulement si plus aucun listing rattaché
      for (const [id, nom] of localMap) {
        if (!remoteMap.has(id)) {
          const count = query('SELECT COUNT(*) AS c FROM listings WHERE owner_id = ?', [id])[0].c;
          if (count > 0) {
            log.push({ type: 'warn', msg: `SKIP SUPPR [${id}] "${nom}" — encore utilisé par ${count} listing(s)` });
          } else {
            run('DELETE FROM owners WHERE id = ?', [id]);
            log.push({ type: 'suppr', msg: `SUPPRIMÉ [${id}] "${nom}"` });
            nbSupp++;
          }
        }
      }

      log.push({ type: 'info', msg: '─────────────────────────────' });
      log.push({ type: 'ok',   msg: `Résumé : ${nbAjout} ajout(s), ${nbMaj} mise(s) à jour, ${nbSupp} suppression(s), ${nbInchange} inchangé(s).` });

    } catch (err) {
      log.push({ type: 'err', msg: `ERREUR : ${err.message}` });
      console.error('[maj-owners]', err);
    }

    res.send(pageShell(
      'MAJ Propriétaires',
      'Synchronisation avec l\'API Guesty — table <code>owners</code>',
      `<div class="card">
        <h2>Lancer une nouvelle synchronisation</h2>
        <form method="POST" action="/maj-owners">
          <button type="submit" class="btn btn-gold">🔄 Synchroniser à nouveau</button>
        </form>
        <a href="/" class="btn btn-back">← Accueil</a>
      </div>
      <div class="card">
        <h2>Journal des opérations</h2>
        <div class="log-box">${renderLogBox(log)}</div>
      </div>`
    ));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── MAJ Propriétés (/maj-listings) ─────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/maj-listings', (req, res) => {
    res.send(pageShell(
      'MAJ Propriétés',
      'Synchronisation avec l\'API Guesty — table <code>listings</code>',
      `<div class="card">
        <h2>Lancer la synchronisation</h2>
        <p>Cette opération interroge l'API Guesty, compare avec la base locale et applique les ajouts et mises à jour nécessaires.</p>
        <div class="notice">
          ⚠️ Les listings absents de Guesty sont <strong>désactivés</strong> (pas supprimés) pour préserver l'historique des réservations.<br>
          Les champs de formules (<code>comm</code>, <code>revenue_net</code>, <code>commission_f</code>, <code>versement_f</code>) ne sont <strong>pas écrasés</strong> — ils restent gérés manuellement.
        </div>
        <form method="POST" action="/maj-listings">
          <button type="submit" class="btn btn-gold">🔄 Synchroniser maintenant</button>
        </form>
        <a href="/" class="btn btn-back">← Accueil</a>
      </div>`
    ));
  });

  app.post('/maj-listings', async (req, res) => {
    const log = [];
    const ts  = new Date().toLocaleString('fr-FR');
    log.push({ type: 'info', msg: `Synchronisation démarrée le ${ts}` });

    // Champs comparés — on ne touche PAS aux formules gérées manuellement
    const COMPARE = ['nom', 'owner_id', 'titre', 'active', 'menage', 'external_url', 'type'];

    // Normaliser un objet Guesty en ligne DB
    const normalize = g => {
      const ownerId = (g.owners && g.owners.length > 0)
        ? (g.owners[0]._id || g.owners[0].id || null) : null;
      const extUrl  = (g.externalLinks && g.externalLinks.length > 0)
        ? g.externalLinks[0].url : null;
      const menage  = g.cleaningFee != null ? g.cleaningFee
                    : (g.prices && g.prices.cleaningFee != null ? g.prices.cleaningFee : null);
      return {
        id:           g._id,
        nom:          g.nickname || g.title || '(sans nom)',
        owner_id:     ownerId,
        titre:        g.title    || null,
        active:       g.active   ? 1 : 0,
        menage:       menage     != null ? Number(menage) : null,
        external_url: extUrl,
        type:         g.type     || 'SINGLE'
      };
    };

    try {
      // 1. Token
      log.push({ type: 'info', msg: 'Récupération du token Guesty…' });
      const token = await getGuestyToken();
      log.push({ type: 'ok',   msg: 'Token obtenu.' });

      // 2. Listings depuis Guesty
      log.push({ type: 'info', msg: 'Récupération des listings depuis Guesty…' });
      const fields = '_id nickname title active type owners ' +
                     'prices.cleaningFee cleaningFee externalLinks';
      const remote = await guestyGetAll(token, '/listings', fields);
      const remoteMapped = remote.map(normalize);
      log.push({ type: 'ok',   msg: `${remoteMapped.length} listing(s) reçu(s) depuis Guesty.` });

      // 3. Données locales
      const localRows = query('SELECT id, nom, owner_id, titre, active, menage, external_url, type FROM listings');
      const localMap  = new Map(localRows.map(r => [r.id, r]));
      const remoteMap = new Map(remoteMapped.map(r => [r.id, r]));

      // Owners connus (pour éviter violation FK)
      const ownerIds = new Set(query('SELECT id FROM owners').map(r => r.id));

      let nbAjout = 0, nbMaj = 0, nbDesactive = 0, nbInchange = 0;

      // Ajouts & mises à jour
      for (const [id, r] of remoteMap) {
        // Protéger l'intégrité référentielle sur owner_id
        if (r.owner_id && !ownerIds.has(r.owner_id)) {
          log.push({ type: 'warn', msg: `Owner inconnu [${r.owner_id}] pour listing "${r.nom}" — owner_id mis à NULL` });
          r.owner_id = null;
        }

        if (!localMap.has(id)) {
          run(
            'INSERT INTO listings (id, nom, owner_id, titre, active, menage, external_url, type) VALUES (?,?,?,?,?,?,?,?)',
            [r.id, r.nom, r.owner_id, r.titre, r.active, r.menage, r.external_url, r.type]
          );
          log.push({ type: 'ajout', msg: `AJOUT    [${id}] "${r.nom}"` });
          nbAjout++;
        } else {
          const local = localMap.get(id);
          const diffs = COMPARE.filter(f => String(local[f] ?? null) !== String(r[f] ?? null));
          if (diffs.length > 0) {
            const detail = diffs.map(f => `${f}: "${local[f] ?? ''}" → "${r[f] ?? ''}"`).join(' | ');
            run(
              'UPDATE listings SET nom=?, owner_id=?, titre=?, active=?, menage=?, external_url=?, type=? WHERE id=?',
              [r.nom, r.owner_id, r.titre, r.active, r.menage, r.external_url, r.type, r.id]
            );
            log.push({ type: 'maj', msg: `MAJ      [${id}] "${local.nom}" — ${detail}` });
            nbMaj++;
          } else {
            nbInchange++;
          }
        }
      }

      // Listings locaux absents de Guesty → désactiver (jamais supprimer)
      for (const [id, local] of localMap) {
        if (!remoteMap.has(id)) {
          if (Number(local.active) === 1) {
            run('UPDATE listings SET active = 0 WHERE id = ?', [id]);
            log.push({ type: 'suppr', msg: `DÉSACTIVÉ [${id}] "${local.nom}" — absent de Guesty` });
            nbDesactive++;
          } else {
            log.push({ type: 'info', msg: `DÉJÀ INACTIF [${id}] "${local.nom}" — toujours absent de Guesty` });
          }
        }
      }

      log.push({ type: 'info', msg: '─────────────────────────────' });
      log.push({ type: 'ok',   msg: `Résumé : ${nbAjout} ajout(s), ${nbMaj} mise(s) à jour, ${nbDesactive} désactivation(s), ${nbInchange} inchangé(s).` });

    } catch (err) {
      log.push({ type: 'err', msg: `ERREUR : ${err.message}` });
      console.error('[maj-listings]', err);
    }

    res.send(pageShell(
      'MAJ Propriétés',
      'Synchronisation avec l\'API Guesty — table <code>listings</code>',
      `<div class="card">
        <h2>Lancer une nouvelle synchronisation</h2>
        <div class="notice">
          ⚠️ Listings absents de Guesty → désactivés uniquement. Formules non écrasées.
        </div>
        <form method="POST" action="/maj-listings">
          <button type="submit" class="btn btn-gold">🔄 Synchroniser à nouveau</button>
        </form>
        <a href="/" class="btn btn-back">← Accueil</a>
      </div>
      <div class="card">
        <h2>Journal des opérations</h2>
        <div class="log-box">${renderLogBox(log)}</div>
      </div>`
    ));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── API : Statut du token Guesty ───────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/guesty/token-status', (req, res) => {
    try {
      const rows = query("SELECT key, value FROM config WHERE key IN ('guesty_token', 'guesty_token_expires_at')");
      const cache = {};
      rows.forEach(r => { cache[r.key] = r.value; });

      if (!cache['guesty_token']) {
        return res.json({ status: 'absent', message: 'Aucun token en cache.' });
      }

      const expiresAt = parseInt(cache['guesty_token_expires_at'], 10);
      const remainsMs = expiresAt - Date.now();

      if (remainsMs <= 0) {
        return res.json({ status: 'expiré', expiresAt: new Date(expiresAt).toISOString() });
      }

      return res.json({
        status:       'valide',
        expiresAt:    new Date(expiresAt).toISOString(),
        remainsMin:   Math.round(remainsMs / 60000),
        tokenPreview: cache['guesty_token'].substring(0, 20) + '...'
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── API : Forcer récupération token Guesty ─────────────────────────────────
  app.post('/api/guesty/refresh-token', async (req, res) => {
    try {
      const token      = await getGuestyToken();
      const expiresRow = query("SELECT value FROM config WHERE key = 'guesty_token_expires_at'");
      res.json({
        success:      true,
        message:      'Token disponible.',
        expiresAt:    new Date(parseInt(expiresRow[0].value, 10)).toISOString(),
        tokenPreview: token.substring(0, 20) + '...'
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── API : Propriétaires ────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/owners', (req, res) => {
    try {
      const rows = query(`
        SELECT
          o.id,
          o.nom,
          COUNT(DISTINCT l.id) AS nb_listings,
          COUNT(DISTINCT r.id) AS nb_res
        FROM owners o
        LEFT JOIN listings l ON l.owner_id = o.id
        LEFT JOIN reservations r ON r.listing_id = l.id
        GROUP BY o.id, o.nom
        ORDER BY o.nom ASC
      `);
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── API : Propriétés ───────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/listings', (req, res) => {
    try {
      const rows = query(`
        SELECT
          l.id,
          l.nom,
          l.active,
          l.comm,
          l.menage,
          l.titre,
          l.owner_id,
          l.external_url,
          o.nom AS owner_nom,
          COUNT(r.id) AS nb_res
        FROM listings l
        LEFT JOIN owners o ON l.owner_id = o.id
        LEFT JOIN reservations r ON r.listing_id = l.id
        GROUP BY l.id
        ORDER BY l.nom ASC
      `);
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── API : Réservations ─────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/reservations', (req, res) => {
    try {
      const { plateforme, listing_id, date_from, date_to } = req.query;

      let sql = `
        SELECT
          r.id,
          r.listing_id,
          l.nom       AS listing_nom,
          o.nom       AS owner_nom,
          r.plateforme,
          r.date_debut,
          r.duree,
          r.prix_nuit,
          r.prix_total,
          r.menage,
          r.commission,
          r.hobe,
          r.versement,
          r.booking_date
        FROM reservations r
        JOIN listings l ON r.listing_id = l.id
        LEFT JOIN owners o ON l.owner_id = o.id
        WHERE 1=1
      `;
      const params = [];

      if (plateforme) { sql += ' AND r.plateforme = ?';    params.push(plateforme); }
      if (listing_id) { sql += ' AND r.listing_id = ?';    params.push(listing_id); }
      if (date_from)  { sql += ' AND r.date_debut >= ?';   params.push(date_from); }
      if (date_to)    { sql += ' AND r.date_debut <= ?';   params.push(date_to); }

      sql += ' ORDER BY r.date_debut DESC';

      const rows = query(sql, params);
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Démarrage ──────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`🚀  Suivi Réservations  →  http://localhost:${PORT}  (v0.2.0)`);
    console.log(`    Réseau local        →  http://Black6:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('❌  Erreur au démarrage :', err);
  process.exit(1);
});
