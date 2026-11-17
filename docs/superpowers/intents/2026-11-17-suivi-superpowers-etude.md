# Étude de faisabilité : le suivi Superpowers en plugin Orca

17/11/2026. Orca 1.4.259 au début (host API 1.9), 1.4.261 après une mise à jour automatique en pleine sonde (host API 1.10). Superpowers 7.0.2 (upstream, publié le 03/11/2026).
Aucun dossier ni dépôt créé. Une sonde jetable a été chargée dans Orca avec l'accord de Romain, puis déchargée et mise à la corbeille.

## Verdict

**Faisable, sans toucher au source d'Orca, et nettement mieux que le mod.** La raison tient en une phrase : Superpowers écrit déjà son avancement sur le disque, et un worker de plugin Orca sait lire le disque. Le mod devine l'état à partir des appels d'outils ; le plugin peut le lire.

Approche retenue par Romain : B, le disque d'abord. La sonde l'a confirmée sur tous les points (voir « Résultats de la sonde »).

## Le mod aujourd'hui, et où il casse

`~/.claude/mods/erom-progress` : 457 lignes de code, 285 de tests.

- Il écoute `tool.call` dans la session et fait avancer une machine à états (`applySignal`).
- L'avancement des tâches vient d'expressions régulières sur la description des sous-agents (`Implement Task N`, `Review Task N`, `fix round N`). Une description formulée autrement et la fiche décroche.
- Le rattrapage (`/progress replay`) repasse tous les transcripts du projet dans `jq`, avec un plafond de 120 s.
- Il vit dans une session Claude Code : une session, un projet, un harnais. Chemins de `zed` et `jq` en dur.

Ses tests couvrent bien la logique, mais la logique est une inférence. C'est elle qui manque de contrôle, pas les tests.

## Ce que Superpowers laisse sur le disque (prouvé)

| Artefact | Emplacement | Ce qu'il dit |
|---|---|---|
| Intent, spec, plan | `docs/superpowers/{intents,specs,plans}/YYYY-MM-DD-<sujet>.md` | Les trois premières étapes existent, ou non |
| Tâches du plan | titres `## Task N: …` dans le plan | Liste et ordre des tâches |
| Ledger | `.superpowers/sdd/<nom-du-plan>/progress.md` | Avancement réel, tâche par tâche |

Le ledger commence par `# SDD ledger`, un tiret, puis `plan: <chemin>`, et reçoit une ligne par événement :

- `Task N: complete (commits a..b, review clean)` ou `(…, K parked)`
- `Task N: fix round 1/5 …`, `Task N: dispatched …`
- `Ruling: …` (chaque décision prise en route), `Task N: minor (deferred): …`

Il sert aux deux modes d'exécution (SDD et `executing-plans`), il est ignoré par git, il vit dans le working tree, donc un ledger par worktree.

Vérifié : le contrat est identique dans le Superpowers upstream (`skills/subagent-driven-development/SKILL.md`, lignes 116-123 et 313-314). Ta copie locale est modifiée, mais pas sur ce point. Le plugin peut donc viser l'upstream.

Vérifié sur ton disque : au moins 20 ledgers réels sous `~/dev`. Ils dérivent : puce `- ` ou non, tiret cadratin ou simple dans l'en-tête, lignes en français (« implementee, en attente de review »), ancien emplacement `.superpowers/sdd/progress.md` sans dossier de plan. Seules deux formes tiennent partout : l'en-tête et `Task N: complete (`.

## Ce qu'Orca offre (prouvé)

| Besoin | API | Preuve |
|---|---|---|
| Lire les fichiers d'un chantier | worker Node sans restriction (`node:fs`) | `plugin-host-process.ts:53-57` (fork, `execArgv: []`) ; ton plugin `agent-network` le fait déjà (`src/worker.ts:3-4`) |
| Connaître tous les chantiers | `workspace.list` : chaque worktree, son `path`, sa branche, son statut | `host-api.md:114` |
| Savoir quel agent travaille ou bloque | `agents.list`, événement `agent.status.changed` | `events.md:13` |
| Être réveillé quand un agent agit | hook `agent.tool.after`, observation seule | `host-api.md:173`, `agent-tool-plugin-hooks.ts:47-49` |
| Rester vivant pour surveiller | un worker avec un élément de barre d'état tourne tant que le plugin est actif | `host-api.md:108` |
| Afficher | panneau `components` : `Tree`, `Table`, `Progress`, `Badge`, `Collapsible`, `Markdown`, `RelativeTime` | `components.md` |
| Agir | `editor.open`, `terminal.focus`, `agent.resume`, `notifications.show` | `host-api.md:128,136,142,76` |
| Tester | `orca/testing` : `mountWorker`, `hooks.fire`, `mount`, scénarios de `check`, `plugin shot` | `testing.md`, `workflow.md` |

Deux limites lues dans le code :

1. Le hook d'outil ne dit pas si l'appel vient du fil principal ou d'un sous-agent (`agent-tool-call-reader.ts:152-162`). Le mod filtre là-dessus (`e.agentId`). Porter sa machine à états telle quelle donnerait donc des états faux.
2. Les agents sur SSH ou WSL ne sont pas hookés, et le worker ne lit pas un disque distant.

## Trois approches

**A. Porter le mod : signaux vers machine à états.** Le hook `agent.tool.after` remplace `tool.call`. Écarté : on garde la fragilité des expressions régulières, on perd le filtre des sous-agents, et un Orca redémarré en plein chantier perd le fil.

**B. Le disque d'abord (recommandée).** La vérité, ce sont les fichiers : docs, plan, ledger, plus `git log` pour les commits que le ledger nomme. Les hooks et événements ne servent qu'à deux choses : dire « relis maintenant », et montrer ce que le disque ne sait pas encore (une étape en cours avant son premier fichier, quel terminal pilote quel plan). Résiste au redémarrage, à la compaction, au changement de harnais, et se teste sur de vrais fichiers.

**C. Proposer à Superpowers un état structuré** (un `progress.json` à côté du ledger). Le plus propre à terme, mais dépend des mainteneurs et ne couvre aucun chantier existant. À garder comme contribution possible une fois B en service, preuves à l'appui.

## Ce que B rend possible, et que le mod ne peut pas faire

```
SUPERPOWERS                                         3 chantiers
▾ agent-network · feat/plugin-jalon-2        tâche 4/5 · fix 2/5
    intent ✓  spec ✓  plan ✓  exécution ●  revue finale ○  livraison ○
    Claude travaille depuis 4 min            [terminal] [plan] [ledger]
    3 décisions prises · 5 mineurs différés
▸ idema · feat/p4-jalon2                     bloqué : attend ta réponse
▸ lazaret · main                             livré le 16/09
```

- **Tous les chantiers d'un coup**, un par worktree, quel que soit l'agent qui les mène. Le mod ne voit que sa session.
- **Le journal des décisions** : les `Ruling:` et les mineurs différés du ledger, c'est-à-dire ce que tu dois relire avant de fusionner.
- **Barre d'état** : l'avancement du chantier en cours, visible sans ouvrir le panneau.
- **Notifications** aux moments qui te demandent : agent bloqué, plan terminé, revue finale rendue.
- **Un clic** pour ouvrir la spec ou le plan dans l'éditeur d'Orca, aller au terminal de l'agent, reprendre la session.
- **Historique** : Superpowers supprime le dossier du ledger après une revue finale propre. Le plugin en garde une copie dans son stockage, donc le chantier livré reste consultable.
- **Zéro token** : rien n'entre dans le contexte des agents.

## Risques, par ordre de gravité

1. **Le ledger est de la prose écrite par un modèle.** Parade : un parseur tolérant qui ne retient que les formes sûres, qui affiche « N lignes non comprises » au lieu de deviner, et dont les fixtures sont tes ledgers réels. C'est le cœur du « contrôlé, testé ».
2. **Le contrat du ledger vit dans le texte d'une skill** et peut changer d'une version de Superpowers à l'autre. Parade : fixtures par version, version testée affichée.
3. **`trusted-worker` est le niveau d'accès le plus élevé d'Orca.** Pour un plugin communautaire, demander le minimum : `workspace:read`, `agent:read`, `storage:own`, `settings:own`, `notifications:show`, et `workspace:write` seulement si on garde les boutons d'ouverture.
4. **Local seulement en v1** : pas de SSH ni de WSL (limite 2 ci-dessus). À écrire dans le README.
5. **Avant le premier fichier, le disque est muet** : un brainstorming en cours ne se voit que par le hook. Sans hook, le chantier apparaît à l'écriture de l'intent.
6. **L'API d'Orca bouge vite** (hooks arrivés en 1.4.248, deux versions d'Orca dans la même matinée). Plancher `engines.orca` à fixer, et `host.has()` avant toute méthode récente.

## Résultats de la sonde (17/11, 08:49 à 08:53)

Plugin jetable `local.sp-probe` : un hook `agent.tool.after`, une surveillance de fichiers sur un faux ledger, un élément de barre d'état. Les stimulus étaient les appels d'outils de la session d'étude elle-même, qui tourne dans un terminal Orca.

| Question | Résultat | Mesure |
|---|---|---|
| Le hook reçoit-il les appels utiles ? | Oui | `Skill` (`skill`), `Agent` (`description`, `prompt`, `subagent_type`), `Write` (`file_path`, `content`), `Edit`, `Read` (`file_path`), `Bash` (`command`), chacun avec sa sortie |
| Les appels des sous-agents arrivent-ils ? | Oui, et rien ne les distingue | le `echo` et le `Read` d'un sous-agent sont au journal, avec les mêmes champs que ceux du fil principal |
| Perd-on des événements ? | Non en régime normal | 14 sur 14, dont 6 lancés en parallèle ; 2 perdus pendant les 18 s du redémarrage d'Orca |
| Le worker reste-t-il vivant ? | Oui | relancé seul 1,4 s après le redémarrage d'Orca, sans sollicitation (`keepWarm`, `plugin-worker-spawn-spec.ts:21`) ; sa mémoire repart de zéro |
| Délai de la surveillance de fichiers | 4 à 64 ms | 6 mesures : un `Write`, un `Edit`, trois ajouts par `>>` |
| Relier un appel à un workspace | Oui | le `workspaceId` du hook vaut `projectId::path` de `workspace.list` ; `agent.status.changed` porte les deux identifiants |
| Ouvrir un fichier dans Orca | `editor.open` répond `opened: true` | sur un ledger ignoré par git, chemin relatif, dans un workspace non affiché ; à confirmer de visu (un onglet `progress.md` dans `agent-network`) |
| Aller au terminal d'un agent | `terminal.focus` répond `focused: true` | sur le terminal de la session d'étude |
| Barre d'état | « SP probe 6 » lu sur la capture | mis à jour par le worker à chaque écriture, `plugin shot --status-bar` |

Quatre enseignements pour la conception :

1. **Orca redémarre sans prévenir.** Il s'est mis à jour seul pendant la sonde. Le worker est reparti la mémoire vide et deux appels sont passés à la trappe. Un état tenu dans les signaux aurait été faux ; un état relu sur le disque ne l'est pas.
2. **`agent.status.changed` se répète.** 70 événements « working » en quatre minutes pour un seul agent : il faut ne réagir qu'au changement d'état.
3. **La surveillance est bavarde.** Elle voit passer les fichiers temporaires (`progress.md.tmp.…`) et double certains événements : filtrer, puis regrouper avant de relire.
4. **Le `sessionId` d'`agents.list` est celui de la session Claude Code**, donc le nom de son transcript. « Reprendre le chantier » peut viser la bonne session.

Limite lue dans le code : un envoi de hook de plus de 1 Mo est rejeté (`request-body.ts:6`). Sans effet ici, puisque le plugin relit le fichier et ne dépend pas du contenu transporté.

## Non vérifié

- Le hook pour les harnais autres que Claude Code (noms d'outils différents, lus dans le code, pas joués).
- Une skill lancée par la personne en commande slash plutôt que par l'outil `Skill` : produit-elle un appel d'outil visible ?
- L'onglet ouvert par `editor.open` : l'API dit oui, personne ne l'a regardé.
- L'existence d'un plugin équivalent dans le catalogue communautaire d'Orca : aucune adresse de catalogue trouvée dans le code lu.
- Le coût de la surveillance de fichiers sur plusieurs dizaines de worktrees (9 workspaces sur cette machine).
