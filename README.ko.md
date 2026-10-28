<!-- readme-translation source-blob=3c139f6ee74019ac75b29fddea661fd14d0b0846 -->
> 이 문서는 `3c139f6` 시점 [README.md](README.md)의 기계 번역본입니다. 영어 버전이 기준 문서입니다.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic 로고" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>카드를 끌어 놓으면 에이전트가 시작됩니다.</strong><br />
  AI 코딩 에이전트를 위한 에이전틱 개발 환경입니다.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="최신 릴리스" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm 버전" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 라이선스" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="할 일, 계획, 실행, 코드 검토 열에 작업이 있는 Kangentic 보드. 실행 중인 각 카드에는 해당 에이전트의 최신 메시지가 표시되고, 선택한 에이전트의 터미널이 보드 아래에 열려 있습니다. 라이브 데모를 엽니다." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">라이브 데모</a> |
  <a href="https://www.kangentic.com/getting-started/">빠른 시작</a> |
  <a href="https://www.kangentic.com/overview/">설명서</a>
</p>

<!-- language-switcher -->
<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">中文(简体)</a> |
  <a href="README.zh-TW.md">中文(繁體)</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.ja.md">日本語</a> |
  한국어 |
  <a href="README.ru.md">Русский</a> |
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.cs.md">Čeština</a> |
  <a href="README.hu.md">Magyar</a>
</p>
<!-- /language-switcher -->

## 기능

코딩 에이전트는 작업 하나를 혼자 처리할 수 있고, Git 작업 트리를 사용하면 여러 에이전트를 동시에 실행할 수 있습니다. 그러면 한계는 사용자 쪽에 있습니다. 어떤 에이전트가 프롬프트를 기다리는지, 어떤 에이전트가 끝났는지, 각 분기가 어디로 갔는지 파악해야 합니다. Kangentic은 모든 세션을 하나의 보드에 모으고 사용자의 응답이 필요한 세션을 표시합니다.

### 하나의 보드에서 에이전트 실행

- **하나의 보드, 모든 에이전트.** 각 카드에는 모델, 컨텍스트 창 사용량, 에이전트의 마지막 메시지가 표시되며, 사용자의 응답이 필요한 카드에는 표시가 붙습니다.
- **Kangentic Mobile.** 휴대폰을 한 번 페어링하면 자리를 떠나 있어도 에이전트를 확인하고, 에이전트가 멈춘 질문에 답하고, diff를 검토할 수 있습니다. 연결은 Kangentic의 릴레이 또는 직접 호스팅하는 릴레이를 통해 종단 간 암호화됩니다. [App Store](https://apps.apple.com/app/kangentic/id6794952339) 또는 [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile)에서 받으세요.
- **15개의 에이전트 CLI.** Claude Code로 계획하고 Codex로 빌드하거나, 모든 곳에서 하나의 CLI를 사용하세요. Kangentic은 이미 설치한 CLI를 이미 구성한 자격 증명으로 실행합니다. API 키, 프록시, Kangentic 계정이 필요 없습니다.
- **모든 프로젝트를 한곳에서.** 각 리포지토리마다 자체 보드가 있으며, 에이전트 모니터에서 모든 보드에 걸쳐 실행 중인 에이전트를 확인할 수 있습니다.
- **보드에서 검토.** 변경 내용 패널에는 각 작업의 diff와 커밋 기록이 표시됩니다. GitHub 또는 Azure DevOps에 연결된 끌어오기 요청은 상태와 병합 준비 여부를 보여 줍니다.
- **무료 오픈 소스.** AGPL-3.0 라이선스이며, 모든 기능이 포함되어 있고 유료 등급이 없습니다.

### 워크플로 구성

- **열.** 보드가 실제 배포 방식과 맞을 때까지 열의 이름을 바꾸고, 열을 추가하고, 연결을 다시 구성하세요. 각 열에는 고유한 에이전트, 모델, 노력 수준, 권한 모드가 있습니다. 설정은 `kangentic.json`에 담겨 리포지토리와 함께 커밋되므로 팀원도 같은 보드를 사용하며, 작업과 에이전트 세션은 각자의 컴퓨터에 남습니다.
- **자동화.** 작업이 열에 들어올 때, 에이전트가 턴을 마칠 때, 작업이 열을 떠날 때 열은 에이전트에 메시지나 슬래시 명령을 보내거나, 스크립트를 실행하거나, 웹후크를 호출하거나, 알림을 보내거나, 작업을 다음 열로 이동할 수 있습니다. 일반 언어로 작성하고 에이전트가 확인하는 조건에 따라 단계 실행 여부가 결정됩니다.
- **워크플로.** 워크플로 에이전트에 개요를 전달하고, 에이전트가 계획한 연결된 작업을 검토한 다음 시작을 누르세요. 각 작업은 선행 작업이 완료에 도달하면 시작되며, 하나의 워크플로가 여러 프로젝트에 걸칠 수 있습니다.
- **보드를 다루는 에이전트.** Kangentic의 MCP 서버를 사용하면 실행 중인 에이전트가 작업을 만들고, 자신의 카드를 이동하고, 이전 대화를 검색하고, 다른 작업의 에이전트에 메시지를 보낼 수 있으므로 프롬프트에 작성한 규칙으로 작업을 진행시킬 수 있습니다.

## 나에게 맞는 도구인가요?

**다음에 해당하면 잘 맞습니다.**

- 여러 코딩 에이전트를 동시에 실행하다가 어떤 에이전트가 응답을 기다리는지 놓치는 경우.
- 여러 프로젝트나 클라이언트의 작업을 오가며 모든 에이전트를 한 화면에서 보고 싶은 경우.
- 이미 비용을 내고 있는 요금제로 Claude Code, Codex 및 다른 CLI를 함께 사용하고 싶은 경우.
- 여러 단계로 된 워크플로가 있고 프로젝트별로 에이전트와 자동화를 사용자 지정하고 싶은 경우.
- 자리를 비웠을 때 휴대폰으로 에이전트에 답하고 싶은 경우.

**다음에 해당하면 맞지 않을 수 있습니다.**

- 한 번에 하나의 작업을 처음부터 끝까지 처리하는 것을 선호하는 경우.
- 하나의 프로젝트에서만 작업하고 전환하는 일이 드문 경우.
- 에이전트 CLI를 사용하지 않거나 Cursor, Claude Desktop 같은 앱을 선호하는 경우.
- 개발 방식에 워크플로나 자동화가 필요 없는 경우.
- 에이전트를 내 컴퓨터가 아닌 클라우드에서 실행하고 싶은 경우.

유용해 보인다면 ⭐를 눌러 다른 개발자가 Kangentic을 찾을 수 있도록 도와주세요.

## 설치

```bash
npx kangentic
```

이 명령은 [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest)에서 사용 중인 플랫폼용 최신 릴리스를 다운로드하여 설치하고 실행합니다. 그 이후에는 앱이 자동으로 업데이트됩니다. 설치 관리자를 직접 실행하려면 릴리스 페이지에서 받을 수도 있습니다.

**요구 사항**

- Windows x64, Apple Silicon 또는 Intel 기반 macOS 13 이상, 또는 Linux x64 또는 arm64(`.deb` 또는 `.rpm`). Intel Mac에서는 지식 그래프를 사용할 수 없습니다.
- `npx`용 Node.js 20 이상, Git 2.26 이상.
- 설치 및 로그인이 완료된 [지원되는 에이전트 CLI](#supported-agents) 하나 이상.

WSL 사용자는 Windows 버전을 설치하고 터미널 셸로 WSL 배포판을 선택할 수 있습니다. 에이전트는 각 CLI의 Windows 설치본을 실행하므로 배포판 안에만 설치된 CLI는 찾을 수 없습니다. 플랫폼별 내용은 [설치 가이드](https://www.kangentic.com/guide/installation/)에서 다룹니다.

## 작동 방식

1. **보드 구성.** 기본 열을 그대로 두거나 형태를 바꾸고, 각 열에서 실행할 에이전트와 권한 모드를 선택합니다.
2. **작업 만들기.** 제목과 프롬프트를 입력하거나 GitHub Issues, GitHub Projects, Azure DevOps 또는 Asana에서 작업을 가져옵니다.
3. **끌어서 실행.** Kangentic이 작업 트리를 만들고, 열의 권한 모드를 적용하고, 에이전트를 시작합니다.
4. **코딩 지켜보기.** 라이브 터미널에서 에이전트의 작업을 따라가고, 질문하면 답하고, 완료되면 카드를 다음 열로 끌어 놓습니다.

<a name="supported-agents"></a>
## 지원되는 에이전트

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-cli), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli), 그리고 로컬 모델을 단일 턴 채팅으로 사용하는 [Ollama](https://ollama.com).

다시 시작한 후 세션 재개, MCP 보드 도구, 다음 에이전트로 기록 전달 기능은 CLI에 따라 다릅니다. [에이전트별 지원 기능](https://www.kangentic.com/features/agent-orchestration/#supported-agents)을 참조하세요.

## 언어

Kangentic 인터페이스는 이 페이지 상단에 나열된 각 언어로 제공됩니다. Settings > Language에서 언어를 변경하면 Kangentic이 해당 언어로 다시 시작됩니다. 번역은 기계 번역이며 누구나 검토할 수 있습니다. 번역을 수정하는 방법은 [번역](docs/contributing/translations.md)에서 설명합니다.

## 데이터 및 개인 정보

보드, 작업, 대화 기록은 로컬 SQLite 데이터베이스에 저장됩니다. 에이전트 CLI는 터미널에서 실행할 때와 마찬가지로 사용자 계정으로 각 공급자에 연결합니다.

릴리스 빌드는 기본적으로 익명 사용 이벤트(Aptabase)와 오류 보고서(Sentry)를 보냅니다. 사용 이벤트에는 작업 텍스트, 프롬프트, 코드가 절대 포함되지 않습니다. 둘 다 끄려면 `KANGENTIC_TELEMETRY=0`을, 오류 보고서만 끄려면 `KANGENTIC_ERROR_REPORTING=0`을 설정하세요. 앱 안에는 이를 끄는 스위치가 없습니다. 앱은 업데이트와 공지 사항을 확인하기 위해 GitHub에도 접속합니다. 전체 목록은 [개인정보 처리방침](https://www.kangentic.com/privacy/)을 참조하세요.

## 설명서

[빠른 시작](https://www.kangentic.com/getting-started/)부터 읽은 다음 열, 자동화, 워크플로, MCP 서버, 구성에 대한 [설명서](https://www.kangentic.com/overview/)를 참조하세요.

## 개발

소스에서 빌드하려면 Node.js 22.14 이상 또는 24 이상이 필요합니다.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## 기여

프로젝트 구조, 테스트, 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요. 기여자는 첫 번째 끌어오기 요청이 병합되기 전에 [CLA](CLA.md)에 서명해야 합니다.

## 지원

- 질문 및 기능 요청: [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions)
- 버그 보고: [GitHub Issues](https://github.com/Kangentic/kangentic/issues)
- 공개적으로 게시하고 싶지 않은 경우: [support@kangentic.com](mailto:support@kangentic.com)

보안 문제를 보고하려면 [SECURITY.md](SECURITY.md)를 참조하세요.

## 라이선스

[AGPL-3.0](LICENSE). 상용 라이선스가 필요하면 licensing@kangentic.com으로 이메일을 보내세요.
