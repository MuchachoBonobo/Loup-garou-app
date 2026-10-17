# Guide de déploiement — La Nuit du Village

Ce guide t'accompagne pas à pas pour mettre le site en ligne. Compte 30 à 45 minutes en tout. Aucune compétence technique requise — il suffit de suivre les étapes.

## Contenu du dossier

```
site-deploiement/
├── index.html              ← page d'accueil (optimisée SEO)
├── mentions-legales.html   ← à compléter avant publication
├── cgv.html                ← à adapter à ton activité
├── confidentialite.html    ← à compléter
├── robots.txt              ← indique aux moteurs ce qu'ils peuvent indexer
├── sitemap.xml             ← liste des pages pour Google
├── og-image.png            ← image de partage (1200×630)
├── og-image.svg            ← version source (modifiable)
└── DEPLOIEMENT.md          ← ce fichier
```

---

## Étape 1 — Créer ton statut auto-entrepreneur (préalable)

Si ce n'est pas déjà fait :

1. Va sur le guichet unique de l'INPI : **https://formalites.entreprises.gouv.fr**
2. Crée ton compte, lance la formalité "Création d'entreprise"
3. Choisis l'activité **9329Z – Autres activités récréatives et de loisirs** (animation événementielle)
4. Sélectionne le régime **micro-entreprise** (auto-entrepreneur)
5. Tu reçois ton SIRET sous 1 à 3 semaines

**Tu peux faire la suite en parallèle** — pas besoin d'attendre le SIRET pour acheter le domaine et créer l'hébergement.

---

## Étape 2 — Acheter ton nom de domaine

Mon conseil : **Gandi** (français, sérieux, interface propre) ou **Cloudflare Registrar** (moins cher mais en anglais).

1. Va sur **https://www.gandi.net**
2. Tape ton nom de domaine envisagé : par exemple `lanuitduvillage.fr`
3. S'il est disponible (≈ 12 €/an), achète-le
4. Crée un compte Gandi, paie

**Suggestions de noms** (à vérifier disponibles) :
- `lanuitduvillage.fr` — poétique, brandable (recommandé)
- `loup-garou-lyon.fr` — explicite SEO
- `soireeloupgarou.fr` — national, SEO direct
- `lavoixdesloups.fr` — atmosphérique

**Astuce SEO** : tu peux acheter le nom "marque" + un domaine SEO en redirection (ex. `lanuitduvillage.fr` comme principal, `loup-garou-lyon.fr` qui redirige vers lui). 24 €/an au total.

---

## Étape 3 — Créer ton compte Netlify

1. Va sur **https://www.netlify.com**
2. Clique sur "Sign up", inscris-toi avec ton email (ou GitHub si tu en as un)
3. Confirme ton email

C'est gratuit pour ton usage. Aucune carte bancaire demandée.

---

## Étape 4 — Déposer le site

### Méthode "drag & drop" (la plus simple)

1. Une fois connecté à Netlify, va dans **Sites**
2. Tu verras une zone en bas avec écrit **"Want to deploy a new site without connecting to Git? Drag and drop your site output folder here"**
3. Ouvre l'explorateur de fichiers sur ton ordinateur, va dans le dossier `site-deploiement/`
4. **Sélectionne le contenu** du dossier (Ctrl+A) et glisse-le sur la zone Netlify
5. Attends 30 secondes — ton site est en ligne !
6. Netlify te donne une URL temporaire du type `https://random-name-12345.netlify.app`

### Pour vérifier que tout marche

Ouvre l'URL temporaire. Tu dois voir le site exactement comme en local. Teste :
- Le bouton "Me contacter" descend bien jusqu'au formulaire
- Les liens vers les mentions légales, CGV, confidentialité fonctionnent
- L'image OG est visible si tu vas sur `[ton-url]/og-image.png`

---

## Étape 5 — Brancher ton nom de domaine

Tu veux que `lanuitduvillage.fr` pointe vers ton site Netlify.

### Dans Netlify

1. Dans ton site Netlify, va dans **Domain management**
2. Clique sur **"Add custom domain"**
3. Tape ton domaine (`lanuitduvillage.fr`), valide
4. Netlify te montre les enregistrements DNS à configurer (ils ressemblent à `75.2.60.5` ou `apex-loadbalancer.netlify.com`)

### Dans Gandi (ou ton registrar)

1. Connecte-toi à Gandi
2. Va dans le domaine acheté > **Enregistrements DNS**
3. Soit tu changes les **nameservers** vers ceux de Netlify (plus simple, Netlify gère tout)
4. Soit tu ajoutes manuellement les enregistrements A/CNAME indiqués par Netlify

**Plus simple option** : pointer les nameservers vers Netlify :
- `dns1.p01.nsone.net`
- `dns2.p01.nsone.net`
- `dns3.p01.nsone.net`
- `dns4.p01.nsone.net`

Attends 1 à 24 heures pour la propagation DNS. Souvent c'est effectif en moins d'une heure.

### HTTPS automatique

Une fois le domaine connecté, Netlify active automatiquement le certificat SSL (Let's Encrypt). Tu n'as rien à faire — ton site est accessible en `https://`.

---

## Étape 6 — Compléter les pages légales

Avant que des visiteurs n'arrivent, **complète les mentions légales et la politique de confidentialité** (obligatoire pour une activité commerciale).

Pour chaque fichier `.html` dans Netlify, deux options :

**Option A — Édition en local puis re-déploiement** (recommandé)
1. Édite les fichiers `.html` directement sur ton ordinateur (avec n'importe quel éditeur de texte)
2. Cherche chaque `[À REMPLIR]` et remplace-le par la vraie valeur
3. Retourne sur Netlify, glisse-dépose le dossier mis à jour pour redéployer

**Option B — Édition via Netlify**
Netlify ne propose pas d'éditeur intégré natif, donc l'option A est préférable.

**Liste des champs à remplir** dans `mentions-legales.html` :
- `[VOTRE NOM]` → ton nom complet
- `[Auto-entrepreneur / EI / SASU / autre]` → ton statut
- `[VOTRE NUMÉRO SIRET]` → 14 chiffres une fois reçu de l'INPI
- `[VOTRE ADRESSE COMPLÈTE]` → adresse de domiciliation
- `[VOTRE NUMÉRO]` → téléphone si tu veux l'afficher
- `[DATE]` → date du jour
- etc.

Idem dans `cgv.html` et `confidentialite.html`.

**Recherche & remplacement rapide** dans les 3 fichiers — tu peux ouvrir chaque fichier dans VS Code, Notepad++, ou TextEdit, faire un Ctrl+F sur `[VOTRE NOM]`, "Replace All".

---

## Étape 7 — Mettre à jour les URLs dans le code

Dans `index.html`, `sitemap.xml` et `robots.txt`, remplace toutes les occurrences de **`VOTRE-DOMAINE.fr`** par ton vrai domaine (ex. `lanuitduvillage.fr`).

Fichiers concernés :
- `index.html` (8 occurrences dans les meta + JSON-LD)
- `sitemap.xml` (4 occurrences)
- `robots.txt` (1 occurrence)

Redéploie sur Netlify après modifications (drag & drop du dossier mis à jour).

---

## Étape 8 — Activer le formulaire de contact

Bonne nouvelle : le formulaire est déjà configuré ! Netlify détecte automatiquement le `data-netlify="true"` et active le formulaire.

Pour recevoir les messages :
1. Dans Netlify, va dans ton site > **Forms**
2. Tu y verras toutes les soumissions
3. Dans **Settings > Forms > Form notifications**, configure :
   - **Email notification** → ton email (alexandre@ivanez.com)
   - Tu reçois un mail à chaque demande de contact

Pense à tester le formulaire toi-même une fois en ligne.

---

## Étape 9 — Référencement Google (SEO)

### 9a. Google Search Console (obligatoire)

C'est ce qui dit à Google "ce site existe, viens l'indexer".

1. Va sur **https://search.google.com/search-console**
2. Connecte-toi avec un compte Google
3. Clique **"Ajouter une propriété"** > entre ton domaine
4. Google te demande de vérifier que tu possèdes le domaine. Le plus simple : ajouter un enregistrement TXT chez Gandi (Google te donne la chaîne exacte)
5. Une fois vérifié, va dans **Sitemaps** > soumets `sitemap.xml`
6. Google va commencer à crawler ton site (compte 1 à 4 semaines pour apparaître)

### 9b. Google Business Profile (TRÈS important pour ton activité locale)

C'est ce qui te met dans la carte Google quand on cherche "animation soirée Lyon".

1. Va sur **https://www.google.com/business**
2. Crée un profil :
   - **Nom** : La Nuit du Village
   - **Catégorie** : "Service d'animation événementielle" ou "Animateur d'événements"
   - **Zone d'intervention** : tu coches "Je livre/me déplace chez les clients" → tu indiques Lyon + zones autour
3. Google va t'envoyer un courrier postal avec un code à 5 chiffres pour vérifier ton adresse (compte 5 à 14 jours)
4. Une fois vérifié, **ajoute des photos** (très important pour le clic) et **demande des avis** à tes premiers clients

C'est probablement ton meilleur levier de visibilité locale. Plus important que le SEO classique.

### 9c. Bing Webmaster (bonus rapide)

Quelques % de tes visiteurs potentiels passent par Bing. Si tu as fait Search Console, tu peux importer ton site en un clic sur **https://www.bing.com/webmasters**.

---

## Étape 10 — Premières actions de visibilité

Une fois le site en ligne :

1. **Annuaires locaux gratuits** : inscris-toi sur PagesJaunes, Yelp, Mappy avec l'URL de ton site (backlinks gratuits, bons pour le SEO local).
2. **Réseaux sociaux** : crée au moins un compte Instagram avec ton site en bio. Le SEO ne fait pas tout — un compte Insta avec quelques photos d'ambiance peut apporter du trafic direct.
3. **Bouche-à-oreille structuré** : envoie le lien à tes premiers joueurs en leur demandant un avis Google.

---

## Étape 11 — Maintenance

Une fois en ligne, tu n'as rien à faire :

- Netlify renouvelle le certificat HTTPS automatiquement
- Le site est statique, donc aucun risque de faille de sécurité
- Tu peux modifier le contenu n'importe quand (édite, glisse-dépose, c'est en ligne en 30 secondes)

**Ce que tu peux faire évoluer plus tard** :
- Ajouter une page "Galerie" avec des photos de soirées passées
- Ajouter un blog (1 article par mois suffit pour booster le SEO)
- Collecter et publier des avis Google sur le site (sur la section "Avis")
- Activer Google Analytics 4 si tu veux mesurer le trafic (gratuit)

---

## Récapitulatif des comptes à créer

| Service | Coût | Pourquoi |
|---------|------|----------|
| INPI (auto-entrepreneur) | gratuit | Obligatoire pour activité commerciale |
| Nom de domaine (Gandi) | ~12 €/an | Adresse du site |
| Netlify | gratuit | Hébergement + formulaire de contact |
| Google Search Console | gratuit | Indexation Google |
| Google Business Profile | gratuit | Référencement local (carte Google) |

**Total à débourser** : ≈ 12 €/an pour le domaine.

---

## En cas de problème

- **Netlify ne déploie pas** : vérifie que tu glisses bien le **contenu** du dossier `site-deploiement/`, pas le dossier lui-même.
- **Le domaine ne pointe pas** : la propagation DNS peut prendre jusqu'à 24h. Attends.
- **Le formulaire ne fonctionne pas** : vérifie que tu as bien re-déployé après ajout. Va dans Netlify > Forms pour voir s'il est listé.
- **Pas dans Google après 1 mois** : vérifie Search Console > Couverture, regarde s'il y a des erreurs.

Bon lancement.
