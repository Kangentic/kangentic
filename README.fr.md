<!-- readme-translation source-blob=3c139f6ee74019ac75b29fddea661fd14d0b0846 -->
> Ceci est une traduction automatique de [README.md](README.md) à la révision `3c139f6`. La version anglaise fait foi.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Logo de Kangentic" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Faites glisser une carte. Un agent démarre.</strong><br />
  Un environnement de développement agentique pour les agents de codage IA.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Dernière version" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="Version npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="Licence AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="Le tableau Kangentic avec des tâches dans To Do, Planning, Executing et Code Review. Chaque carte en cours d'exécution affiche le dernier message de son agent, et le terminal de l'agent sélectionné est ouvert sous le tableau. Ouvre la démo en direct." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Démo en direct</a> |
  <a href="https://www.kangentic.com/getting-started/">Démarrage rapide</a> |
  <a href="https://www.kangentic.com/overview/">Documentation</a>
</p>

<!-- language-switcher -->
<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">中文(简体)</a> |
  <a href="README.zh-TW.md">中文(繁體)</a> |
  Français |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.cs.md">Čeština</a> |
  <a href="README.hu.md">Magyar</a>
</p>
<!-- /language-switcher -->

## À quoi ça sert

Un agent de codage peut mener une tâche seul, et les arborescences de travail git permettent d'en exécuter plusieurs à la fois. La limite, c'est alors vous : quel agent attend une saisie, lequel a terminé, et où est passée chaque branche. Kangentic regroupe toutes les sessions sur un seul tableau et signale celles qui ont besoin de vous.

### Pilotez vos agents depuis un seul tableau

- **Un tableau, tous les agents.** Chaque carte affiche son modèle, la part de la fenêtre de contexte utilisée et le dernier message de l'agent, avec une marque sur celles qui ont besoin de vous.
- **Kangentic Mobile.** Associez votre téléphone une seule fois, puis suivez vos agents, répondez à la question sur laquelle l'un d'eux s'est arrêté et examinez son diff loin de votre bureau. La connexion est chiffrée de bout en bout, via le relais de Kangentic ou un relais que vous hébergez. Disponible sur l'[App Store](https://apps.apple.com/app/kangentic/id6794952339) et [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile).
- **Quinze CLI d'agents.** Planifiez avec Claude Code et développez avec Codex, ou utilisez une seule CLI partout. Kangentic exécute les CLI que vous avez déjà, avec les identifiants que vous avez déjà configurés. Pas de clé API, pas de proxy, pas de compte Kangentic.
- **Tous vos projets au même endroit.** Chaque dépôt a son propre tableau, et le moniteur d'agents affiche les agents en cours d'exécution dans tous vos projets.
- **Revue sur le tableau.** Le panneau Modifications affiche le diff et l'historique des commits de chaque tâche. Une pull request liée sur GitHub ou Azure DevOps affiche son état et indique si elle est prête à être fusionnée.
- **Gratuit et open source.** AGPL-3.0, avec toutes les fonctionnalités incluses et aucune offre payante.

### Adaptez le workflow

- **Colonnes.** Renommez, ajoutez et reconfigurez les colonnes jusqu'à ce que le tableau corresponde à votre façon de livrer. Chaque colonne a son propre agent, modèle, niveau d'effort et mode d'autorisation. La configuration est commitée avec le dépôt dans `kangentic.json` : vos coéquipiers obtiennent ainsi le même tableau, tandis que les tâches et les sessions d'agent restent sur la machine de chacun.
- **Automatisations.** Quand une tâche entre dans une colonne, quand son agent termine un tour ou quand la tâche en sort, une colonne peut envoyer à l'agent un message ou une commande slash, exécuter un script, appeler un webhook, vous envoyer une notification ou déplacer la tâche vers la colonne suivante. Une condition rédigée en langage courant, vérifiée par un agent, détermine si une étape s'exécute.
- **Workflows.** Donnez un brief à l'agent de workflow, examinez les tâches liées qu'il planifie, puis appuyez sur Démarrer. Chaque tâche démarre quand les tâches dont elle dépend atteignent Done, et un même workflow peut couvrir plusieurs projets.
- **Des agents qui travaillent sur le tableau.** Le serveur MCP de Kangentic permet à un agent en cours d'exécution de créer des tâches, de déplacer sa propre carte, de rechercher dans les conversations passées et d'envoyer un message à l'agent d'une autre tâche : une règle écrite dans un prompt peut ainsi faire avancer le travail.

## Est-ce fait pour vous ?

**C'est un bon choix si vous :**

- exécutez plusieurs agents de codage à la fois et perdez de vue celui qui vous attend.
- jonglez entre des tâches de plusieurs projets ou clients et voulez voir tous vos agents dans une seule vue.
- voulez combiner Claude Code, Codex et d'autres CLI avec les abonnements que vous payez déjà.
- avez un workflow en plusieurs étapes et voulez personnaliser ses agents et ses automatisations par projet.
- voulez répondre à vos agents depuis votre téléphone quand vous vous absentez.

**Ce n'est probablement pas pour vous si vous :**

- préférez travailler sur une seule tâche à la fois, du début à la fin.
- travaillez sur un seul projet et en changez rarement.
- n'utilisez pas de CLI d'agents, ou préférez des applications comme Cursor ou Claude Desktop.
- n'avez pas besoin de workflows ni d'automatisations dans votre façon de développer.
- voulez que vos agents s'exécutent dans le cloud plutôt que sur votre machine.

Si cela vous semble utile, une ⭐ aide d'autres développeurs à découvrir Kangentic.

## Installation

```bash
npx kangentic
```

Cette commande télécharge la dernière version pour votre plateforme depuis [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest), l'installe et l'ouvre. L'application se met ensuite à jour d'elle-même. Les programmes d'installation sont aussi disponibles sur la page des versions si vous préférez en exécuter un vous-même.

**Configuration requise**

- Windows x64, macOS 13 ou version ultérieure sur Apple Silicon ou Intel, ou Linux x64 ou arm64 (`.deb` ou `.rpm`). Le graphe de connaissances n'est pas disponible sur les Mac Intel.
- Node.js 20 ou version ultérieure pour `npx`, et Git 2.26 ou version ultérieure.
- Au moins une [CLI d'agent prise en charge](#supported-agents), installée et connectée.

Les utilisateurs de WSL installent la version Windows et peuvent choisir une distribution WSL comme shell du terminal. Les agents exécutent l'installation Windows de chaque CLI : une CLI installée uniquement dans la distribution est donc introuvable. Le [guide d'installation](https://www.kangentic.com/guide/installation/) couvre chaque plateforme.

## Fonctionnement

1. **Configurez votre tableau.** Gardez les colonnes par défaut ou réorganisez-les, et choisissez l'agent et le mode d'autorisation de chacune.
2. **Créez une tâche.** Donnez-lui un titre et un prompt, ou importez-en une depuis GitHub Issues, GitHub Projects, Azure DevOps ou Asana.
3. **Faites glisser pour lancer.** Kangentic crée l'arborescence de travail, applique le mode d'autorisation de la colonne et démarre l'agent.
4. **Regardez-le coder.** Suivez l'agent dans son terminal en direct, répondez quand il pose une question, et faites glisser la carte vers la suite quand il a terminé.

<a name="supported-agents"></a>
## Agents pris en charge

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-cli), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli), et [Ollama](https://ollama.com) pour les modèles locaux en mode chat à tour unique.

La reprise après un redémarrage, les outils MCP du tableau et la transmission de l'historique à l'agent suivant dépendent de la CLI. Consultez [ce que chaque agent prend en charge](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Langues

L'interface de Kangentic est disponible dans chacune des langues listées en haut de cette page. Changez-la dans Settings > Language, et Kangentic redémarre dans cette langue. Les traductions sont automatiques et ouvertes à la relecture, et la page [Traductions](docs/contributing/translations.md) explique comment en corriger une.

## Données et confidentialité

Vos tableaux, vos tâches et vos transcriptions restent dans une base de données SQLite locale. Les CLI d'agents contactent leurs propres fournisseurs avec vos propres comptes, comme elles le feraient dans votre terminal.

Les builds de version envoient par défaut des événements d'utilisation anonymes (Aptabase) et des rapports d'erreurs (Sentry). Les événements d'utilisation ne contiennent jamais le texte des tâches, les prompts ni le code. Définissez `KANGENTIC_TELEMETRY=0` pour désactiver les deux, ou `KANGENTIC_ERROR_REPORTING=0` pour désactiver uniquement les rapports d'erreurs. Il n'existe aucune option dans l'application. L'application vérifie aussi sur GitHub les mises à jour et les annonces. Consultez la [politique de confidentialité](https://www.kangentic.com/privacy/) pour la liste complète.

## Documentation

Commencez par le [démarrage rapide](https://www.kangentic.com/getting-started/), puis consultez la [documentation](https://www.kangentic.com/overview/) pour les colonnes, les automatisations, les workflows, le serveur MCP et la configuration.

## Développement

La compilation depuis les sources nécessite Node.js 22.14 ou version ultérieure, ou 24 ou version ultérieure.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Contribuer

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour la structure du projet, les tests et les conventions. Les contributeurs signent un [CLA](CLA.md) avant la fusion de leur première pull request.

## Support

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) pour les questions et les demandes de fonctionnalités
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) pour signaler des bugs
- [support@kangentic.com](mailto:support@kangentic.com) si vous préférez ne pas écrire publiquement

Pour signaler un problème de sécurité, consultez [SECURITY.md](SECURITY.md).

## Licence

[AGPL-3.0](LICENSE). Pour une licence commerciale, écrivez à licensing@kangentic.com.
