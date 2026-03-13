'use strict';

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const initSqlJs = require('sql.js');

const app  = express();
const PORT = 3010;
const DB_PATH = path.join(__dirname, 'reservations.db');

// ── Credentials Guesty ───────────────────────────────────────────────────────
const GUESTY_CLIENT_ID     = '0oaqf53n8oTcDNWDY5d7';
const GUESTY_CLIENT_SECRET = '5RISAMWeMLEPfFOVxRpKu8IWG1Hu-YXAzHgsy1Odd4yECDNseBqVmafKcRHYOaB9';
const GUESTY_TOKEN_URL     = 'https://open-api.guesty.com/oauth2/token';
const REFRESH_MARGIN_MS    = 60 * 1000; // 60 s de marge (comme le VBA : expires_in - 60s)

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

let db;

async function startServer() {
  const SQL  = await initSqlJs();
  const file = fs.readFileSync(DB_PATH);
  db = new SQL.Database(file);
  console.log('✅  Base SQLite chargée depuis', DB_PATH);

  // ── Helpers SQL ─────────────────────────────────────────────────────────────
  function query(sql, params = []) {
    const stmt = db.prepare(sql);
    const rows = [];
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  function run(sql, params = []) {
    db.run(sql, params);
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }

  // ── Table config ─────────────────────────────────────────────────────────────
  run(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  // ── Auth Guesty (logique identique au VBA GetGuestyToken) ────────────────────
  // Le VBA stocke le token + dateToken (date d'expiration).
  // Il renouvelle si now >= dateToken. On fait pareil avec timestamps ms.
  async function getGuestyToken() {
    const rows  = query("SELECT key, value FROM config WHERE key IN ('guesty_token','guesty_token_expires_at')");
    const cache = Object.fromEntries(rows.map(r => [r.key, r.value]));

    if (cache['guesty_token'] && cache['guesty_token_expires_at']) {
      if (Date.now() < parseInt(cache['guesty_token_expires_at'], 10) - REFRESH_MARGIN_MS) {
        return cache['guesty_token'];
      }
    }

    const params = new URLSearchParams({
      grant_type:    'client_credentials',
      scope:         'open-api',
      client_id:     GUESTY_CLIENT_ID,
      client_secret: GUESTY_CLIENT_SECRET,
    });
    const resp = await fetch(GUESTY_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body:    params.toString(),
    });
    if (!resp.ok) throw new Error(`Token Guesty (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    if (!data.access_token) throw new Error('Pas de access_token dans la réponse Guesty');

    // expires_in secondes, on retire 60 s comme le VBA
    const expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    run(`INSERT INTO config (key,value) VALUES ('guesty_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [data.access_token]);
    run(`INSERT INTO config (key,value) VALUES ('guesty_token_expires_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(expiresAt)]);
    console.log('[Guesty] Nouveau token, valide jusqu\'au', new Date(expiresAt).toLocaleString('fr-FR'));
    return data.access_token;
  }

  // ── Helper fetch Guesty ───────────────────────────────────────────────────────
  async function guestyGet(token, url) {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`Guesty GET ${url} (${resp.status}): ${await resp.text()}`);
    return resp.json();
  }

  // ── Helpers partagés réservations ────────────────────────────────────────────

  // Clé composite identique au VBA KeyOf
  function keyOf(listingNom, platform, dateDebut, duree) {
    const d  = new Date(dateDebut);
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${listingNom}|${platform}|${yy}${mm}${dd}|${duree}`;
  }

  // ISO8601 → "YYYY-MM-DD" (comme VBA Int() qui tronque l'heure)
  function isoToDate(iso) {
    if (!iso) return null;
    return iso.slice(0, 10);
  }

  // Valeur monétaire robuste
  function toMoney(val) {
    if (val == null || val === '') return 0;
    return parseFloat(String(val).replace(',', '.')) || 0;
  }

  // ── Calcul financier — logique VBA GuestyAddReservation ─────────────────────
  // VBA GuestyGetReservation :
  //   Prix     = fareAccommodationAdjusted + fareCleaning
  //   FraisChannel = hostServiceFee + fees[0].amount
  // VBA GuestyAddReservation :
  //   Versement    = (Prix - Ménage - FraisChannel) * (1 - Comm)
  //   Conciergerie = Ménage + Versement * Comm / (1 - Comm)
  //   PrixNuit     = Prix / NbNuits
  function calcFinances(d, duree, commRate) {
    const menage     = toMoney(d.money && d.money.fareCleaning);
    const fareAccom  = toMoney(d.money && d.money.fareAccommodationAdjusted);
    const hostSvcFee = toMoney(d.money && d.money.hostServiceFee);
    let fees = 0;
    try {
      const p = d.money && d.money.payments;
      if (Array.isArray(p) && p[0] && Array.isArray(p[0].fees) && p[0].fees[0]) {
        fees = toMoney(p[0].fees[0].amount);
      }
    } catch (_) { fees = 0; }

    const prix_total = fareAccom + menage;     // "Prix" VBA
    const commission = hostSvcFee + fees;      // "Frais channel" VBA
    const rate       = (commRate != null && commRate < 1) ? commRate : 0;
    const versement  = rate > 0
      ? (prix_total - menage - commission) * (1 - rate)
      : (prix_total - menage - commission);
    const hobe = rate > 0
      ? menage + versement * rate / (1 - rate)
      : menage;
    const prix_nuit = duree > 0 ? prix_total / duree : 0;

    return {
      prix_total : Math.round(prix_total * 100) / 100,
      menage     : Math.round(menage     * 100) / 100,
      commission : Math.round(commission * 100) / 100,
      hobe       : Math.round(hobe       * 100) / 100,
      versement  : Math.round(versement  * 100) / 100,
      prix_nuit  : Math.round(prix_nuit  * 100) / 100,
    };
  }

  // ── Helpers HTML ──────────────────────────────────────────────────────────────
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  function renderLogBox(log) {
    if (!log || !log.length) return '<div class="empty-log">Aucune opération effectuée.</div>';
    const CLS = { info:'log-info', ok:'log-ok', ajout:'log-ajout', maj:'log-maj', suppr:'log-suppr', warn:'log-warn', err:'log-err' };
    return log.map(e => `<div class="${CLS[e.type]||'log-info'}">${esc(e.msg)}</div>`).join('\n');
  }

  function pageShell(title, subtitle, body) {
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>${esc(title)} — Suivi Réservations</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Nunito:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#e8e8e8;font-family:'Nunito',sans-serif;min-height:100vh;padding:2rem}
h1{font-family:'Bebas Neue',sans-serif;font-size:2.4rem;letter-spacing:.08em;
   background:linear-gradient(135deg,#f5c842,#e8a020);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:.4rem}
.subtitle{color:#888;font-size:.9rem;margin-bottom:2rem}
.card{background:#141414;border:1px solid #2a2a2a;border-radius:12px;padding:1.8rem;margin-bottom:1.5rem}
.card h2{font-family:'Bebas Neue',sans-serif;font-size:1.4rem;letter-spacing:.06em;color:#f5c842;margin-bottom:1rem}
p{line-height:1.6;color:#bbb;margin-bottom:.8rem}
.notice{background:#1a1500;border:1px solid #3a2f00;border-radius:8px;padding:.9rem 1.1rem;color:#c8a020;font-size:.88rem;margin-bottom:1rem}
.btn{display:inline-block;padding:.75rem 2rem;border-radius:8px;font-family:'Nunito',sans-serif;font-weight:700;font-size:1rem;cursor:pointer;border:none;text-decoration:none}
.btn-gold{background:linear-gradient(135deg,#f5c842,#e8a020);color:#1a1200}.btn-gold:hover{opacity:.9}
.btn-back{background:#1e1e1e;color:#aaa;border:1px solid #333;margin-left:1rem}.btn-back:hover{background:#282828;color:#eee}
.log-box{background:#0d0d0d;border:1px solid #222;border-radius:8px;padding:1rem 1.2rem;font-family:monospace;font-size:.82rem;max-height:520px;overflow-y:auto;line-height:1.7}
.log-info{color:#888}.log-ok{color:#4caf50}.log-ajout{color:#64b5f6}.log-maj{color:#ffd54f}
.log-suppr{color:#ef9a9a}.log-warn{color:#ffb74d}.log-err{color:#f44336;font-weight:700}.empty-log{color:#555;font-style:italic}
</style></head><body>
<h1>${esc(title)}</h1><p class="subtitle">${subtitle}</p>${body}</body></html>`;
  }

  // ── Pages statiques ───────────────────────────────────────────────────────────
  app.get('/',           (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
  app.get('/reservations',(req,res) => res.sendFile(path.join(__dirname,'public','reservations.html')));
  app.get('/listings',   (req,res) => res.sendFile(path.join(__dirname,'public','listings.html')));
  app.get('/suivi-prises',(req,res) => res.sendFile(path.join(__dirname,'public','suivi-prises.html')));
  app.get('/owners',     (req,res) => res.sendFile(path.join(__dirname,'public','owners.html')));

  // ═══════════════════════════════════════════════════════════════════════════
  // ── MAJ Propriétaires (/maj-owners) ────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Logique VBA GuestyGetOwners :
  //   URL  : /owners?fields=fullName  (fullName seulement)
  //   JSON : tableau à la racine, indexé (0)._id / (0).fullName
  //          → PAS de clé "results", c'est un array direct
  //   Table: TOwners col1=_id, col2=fullName
  //   Opération : TableToTableau = remplacement complet du tableau
  //               (pas de diff, pas de suppression sélective)
  //               → on REMPLACE tout : DELETE + INSERT pour chaque owner reçu
  //
  // Garde de sécurité : si 0 owners reçus → annulation totale
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/maj-owners', (req, res) => {
    res.send(pageShell(
      'MAJ Propriétaires',
      'Synchronisation avec l\'API Guesty — table <code>owners</code>',
      `<div class="card">
        <h2>Lancer la synchronisation</h2>
        <p>Récupère tous les propriétaires depuis Guesty et remplace la table locale.</p>
        <p>Les propriétaires rattachés à des listings actifs ne seront <strong>pas supprimés</strong>.</p>
        <form method="POST" action="/maj-owners">
          <button type="submit" class="btn btn-gold">🔄 Synchroniser maintenant</button>
        </form>
        <a href="/" class="btn btn-back">← Accueil</a>
      </div>`
    ));
  });

  app.post('/maj-owners', async (req, res) => {
    const log = [];
    log.push({ type: 'info', msg: `Synchronisation démarrée le ${new Date().toLocaleString('fr-FR')}` });

    try {
      log.push({ type: 'info', msg: 'Récupération du token Guesty…' });
      const token = await getGuestyToken();
      log.push({ type: 'ok', msg: 'Token obtenu.' });

      // ── Appel API owners — identique au VBA : ?fields=fullName
      // La réponse est un tableau JSON à la racine (pas {results:[...]})
      log.push({ type: 'info', msg: 'Appel /owners?fields=fullName…' });
      const json = await guestyGet(token, 'https://open-api.guesty.com/v1/owners?fields=fullName');

      // La réponse peut être [] directement ou {results:[]} selon la version API
      // Le VBA itère (0)._id → c'est un tableau à la racine
      const remote = Array.isArray(json) ? json
                   : Array.isArray(json.results) ? json.results
                   : [];

      log.push({ type: 'ok', msg: `${remote.length} propriétaire(s) reçu(s) depuis Guesty.` });

      // ── Garde de sécurité absolue ─────────────────────────────────────────
      if (remote.length === 0) {
        throw new Error('Guesty a retourné 0 propriétaire — synchronisation annulée pour protéger les données.');
      }

      // ── Logique VBA : TableToTableau = remplacement complet ───────────────
      // On reconstruit la table owners en entier.
      // Protection : on ne supprime pas les owners encore liés à des listings.
      const localRows  = query('SELECT id, nom FROM owners');
      const remoteMap  = new Map(remote.map(o => [o._id, (o.fullName || '').trim() || '(sans nom)']));
      const localMap   = new Map(localRows.map(r => [r.id, r.nom]));

      let nbAjout = 0, nbMaj = 0, nbSuppr = 0, nbProtege = 0, nbInchange = 0;

      // Ajouts & MAJ
      for (const [id, fullName] of remoteMap) {
        if (!localMap.has(id)) {
          run('INSERT INTO owners (id, nom) VALUES (?, ?)', [id, fullName]);
          log.push({ type: 'ajout', msg: `AJOUT    [${id}] → "${fullName}"` });
          nbAjout++;
        } else if (localMap.get(id) !== fullName) {
          run('UPDATE owners SET nom=? WHERE id=?', [fullName, id]);
          log.push({ type: 'maj', msg: `MAJ      [${id}] "${localMap.get(id)}" → "${fullName}"` });
          nbMaj++;
        } else {
          nbInchange++;
        }
      }

      // Suppressions — owners absents de Guesty
      // VBA : TableToTableau efface tout et réinsère → dans le JS on supprime
      // seulement ceux sans listing rattaché (protection intégrité FK)
      for (const [id, nom] of localMap) {
        if (!remoteMap.has(id)) {
          const nb = query('SELECT COUNT(*) AS c FROM listings WHERE owner_id=?', [id])[0].c;
          if (nb > 0) {
            log.push({ type: 'warn', msg: `PROTÉGÉ  [${id}] "${nom}" — absent de Guesty mais lié à ${nb} listing(s), non supprimé` });
            nbProtege++;
          } else {
            run('DELETE FROM owners WHERE id=?', [id]);
            log.push({ type: 'suppr', msg: `SUPPRIMÉ [${id}] "${nom}" — absent de Guesty, aucun listing` });
            nbSuppr++;
          }
        }
      }

      log.push({ type: 'info', msg: '─────────────────────────────' });
      log.push({ type: 'ok', msg: `Résumé : ${nbAjout} ajout(s), ${nbMaj} MAJ, ${nbSuppr} suppression(s), ${nbProtege} protégé(s), ${nbInchange} inchangé(s).` });

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
  //
  // Logique VBA GuestyGetListings + GuestyGetListing :
  //   Étape 1 : GET /listings?active=true&fields=_id → liste des _id actifs
  //   Étape 2 : pour chaque _id absent en local → GET /listings/:id (détails complets)
  //
  // Champs extraits de /listings/:id (identiques au VBA T(1)..T(12)) :
  //   T(1)  nom           = businessModel.name  (ou owner - 2 derniers chars id)
  //   T(2)  id            = _id
  //   T(3)  owner_id      = extrait par regex dans "owners":[" ... "]
  //   T(4)  titre         = title
  //   T(5)  comm          = calculé depuis commissionFormula + commissionTaxPercentage
  //   T(6)  active        = active
  //   T(7)  menage        = financials.cleaningFee.value.formula
  //   T(8)  revenue_net   = netIncomeFormula
  //   T(9)  commission_f  = commissionFormula
  //   T(10) versement_f   = ownerRevenueFormula
  //   T(11) external_url  = integrations[0].externalUrl
  //   T(12) type          = type
  //
  // Règle MAJ : le VBA n'insère que si absent (dicListings(idListing) = "")
  //             → AJOUT uniquement pour les nouveaux, pas de mise à jour des existants
  //             → Les listings locaux absents de Guesty sont désactivés (active=0)
  //
  // Champs JAMAIS écrasés (gérés manuellement) :
  //   comm, menage, revenue_net, commission_f, versement_f
  //   (ces champs sont insérés à la création mais ne sont plus touchés ensuite)
  //
  // Garde de sécurité : si 0 listings reçus → annulation totale
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/maj-listings', (req, res) => {
    res.send(pageShell(
      'MAJ Propriétés',
      'Synchronisation avec l\'API Guesty — table <code>listings</code>',
      `<div class="card">
        <h2>Lancer la synchronisation</h2>
        <p>Récupère les listings actifs depuis Guesty. Seuls les nouveaux listings sont ajoutés.</p>
        <div class="notice">
          ⚠️ Les listings absents de Guesty sont <strong>désactivés</strong> (jamais supprimés).<br>
          Les champs <code>comm</code>, <code>menage</code>, <code>revenue_net</code>, <code>commission_f</code>, <code>versement_f</code>
          ne sont <strong>jamais modifiés</strong> après la création — ils restent gérés manuellement.
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
    log.push({ type: 'info', msg: `Synchronisation démarrée le ${new Date().toLocaleString('fr-FR')}` });

    try {
      log.push({ type: 'info', msg: 'Récupération du token Guesty…' });
      const token = await getGuestyToken();
      log.push({ type: 'ok', msg: 'Token obtenu.' });

      // ── Étape 1 : liste des _id actifs (identique au VBA GuestyGetListings)
      log.push({ type: 'info', msg: 'Appel /listings?active=true&fields=_id…' });
      const listJson = await guestyGet(token,
        'https://open-api.guesty.com/v1/listings?active=true&limit=100&skip=0&fields=_id');

      const remoteIds = (listJson.results || []).map(g => g._id).filter(Boolean);
      log.push({ type: 'ok', msg: `${remoteIds.length} listing(s) actif(s) reçu(s) depuis Guesty.` });

      // ── Garde de sécurité ─────────────────────────────────────────────────
      if (remoteIds.length === 0) {
        throw new Error('Guesty a retourné 0 listing — synchronisation annulée pour protéger les données.');
      }

      // ── Données locales ───────────────────────────────────────────────────
      const localRows = query('SELECT id, nom, active FROM listings');
      const localMap  = new Map(localRows.map(r => [r.id, r]));
      const remoteSet = new Set(remoteIds);

      let nbAjout = 0, nbDesactive = 0, nbDejaInactif = 0, nbDejaPresent = 0, nbOwnerMaj = 0;

      // ── Étape 2 : pour chaque _id Guesty → appel détail
      // Nouveaux  : INSERT complet (logique VBA GuestyGetListing)
      // Existants sans owner_id : on récupère le détail pour rétablir le lien owner
      for (const id of remoteIds) {
        const local = localMap.get(id);

        if (local && local.owner_id) {
          // Déjà présent avec owner → on ne touche RIEN (logique VBA)
          nbDejaPresent++;
          continue;
        }

        // Nouveau listing OU listing existant sans owner_id → appel /listings/:id
        const isNew = !local;
        log.push({ type: 'info', msg: `Récupération détails [${id}]${isNew ? ' (nouveau)' : ' (owner manquant)'}…` });
        try {
          const g = await guestyGet(token, `https://open-api.guesty.com/v1/listings/${id}`);

          // Extraction owner_id par regex (identique au VBA)
          // Le VBA cherche "owners":["..."] dans le raw JSON
          const rawText = JSON.stringify(g);
          let ownerId = null;
          const ownerMatch = rawText.match(/"owners":\["([^"]+)"/);
          if (ownerMatch) ownerId = ownerMatch[1];

          if (!isNew) {
            // Listing existant sans owner_id → on met à jour uniquement owner_id
            run('UPDATE listings SET owner_id=? WHERE id=?', [ownerId, id]);
            log.push({ type: 'maj', msg: `OWNER LIÉ [${id}] "${local.nom}" → owner [${ownerId}]` });
            nbOwnerMaj++;
            continue;
          }

          // ── Nouveau listing : INSERT complet (logique VBA GuestyGetListing) ──

          // Résolution nom owner
          const ownerRow = ownerId ? query('SELECT nom FROM owners WHERE id=?', [ownerId])[0] : null;
          const ownerNom = ownerRow ? ownerRow.nom : null;

          // nom = businessModel.name — sinon owner + 2 derniers chars id (logique VBA)
          const businessName = g.businessModel && g.businessModel.name ? g.businessModel.name.trim() : '';
          const nom = businessName || (ownerNom ? `${ownerNom} - ${id.slice(-2)}` : `(sans nom) - ${id.slice(-2)}`);

          // Calcul commission (logique VBA)
          // "net_income*X" dans commissionFormula → comm = X * (100 + taxPct) / 100
          let comm = null;
          const taxPct = g.commissionTaxPercentage != null ? parseFloat(g.commissionTaxPercentage) : null;
          const commFormula = g.commissionFormula || '';
          if (taxPct !== null && commFormula) {
            const m = commFormula.match(/net_income\*([0-9.]+)/);
            if (m) comm = parseFloat(m[1]) * (100 + taxPct) / 100;
          }

          // menage = financials.cleaningFee.value.formula
          let menage = null;
          if (g.financials && g.financials.cleaningFee && g.financials.cleaningFee.value) {
            const rawMenage = g.financials.cleaningFee.value.formula;
            if (rawMenage != null && rawMenage !== '') menage = parseFloat(String(rawMenage).replace(',', '.'));
          }

          const titre       = g.title                 || null;
          const active      = g.active                ? 1 : 0;
          const revenuNet   = g.netIncomeFormula       || null;
          const commissionF = g.commissionFormula      || null;
          const versementF  = g.ownerRevenueFormula    || null;
          const extUrl      = (g.integrations && g.integrations[0] && g.integrations[0].externalUrl)
                              ? g.integrations[0].externalUrl : null;
          const type        = g.type || 'SINGLE';

          run(
            `INSERT INTO listings
               (id, nom, owner_id, titre, comm, active, menage, revenue_net, commission_f, versement_f, external_url, type)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [id, nom, ownerId, titre, comm, active, menage, revenuNet, commissionF, versementF, extUrl, type]
          );
          log.push({ type: 'ajout', msg: `AJOUT    [${id}] "${nom}"` });
          nbAjout++;

        } catch (detailErr) {
          log.push({ type: 'warn', msg: `SKIP [${id}] — erreur détail : ${detailErr.message}` });
        }
      }

      // ── Listings locaux absents de Guesty → désactiver (jamais supprimer)
      for (const [id, local] of localMap) {
        if (!remoteSet.has(id)) {
          if (Number(local.active) === 1) {
            run('UPDATE listings SET active=0 WHERE id=?', [id]);
            log.push({ type: 'suppr', msg: `DÉSACTIVÉ [${id}] "${local.nom}" — absent de Guesty` });
            nbDesactive++;
          } else {
            nbDejaInactif++;
          }
        }
      }

      log.push({ type: 'info', msg: '─────────────────────────────' });
      log.push({ type: 'ok', msg: `Résumé : ${nbAjout} ajout(s), ${nbOwnerMaj} owner(s) rétabli(s), ${nbDejaPresent} inchangé(s), ${nbDesactive} désactivation(s), ${nbDejaInactif} déjà inactif(s).` });

    } catch (err) {
      log.push({ type: 'err', msg: `ERREUR : ${err.message}` });
      console.error('[maj-listings]', err);
    }

    res.send(pageShell(
      'MAJ Propriétés',
      'Synchronisation avec l\'API Guesty — table <code>listings</code>',
      `<div class="card">
        <h2>Lancer une nouvelle synchronisation</h2>
        <div class="notice">⚠️ Nouveaux listings ajoutés uniquement. Champs manuels jamais écrasés.</div>
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
  // ── MAJ Réservations (/maj-reservations) ────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // ÉTAPE 1 — Charger TOUTES les réservations "confirmed" depuis Guesty
  //   Pagination complète par tranches de 100 jusqu'à épuisement
  //   → guestyMap = référence complète fiable
  //
  // ÉTAPE 2 — CompareResasDansGuesty : Guesty → local
  //   Clé composite : listing_nom|platform|yyyymmdd|duree
  //   Si absente en local → appel détail + INSERT avec calculs financiers
  //
  // ÉTAPE 3 — CompareGuestyDansResas : local → Guesty
  //   Puisqu'on a TOUTES les résas Guesty, on peut supprimer sans limite de date
  //   Si clé absente dans guestyMap → DELETE local
  //
  // CALCULS (logique VBA GuestyGetReservation + GuestyAddReservation) :
  //   menage     = money.fareCleaning
  //   prix_total = money.netIncome + menage
  //   commission = (prix_total - money.ownerRevenue) + fees[0].amount
  //   versement  = (prix_total - menage - commission) * (1 - comm)
  //   hobe       = menage + versement * comm / (1 - comm)
  //   prix_nuit  = prix_total / duree
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/maj-reservations', (req, res) => {
    const nbLocal = query('SELECT COUNT(*) AS c FROM reservations')[0].c;
    res.send(pageShell(
      'MAJ Réservations',
      'Synchronisation avec l\'API Guesty — table <code>reservations</code>',
      `<div class="card">
        <h2>Synchronisation partielle (recommandée)</h2>
        <p>Récupère les dernières réservations confirmées depuis Guesty.</p>
        <div class="notice">
          Les nouvelles réservations sont ajoutées. Les suppressions ne sont contrôlées que sur les <strong>20 derniers jours</strong>.
        </div>
        <form method="POST" action="/maj-reservations">
          <label style="color:#bbb;font-size:.9rem;display:block;margin-bottom:.6rem">
            Nombre de pages à charger (1 page = 100 réservations) :
            <input type="number" name="nb_pages" value="5" min="1" max="50"
              style="margin-left:.5rem;width:70px;background:#1e1e1e;border:1px solid #444;border-radius:6px;color:#eee;padding:.3rem .5rem;font-size:.95rem">
          </label>
          <button type="submit" class="btn btn-gold">🔄 Synchroniser maintenant</button>
        </form>
        <a href="/" class="btn btn-back" style="margin-left:1rem">← Accueil</a>
      </div>
      <div class="card">
        <h2>Réinitialisation complète</h2>
        <p>Efface les <strong>${nbLocal} réservation(s)</strong> locales et recharge toutes les réservations depuis Guesty.</p>
        <div class="notice">
          ⚠️ Opération irréversible — à utiliser pour corriger des calculs incorrects en base.
        </div>
        <a href="/maj-reservations-full" class="btn btn-back">🗑️ Réinitialiser la base</a>
      </div>`
    ));
  });

  app.post('/maj-reservations', async (req, res) => {
    const log = [];
    const nbPages = Math.max(1, Math.min(50, parseInt(req.body.nb_pages, 10) || 5));
    log.push({ type: 'info', msg: `Synchronisation démarrée le ${new Date().toLocaleString('fr-FR')}` });

    try {
      log.push({ type: 'info', msg: 'Récupération du token Guesty…' });
      const token = await getGuestyToken();
      log.push({ type: 'ok', msg: 'Token obtenu.' });

      // ── Dictionnaire listings locaux : listing_id → { nom, comm } ────────────
      const listingRows = query('SELECT id, nom, comm FROM listings');
      const dicListings  = new Map(listingRows.map(r => [r.id, { nom: r.nom, comm: r.comm }]));

      // ── ÉTAPE 1 : Chargement des N dernières réservations confirmed ──────────
      const MAX_RESERVATIONS = nbPages * 100;
      const filterEncoded  = encodeURIComponent('[{"operator":"$in","field":"status","value":["confirmed"]}]');
      const fields = 'status%20checkIn%20nightsCount%20listingId%20integration.platform';
      const PAGE   = 100;
      let skip     = 0;
      let total    = Infinity;
      const guestyList = [];

      log.push({ type: 'info', msg: `Chargement des réservations confirmées (${nbPages} page(s), max ${MAX_RESERVATIONS})…` });

      while (guestyList.length < Math.min(total, MAX_RESERVATIONS)) {
        const url  = `https://open-api.guesty.com/v1/reservations?fields=${fields}&sort=-checkIn&limit=${PAGE}&skip=${skip}&filters=${filterEncoded}`;
        const resp = await guestyGet(token, url);
        const results = resp.results || [];
        if (skip === 0) {
          total = resp.count || resp.total || results.length;
          log.push({ type: 'info', msg: `Total Guesty : ${total} — chargement limité à ${MAX_RESERVATIONS}.` });
        }
        guestyList.push(...results);
        if (results.length < PAGE || guestyList.length >= MAX_RESERVATIONS) break;
        skip += PAGE;
        log.push({ type: 'info', msg: `  … ${guestyList.length} / ${Math.min(total, MAX_RESERVATIONS)} chargée(s)` });
      }
      if (guestyList.length > MAX_RESERVATIONS) guestyList.length = MAX_RESERVATIONS;

      log.push({ type: 'ok', msg: `${guestyList.length} réservation(s) confirmée(s) chargée(s) depuis Guesty.` });

      // ── Garde de sécurité ─────────────────────────────────────────────────────
      if (guestyList.length === 0) {
        throw new Error('Guesty a retourné 0 réservation — synchronisation annulée pour protéger les données.');
      }

      // ── Construire guestyMap : clé composite → { id, listingId, ... } ─────────
      const guestyMap = new Map();
      const unknownListings = new Set();

      for (const g of guestyList) {
        const listingInfo = dicListings.get(g.listingId);
        if (!listingInfo) {
          if (!unknownListings.has(g.listingId)) {
            log.push({ type: 'warn', msg: `Listing inconnu [${g.listingId}] — réservations ignorées (faire MAJ Propriétés d'abord)` });
            unknownListings.add(g.listingId);
          }
          continue;
        }
        const dateDebut = isoToDate(g.checkIn);
        const platform  = (g.integration && g.integration.platform) ? g.integration.platform : '';
        const duree     = g.nightsCount || 0;
        const k         = keyOf(listingInfo.nom, platform, dateDebut, duree);
        guestyMap.set(k, { id: g._id, listingId: g.listingId, listingNom: listingInfo.nom, platform, dateDebut, duree });
      }

      // ── ÉTAPE 2 : CompareResasDansGuesty — Guesty → local ────────────────────
      const localRows = query(`
        SELECT r.id, l.nom AS listing_nom, r.plateforme, r.date_debut, r.duree
        FROM reservations r
        JOIN listings l ON r.listing_id = l.id
      `);
      const localMap = new Map();
      for (const r of localRows) {
        const k = keyOf(r.listing_nom, r.plateforme, r.date_debut, r.duree);
        localMap.set(k, r.id);
      }

      let nbAjout = 0, nbSuppr = 0, nbInchange = 0;

      for (const [k, g] of guestyMap) {
        if (localMap.has(k)) { nbInchange++; continue; }

        // Réservation absente en local → appel détail + INSERT
        log.push({ type: 'info', msg: `Ajout [${g.id}] "${g.listingNom}" le ${g.dateDebut}…` });
        try {
          const d = await guestyGet(token, `https://open-api.guesty.com/v1/reservations/${g.id}`);

          const listingInfo = dicListings.get(g.listingId);
          const commRate    = (listingInfo && listingInfo.comm != null) ? listingInfo.comm : 0;
          const fin         = calcFinances(d, g.duree, commRate);

          const dateDebut   = isoToDate(d.checkIn);
          const bookingDate = isoToDate(d.guestStay && d.guestStay.createdAt);
          const platform    = (d.integration && d.integration.platform) ? d.integration.platform : g.platform;

          run(
            `INSERT OR IGNORE INTO reservations
               (id, listing_id, plateforme, date_debut, duree, prix_nuit,
                prix_total, menage, commission, hobe, versement, booking_date)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              g.id, g.listingId, platform, dateDebut, g.duree,
              fin.prix_nuit, fin.prix_total, fin.menage,
              fin.commission, fin.hobe, fin.versement,
              bookingDate
            ]
          );
          log.push({ type: 'ajout', msg: `AJOUT    "${g.listingNom}" le ${dateDebut} (${g.duree}n) — versement: ${Math.round(fin.versement)} €` });
          nbAjout++;

        } catch (detailErr) {
          log.push({ type: 'warn', msg: `SKIP [${g.id}] — erreur détail : ${detailErr.message}` });
        }
      }

      // ── ÉTAPE 3 : CompareGuestyDansResas — local → Guesty ────────────────────
      // On ne contrôle que les réservations des 20 derniers jours (comme VBA > 60j ignorées)
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 20);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      log.push({ type: 'info', msg: `Vérification des suppressions depuis le ${cutoffStr} (fenêtre 20 jours).` });

      const localRowsSorted = query(`
        SELECT r.id, l.nom AS listing_nom, r.plateforme, r.date_debut, r.duree
        FROM reservations r
        JOIN listings l ON r.listing_id = l.id
        WHERE r.date_debut >= ?
        ORDER BY r.date_debut DESC
      `, [cutoffStr]);

      for (const r of localRowsSorted) {
        const k = keyOf(r.listing_nom, r.plateforme, r.date_debut, r.duree);
        if (!guestyMap.has(k)) {
          run('DELETE FROM reservations WHERE id=?', [r.id]);
          log.push({ type: 'suppr', msg: `SUPPRIMÉ "${r.listing_nom}" le ${r.date_debut} (${r.duree}n) — absent de Guesty` });
          nbSuppr++;
        }
      }

      log.push({ type: 'info', msg: '─────────────────────────────' });
      log.push({ type: 'ok', msg: `Résumé : ${nbAjout} ajout(s), ${nbSuppr} suppression(s), ${nbInchange} inchangé(s).` });

    } catch (err) {
      log.push({ type: 'err', msg: `ERREUR : ${err.message}` });
      console.error('[maj-reservations]', err);
    }

    res.send(pageShell(
      'MAJ Réservations',
      'Synchronisation avec l\'API Guesty — table <code>reservations</code>',
      `<div class="card">
        <h2>Lancer une nouvelle synchronisation</h2>
        <div class="notice">Fenêtre 20 jours pour les suppressions.</div>
        <form method="POST" action="/maj-reservations">
          <label style="color:#bbb;font-size:.9rem;display:block;margin-bottom:.6rem">
            Nombre de pages (1 page = 100 réservations) :
            <input type="number" name="nb_pages" value="${nbPages}" min="1" max="50"
              style="margin-left:.5rem;width:70px;background:#1e1e1e;border:1px solid #444;border-radius:6px;color:#eee;padding:.3rem .5rem;font-size:.95rem">
          </label>
          <button type="submit" class="btn btn-gold">🔄 Synchroniser à nouveau</button>
        </form>
        <a href="/maj-reservations-full" class="btn btn-back" style="margin-left:1rem">🗑️ Réinitialisation complète</a>
        <a href="/" class="btn btn-back">← Accueil</a>
      </div>
      <div class="card">
        <h2>Journal des opérations</h2>
        <div class="log-box">${renderLogBox(log)}</div>
      </div>`
    ));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── Réinitialisation complète (/maj-reservations-full) ──────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Efface TOUTES les réservations locales puis recharge depuis Guesty (max 500)
  // avec les calculs corrigés. Utile pour corriger les mauvais calculs en base.
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/maj-reservations-full', (req, res) => {
    const nbLocal = query('SELECT COUNT(*) AS c FROM reservations')[0].c;
    res.send(pageShell(
      'Réinitialisation Réservations',
      'Effacement complet + rechargement depuis Guesty',
      `<div class="card">
        <h2>Attention — opération irréversible</h2>
        <p>Cette opération va :</p>
        <p>1. Supprimer les <strong>${nbLocal} réservation(s)</strong> actuellement en base.</p>
        <p>2. Recharger jusqu'à <strong>500 réservations confirmées</strong> depuis Guesty.</p>
        <p>3. Recalculer tous les montants avec l'algorithme corrigé.</p>
        <div class="notice">
          ⚠️ Toutes les données locales seront perdues et remplacées par les données Guesty.<br>
          Cette opération est recommandée si les calculs précédents étaient incorrects.
        </div>
        <form method="POST" action="/maj-reservations-full" style="display:inline">
          <button type="submit" class="btn btn-gold">🗑️ Confirmer la réinitialisation</button>
        </form>
        <a href="/maj-reservations" class="btn btn-back">← Annuler</a>
      </div>`
    ));
  });

  app.post('/maj-reservations-full', async (req, res) => {
    const log = [];
    log.push({ type: 'info', msg: `Réinitialisation démarrée le ${new Date().toLocaleString('fr-FR')}` });

    try {
      log.push({ type: 'info', msg: 'Récupération du token Guesty…' });
      const token = await getGuestyToken();
      log.push({ type: 'ok', msg: 'Token obtenu.' });

      // ── Dictionnaire listings ─────────────────────────────────────────────────
      const listingRows = query('SELECT id, nom, comm FROM listings');
      const dicListings  = new Map(listingRows.map(r => [r.id, { nom: r.nom, comm: r.comm }]));

      if (listingRows.length === 0) {
        throw new Error('Aucun listing en base — faire d\'abord MAJ Propriétés.');
      }

      // ── Chargement de TOUTES les réservations Guesty (pagination complète) ──────
      const filterEncoded = encodeURIComponent('[{"operator":"$in","field":"status","value":["confirmed"]}]');
      const fields = 'status%20checkIn%20nightsCount%20listingId%20integration.platform';
      const PAGE   = 100;
      let skip     = 0;
      let total    = Infinity;
      const guestyList = [];

      log.push({ type: 'info', msg: 'Chargement de toutes les réservations confirmées (pagination complète)…' });

      while (guestyList.length < total) {
        const url  = `https://open-api.guesty.com/v1/reservations?fields=${fields}&sort=-checkIn&limit=${PAGE}&skip=${skip}&filters=${filterEncoded}`;
        const resp = await guestyGet(token, url);
        const results = resp.results || [];
        if (skip === 0) {
          total = resp.count || resp.total || results.length;
          log.push({ type: 'info', msg: `Total Guesty : ${total} réservation(s) à charger.` });
        }
        guestyList.push(...results);
        if (results.length < PAGE) break;
        skip += PAGE;
        log.push({ type: 'info', msg: `  … ${guestyList.length} / ${total} chargée(s)` });
      }

      log.push({ type: 'ok', msg: `${guestyList.length} réservation(s) chargée(s).` });

      if (guestyList.length === 0) {
        throw new Error('Guesty a retourné 0 réservation — réinitialisation annulée pour protéger les données.');
      }

      // ── Effacement de la base ─────────────────────────────────────────────────
      const nbAvant = query('SELECT COUNT(*) AS c FROM reservations')[0].c;
      run('DELETE FROM reservations');
      log.push({ type: 'suppr', msg: `${nbAvant} réservation(s) supprimée(s) de la base locale.` });

      // ── Insertion de toutes les réservations Guesty ───────────────────────────
      const unknownListings = new Set();
      let nbAjout = 0, nbSkip = 0;

      for (const g of guestyList) {
        const listingInfo = dicListings.get(g.listingId);
        if (!listingInfo) {
          if (!unknownListings.has(g.listingId)) {
            log.push({ type: 'warn', msg: `Listing inconnu [${g.listingId}] — réservations ignorées (faire MAJ Propriétés d'abord)` });
            unknownListings.add(g.listingId);
          }
          nbSkip++;
          continue;
        }

        const dateDebut = isoToDate(g.checkIn);
        const platform  = (g.integration && g.integration.platform) ? g.integration.platform : '';
        const duree     = g.nightsCount || 0;

        log.push({ type: 'info', msg: `Chargement [${g._id}] "${listingInfo.nom}" le ${dateDebut}…` });
        try {
          const d = await guestyGet(token, `https://open-api.guesty.com/v1/reservations/${g._id}`);

          const commRate = listingInfo.comm != null ? listingInfo.comm : 0;
          const fin      = calcFinances(d, duree, commRate);

          const dateDebutDetail = isoToDate(d.checkIn);
          const bookingDate     = isoToDate(d.guestStay && d.guestStay.createdAt);
          const platformDetail  = (d.integration && d.integration.platform) ? d.integration.platform : platform;

          run(
            `INSERT OR IGNORE INTO reservations
               (id, listing_id, plateforme, date_debut, duree, prix_nuit,
                prix_total, menage, commission, hobe, versement, booking_date)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              g._id, g.listingId, platformDetail, dateDebutDetail, duree,
              fin.prix_nuit, fin.prix_total, fin.menage,
              fin.commission, fin.hobe, fin.versement,
              bookingDate
            ]
          );
          log.push({ type: 'ajout', msg: `AJOUT  "${listingInfo.nom}" le ${dateDebutDetail} (${duree}n) — versement: ${Math.round(fin.versement)} €` });
          nbAjout++;

        } catch (detailErr) {
          log.push({ type: 'warn', msg: `SKIP [${g._id}] — ${detailErr.message}` });
          nbSkip++;
        }
      }

      log.push({ type: 'info', msg: '─────────────────────────────' });
      log.push({ type: 'ok', msg: `Réinitialisation terminée : ${nbAjout} insertion(s), ${nbSkip} ignorée(s).` });

    } catch (err) {
      log.push({ type: 'err', msg: `ERREUR : ${err.message}` });
      console.error('[maj-reservations-full]', err);
    }

    res.send(pageShell(
      'Réinitialisation Réservations',
      'Effacement complet + rechargement depuis Guesty',
      `<div class="card">
        <h2>Opérations disponibles</h2>
        <a href="/maj-reservations-full" class="btn btn-gold">🗑️ Nouvelle réinitialisation</a>
        <a href="/maj-reservations" class="btn btn-back" style="margin-left:1rem">🔄 Sync partielle</a>
        <a href="/" class="btn btn-back">← Accueil</a>
      </div>
      <div class="card">
        <h2>Journal des opérations</h2>
        <div class="log-box">${renderLogBox(log)}</div>
      </div>`
    ));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── API token status ───────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/guesty/token-status', (req, res) => {
    try {
      const rows  = query("SELECT key, value FROM config WHERE key IN ('guesty_token','guesty_token_expires_at')");
      const cache = Object.fromEntries(rows.map(r => [r.key, r.value]));
      if (!cache['guesty_token']) return res.json({ status: 'absent' });
      const expiresAt = parseInt(cache['guesty_token_expires_at'], 10);
      const remainsMs = expiresAt - Date.now();
      if (remainsMs <= 0) return res.json({ status: 'expiré', expiresAt: new Date(expiresAt).toISOString() });
      return res.json({ status: 'valide', expiresAt: new Date(expiresAt).toISOString(), remainsMin: Math.round(remainsMs / 60000) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/guesty/refresh-token', async (req, res) => {
    try {
      const token = await getGuestyToken();
      const rows  = query("SELECT value FROM config WHERE key='guesty_token_expires_at'");
      res.json({ success: true, expiresAt: new Date(parseInt(rows[0].value, 10)).toISOString(), tokenPreview: token.substring(0, 20) + '...' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── API owners ─────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/owners', (req, res) => {
    try {
      res.json(query(`
        SELECT o.id, o.nom,
               COUNT(DISTINCT l.id) AS nb_listings,
               COUNT(DISTINCT r.id) AS nb_res
        FROM owners o
        LEFT JOIN listings l ON l.owner_id = o.id
        LEFT JOIN reservations r ON r.listing_id = l.id
        GROUP BY o.id, o.nom ORDER BY o.nom ASC`));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── API listings ───────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/listings', (req, res) => {
    try {
      res.json(query(`
        SELECT l.id, l.nom, l.active, l.comm, l.menage, l.titre,
               l.owner_id, l.external_url, o.nom AS owner_nom,
               COUNT(r.id) AS nb_res
        FROM listings l
        LEFT JOIN owners o ON l.owner_id = o.id
        LEFT JOIN reservations r ON r.listing_id = l.id
        GROUP BY l.id ORDER BY l.nom ASC`));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── API réservations ───────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/reservations', (req, res) => {
    try {
      const { plateforme, listing_id, date_from, date_to } = req.query;
      let sql = `
        SELECT r.id, r.listing_id, l.nom AS listing_nom, o.nom AS owner_nom,
               r.plateforme, r.date_debut, r.duree, r.prix_nuit, r.prix_total,
               r.menage, r.commission, r.hobe, r.versement, r.booking_date
        FROM reservations r
        JOIN listings l ON r.listing_id = l.id
        LEFT JOIN owners o ON l.owner_id = o.id
        WHERE 1=1`;
      const params = [];
      if (plateforme)  { sql += ' AND r.plateforme=?';   params.push(plateforme); }
      if (listing_id)  { sql += ' AND r.listing_id=?';   params.push(listing_id); }
      if (date_from)   { sql += ' AND r.date_debut>=?';  params.push(date_from); }
      if (date_to)     { sql += ' AND r.date_debut<=?';  params.push(date_to); }
      sql += ' ORDER BY r.date_debut DESC';
      res.json(query(sql, params));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Démarrage ──────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`🚀  Suivi Réservations  →  http://localhost:${PORT}  (v0.2.4)`);
    console.log(`    Réseau local        →  http://Black6:${PORT}`);
  });
}

startServer().catch(err => { console.error('❌  Erreur au démarrage :', err); process.exit(1); });
