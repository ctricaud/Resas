# CLAUDE.md — Suivi Réservations

Ce fichier est relu automatiquement à chaque session. Il contient les préférences et le contexte du projet.

---

## Projet

**Nom :** Suivi Réservations
**Port :** 3010
**Stack :** Express.js (Node.js) + HTML/CSS/JS vanilla + SQLite (sql.js)
**Intégration :** API Guesty (OAuth2) pour la synchronisation des réservations

---

## Dépôt Git et synchronisation

**Branche de référence :** `claude/review-airbnb-project-nE4SV`
C'est cette branche que le propriétaire synchronise sur sa machine locale via :
```bash
git pull origin claude/review-airbnb-project-nE4SV
```

**Contrainte système :** Chaque session Claude reçoit automatiquement une nouvelle branche de travail (ex. `claude/add-revenue-analysis-mKz2Y`). Je ne peux pousser que sur cette branche de session.

**À faire en fin de session :** Pour récupérer les modifications sur la branche de référence, exécuter depuis la machine locale :
```bash
git checkout claude/review-airbnb-project-nE4SV
git pull origin <branche-de-session-claude>
```

---

## Structure des fichiers clés

```
server.js                    # Serveur Express, routes, API, sync Guesty
init-db.js                   # Schéma SQLite
public/
  index.html                 # Page d'accueil / menu
  reservations.html          # Liste des réservations
  listings.html              # Liste des propriétés
  owners.html                # Liste des propriétaires
  suivi-prises.html          # Tableau des prises de réservation (versements par mois/an de réservation)
  analyse-revenus.html       # Analyse des revenus (revenus proratisés, taux de remplissage, prix moyen)
```

---

## Modèle de données

- **owners** : `id, nom`
- **listings** : `id, nom, owner_id, comm (taux commission), menage, active`
- **reservations** : `id, listing_id, plateforme, date_debut, duree, prix_nuit, prix_total, menage, commission, hobe, versement, booking_date`
- **config** : stockage token Guesty

**Champ clé :** `versement` = revenu net versé au propriétaire après commission et conciergerie.

---

## Style et conventions

- Thème sombre (fond `#0a0a0a`, or `#f0b429`)
- Polices : Bebas Neue (titres) + Nunito (UI)
- Pas de framework CSS ni JS — tout en vanilla
- Version actuelle : v0.1.4 (affichée dans les footers)
