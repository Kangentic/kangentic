<!-- readme-translation source-blob=ded000bed8af5253da7d62f8cafb9a8369f243a4 -->
> Это машинный перевод [README.md](../README.md) в редакции `ded000b`. Основной считается английская версия.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Логотип Kangentic" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Перетащите карточку. Агент начнёт работу.</strong><br />
  Агентная среда разработки для ИИ-агентов программирования.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Последний выпуск" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="Версия npm" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="Лицензия AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://kangentic.github.io/kangentic/readme/board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://kangentic.github.io/kangentic/readme/board-light.png" />
      <img src="https://kangentic.github.io/kangentic/readme/board-dark.png" alt="Доска Kangentic с задачами в столбцах To Do, Planning, Executing и Code Review. На каждой работающей карточке показано последнее сообщение её агента, а под доской открыт терминал выбранного агента. Открывает демо-версию." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Демо-версия</a> |
  <a href="https://www.kangentic.com/getting-started/">Быстрый старт</a> |
  <a href="https://www.kangentic.com/overview/">Документация</a>
</p>

<!-- language-switcher -->
<p align="center">
  <a href="../README.md">English</a> |
  <a href="README.zh-CN.md">中文(简体)</a> |
  <a href="README.zh-TW.md">中文(繁體)</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a> |
  Русский |
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.cs.md">Čeština</a> |
  <a href="README.hu.md">Magyar</a>
</p>
<!-- /language-switcher -->

## Возможности

Агент программирования может сам довести задачу до конца, а рабочие деревья Git позволяют запускать несколько агентов одновременно. Тогда узким местом становитесь вы: какой агент ждёт ответа на запрос, какой закончил и куда ушла каждая ветвь. Kangentic собирает все сеансы на одной доске и отмечает те, которым нужны вы.

### Управляйте агентами с одной доски

- **Одна доска для всех агентов.** На каждой карточке видны модель, заполненность контекстного окна и последнее сообщение агента, а карточки, которым нужны вы, отмечены.
- **Kangentic Mobile.** Один раз выполните сопряжение телефона, и вы сможете следить за агентами, отвечать на вопрос, на котором агент остановился, и просматривать его diff вдали от рабочего места. Соединение защищено сквозным шифрованием и проходит через ретранслятор Kangentic или ваш собственный. Приложение доступно в [App Store](https://apps.apple.com/app/kangentic/id6794952339) и [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile).
- **Пятнадцать CLI агентов.** Планируйте с Claude Code, а реализуйте с Codex, или используйте один CLI везде. Kangentic запускает уже установленные у вас CLI с уже настроенными учётными данными. Без ключа API, без прокси, без учётной записи Kangentic.
- **Агенты на удалённом хосте.** Разместите проект на Linux-машине, к которой вы подключаетесь по SSH, и его репозиторий, агенты, сборки и тесты будут работать там. Доска остаётся на вашем компьютере, а агенты продолжают работать при обрыве соединения и после выхода из приложения. Настройка и ограничения описаны в разделе [Удалённые хосты SSH](https://www.kangentic.com/features/ssh-remote-hosts/).
- **Все проекты в одном месте.** У каждого репозитория своя доска, а Agent Monitor показывает агентов, работающих во всех них.
- **Проверка на доске.** Панель Changes показывает diff и историю коммитов каждой задачи. Для связанного pull request в GitHub или Azure DevOps отображаются его состояние и готовность к слиянию.
- **Бесплатно и с открытым исходным кодом.** AGPL-3.0, все функции включены, платных тарифов нет.

### Настройте рабочий процесс

- **Столбцы.** Переименовывайте, добавляйте и перенастраивайте столбцы, пока доска не будет соответствовать тому, как вы выпускаете код. У каждого столбца свои агент, модель, уровень усилий и режим разрешений. Настройка хранится в `kangentic.json` и коммитится вместе с репозиторием, поэтому у коллег будет такая же доска, а задачи и сеансы агентов остаются на компьютере каждого.
- **Автоматизации.** Когда задача попадает в столбец, когда её агент завершает ход или когда задача покидает столбец, столбец может отправить агенту сообщение или слэш-команду, запустить скрипт, вызвать веб-хук, уведомить вас или переместить задачу в следующий столбец. Выполнять ли шаг, решает условие, написанное обычными словами и проверяемое агентом.
- **Рабочие процессы.** Дайте агенту рабочих процессов краткое описание, просмотрите запланированные им связанные задачи и нажмите Start. Каждая задача запускается, когда задачи, которых она ждёт, доходят до Done, и один рабочий процесс может охватывать несколько проектов.
- **Агенты, работающие с доской.** MCP-сервер Kangentic позволяет работающему агенту создавать задачи, перемещать свою карточку, искать по прошлым разговорам и отправлять сообщения агенту другой задачи, поэтому правило, записанное в промпте, может продвигать работу дальше.

## Подходит ли он вам?

**Kangentic вам подойдёт, если вы:**

- запускаете несколько агентов программирования одновременно и теряете из виду, какой из них ждёт вас.
- ведёте задачи в нескольких проектах или для нескольких клиентов и хотите видеть всех агентов в одном представлении.
- хотите сочетать Claude Code, Codex и другие CLI в рамках уже оплаченных тарифов.
- работаете по многошаговому процессу и хотите настраивать его агентов и автоматизации для каждого проекта.
- хотите отвечать агентам с телефона, когда отходите от компьютера.

**Скорее всего, он вам не подойдёт, если вы:**

- предпочитаете работать над одной задачей за раз, от начала до конца.
- работаете в одном проекте и редко переключаетесь.
- не используете CLI агентов или предпочитаете приложения вроде Cursor или Claude Desktop.
- не применяете рабочие процессы и автоматизации в разработке.
- хотите, чтобы агентов запускал размещённый сервис, без установки приложения.

Если это кажется полезным, ⭐ поможет другим разработчикам найти Kangentic.

## Установка

```bash
npx kangentic
```

Эта команда скачивает последний выпуск для вашей платформы из [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest), устанавливает и запускает его. Дальше приложение обновляется само. Установщики также доступны на странице выпусков, если вы предпочитаете запустить один из них сами.

**Требования**

- Windows x64, macOS 13 или новее на Apple Silicon или Intel либо Linux x64 или arm64 (`.deb` или `.rpm`).
- Node.js 20 или новее для `npx` и Git 2.26 или новее.
- Хотя бы один [поддерживаемый CLI агента](#supported-agents), установленный и с выполненным входом.

Пользователи WSL устанавливают версию для Windows и могут выбрать дистрибутив WSL в качестве оболочки терминала. CLI агента, установленный внутри дистрибутива, запускается там, если указать путь к его копии в дистрибутиве. Сам проект храните на диске Windows. В [руководстве по установке](https://www.kangentic.com/guide/installation/) описана каждая платформа.

## Как это работает

1. **Настройте доску.** Оставьте столбцы по умолчанию или измените их и выберите агента и режим разрешений для каждого.
2. **Создайте задачу.** Укажите заголовок и промпт или импортируйте задачу из GitHub Issues, GitHub Projects, Azure DevOps, Asana, Jira, Linear, Trello, GitLab или хранилища Obsidian.
3. **Перетащите для запуска.** Kangentic создаёт рабочее дерево, применяет режим разрешений столбца и запускает агента.
4. **Следите за работой.** Наблюдайте за агентом в его терминале в реальном времени, отвечайте на его вопросы и перетаскивайте карточку дальше, когда он закончит.

<a name="supported-agents"></a>
## Поддерживаемые агенты

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli) и [Ollama](https://ollama.com) для локальных моделей в виде чата с одним ходом.

Возобновление после перезапуска, инструменты доски MCP и передача истории следующему агенту зависят от CLI. См. [что поддерживает каждый агент](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Языки

Интерфейс Kangentic доступен на всех языках, перечисленных в начале этой страницы. Язык меняется в разделе Settings > Language, после чего Kangentic перезапускается на нём. Переводы выполнены машинно и открыты для проверки, а как исправить перевод, описано в разделе [Переводы](../docs/contributing/translations.md).

## Данные и конфиденциальность

Ваши доски, задачи и расшифровки хранятся в локальной базе данных SQLite. CLI агентов обращаются к своим провайдерам под вашими учётными записями, как и в вашем терминале.

Выпускные сборки по умолчанию отправляют анонимные события использования (Aptabase) и отчёты об ошибках (Sentry). События использования никогда не содержат текст задач, промпты или код. Задайте `KANGENTIC_TELEMETRY=0`, чтобы отключить и то и другое, или `KANGENTIC_ERROR_REPORTING=0`, чтобы отключить только отчёты об ошибках. Переключателя в приложении нет. Приложение также проверяет GitHub на наличие обновлений и объявлений. Полный список приведён в [политике конфиденциальности](https://www.kangentic.com/privacy/).

## Документация

Начните с [быстрого старта](https://www.kangentic.com/getting-started/), затем перейдите к [документации](https://www.kangentic.com/overview/) о столбцах, автоматизациях, рабочих процессах, MCP-сервере и настройке.

## Разработка

Для сборки из исходного кода нужен Node.js 22.14 или новее либо 24 или новее.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Участие в разработке

Структура проекта, тесты и соглашения описаны в [CONTRIBUTING.md](../CONTRIBUTING.md). Участники подписывают [CLA](../CLA.md) до слияния их первого pull request.

## Поддержка

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) — вопросы и предложения новых функций
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) — сообщения об ошибках
- [support@kangentic.com](mailto:support@kangentic.com) — если вы не хотите писать публично

Чтобы сообщить о проблеме безопасности, см. [SECURITY.md](../SECURITY.md).

## Лицензия

[AGPL-3.0](../LICENSE). Для получения коммерческой лицензии напишите на licensing@kangentic.com.
