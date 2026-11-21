<!-- readme-translation source-blob=addf4d308ea2879895590819a96e54c47a323ac9 -->
> Esta é uma tradução automática de [README.md](../README.md) na revisão `addf4d3`. A versão em inglês é a oficial.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Logo do Kangentic" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Arraste um cartão. Um agente começa.</strong><br />
  Um ambiente de desenvolvimento agêntico para agentes de programação com IA.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Versão mais recente" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="Versão no npm" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="Licença AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="O quadro do Kangentic com tarefas em A Fazer, Planejamento, Execução e Revisão de Código. Cada cartão em execução mostra a última mensagem do seu agente, e o terminal do agente selecionado está aberto abaixo do quadro. Abre a demonstração ao vivo." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Demonstração ao vivo</a> |
  <a href="https://www.kangentic.com/getting-started/">Início rápido</a> |
  <a href="https://www.kangentic.com/overview/">Documentação</a>
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
  <a href="README.ru.md">Русский</a> |
  Português (Brasil) |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.cs.md">Čeština</a> |
  <a href="README.hu.md">Magyar</a>
</p>
<!-- /language-switcher -->

## O que ele faz

Um agente de programação consegue levar uma tarefa sozinho, e as árvores de trabalho do git permitem que vários rodem ao mesmo tempo. O limite passa a ser você: qual agente está esperando um prompt, qual terminou e para onde foi cada branch. O Kangentic coloca todas as sessões em um único quadro e marca as que precisam de você.

### Execute seus agentes a partir de um único quadro

- **Um quadro, todos os agentes.** Cada cartão mostra o modelo, quanto da janela de contexto está em uso e o que o agente disse por último, com uma marca nos que precisam de você.
- **Kangentic Mobile.** Pareie seu celular uma vez e, depois, acompanhe os agentes, responda à pergunta em que um deles parou e revise o diff dele longe da sua mesa. A conexão tem criptografia de ponta a ponta, pelo relay do Kangentic ou por um que você mesmo hospede. Baixe na [App Store](https://apps.apple.com/app/kangentic/id6794952339) ou no [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile).
- **Quinze CLIs de agentes.** Planeje com o Claude Code e construa com o Codex, ou use uma única CLI para tudo. O Kangentic executa as CLIs que você já tem com as credenciais que você já configurou. Sem chave de API, sem proxy, sem conta no Kangentic.
- **Agentes em um host remoto.** Coloque um projeto em uma máquina Linux que você acessa por SSH, e o repositório, os agentes, os builds e os testes dele rodam lá. O quadro fica no seu computador, e os agentes continuam trabalhando mesmo se a conexão cair ou depois que você fechar o app. Consulte [Hosts remotos SSH](https://www.kangentic.com/features/ssh-remote-hosts/) para ver a configuração e as limitações.
- **Todos os projetos em um só lugar.** Cada repositório ganha o próprio quadro, e o Monitor de Agentes mostra os agentes em execução em todos eles.
- **Revise no quadro.** O painel Alterações mostra o diff e o histórico de commits de cada tarefa. Um pull request vinculado no GitHub ou no Azure DevOps mostra o estado dele e se está pronto para o merge.
- **Gratuito e de código aberto.** AGPL-3.0, com todos os recursos incluídos e sem plano pago.

### Molde o fluxo de trabalho

- **Colunas.** Renomeie, adicione e reconecte colunas até o quadro refletir a forma como você entrega. Cada coluna tem o próprio agente, modelo, nível de esforço e modo de permissão. A configuração vai em commit com o repositório em `kangentic.json`, então os colegas de equipe recebem o mesmo quadro, enquanto as tarefas e as sessões de agentes ficam na máquina de cada pessoa.
- **Automações.** Quando uma tarefa entra em uma coluna, quando o agente dela termina um turno ou quando a tarefa sai, a coluna pode enviar ao agente uma mensagem ou um comando de barra, executar um script, chamar um webhook, notificar você ou mover a tarefa para a próxima coluna. Uma condição escrita em linguagem simples, verificada por um agente, decide se uma etapa é executada.
- **Fluxos de trabalho.** Passe um briefing ao agente de fluxo de trabalho, revise as tarefas vinculadas que ele planejar e clique em Iniciar. Cada tarefa começa quando as tarefas das quais ela depende chegam a Concluído, e um único fluxo de trabalho pode abranger vários projetos.
- **Agentes que operam o quadro.** O servidor MCP do Kangentic permite que um agente em execução crie tarefas, mova o próprio cartão, pesquise conversas anteriores e envie mensagens ao agente de outra tarefa, então uma regra escrita em um prompt pode fazer o trabalho avançar.

## É para você?

**Combina com você se você:**

- executa vários agentes de programação ao mesmo tempo e perde a noção de qual deles está esperando por você.
- alterna entre tarefas de vários projetos ou clientes e quer ver todos os agentes em um só lugar.
- quer combinar Claude Code, Codex e outras CLIs nos planos que você já paga.
- tem um fluxo de trabalho com várias etapas e quer personalizar os agentes e as automações dele por projeto.
- quer responder aos seus agentes pelo celular quando se afasta do computador.

**Provavelmente não é para você se você:**

- prefere trabalhar em uma tarefa por vez, do começo ao fim.
- trabalha em um único projeto e raramente troca.
- não usa CLIs de agentes ou prefere apps como Cursor ou Claude Desktop.
- não usa fluxos de trabalho nem automações na sua forma de desenvolver.
- quer um serviço hospedado que execute seus agentes, sem precisar instalar um app.

Se isso parece útil, uma ⭐ ajuda outros desenvolvedores a encontrar o Kangentic.

## Instalação

```bash
npx kangentic
```

Esse comando baixa a versão mais recente para a sua plataforma do [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest), instala e abre o app. Depois disso, o app se atualiza sozinho. Os instaladores também estão na página de releases, se você preferir executar um deles por conta própria.

**Requisitos**

- Windows x64, macOS 13 ou posterior em Apple Silicon ou Intel, ou Linux x64 ou arm64 (`.deb` ou `.rpm`).
- Node.js 20 ou posterior para o `npx`, e Git 2.26 ou posterior.
- Pelo menos uma [CLI de agente compatível](#supported-agents), instalada e com login feito.

Usuários de WSL instalam a versão para Windows e podem escolher uma distro do WSL como shell do terminal. Uma CLI de agente instalada dentro de uma distro roda lá quando você define o caminho dela para a cópia que está na distro. Mantenha o projeto em si em uma unidade do Windows. O [guia de instalação](https://www.kangentic.com/guide/installation/) explica cada plataforma.

## Como funciona

1. **Configure seu quadro.** Mantenha as colunas padrão ou reorganize-as, e escolha o agente e o modo de permissão de cada uma.
2. **Crie uma tarefa.** Dê a ela um título e um prompt, ou importe uma do GitHub Issues, GitHub Projects, Azure DevOps, Asana, Jira, Linear, Trello, GitLab ou de um vault do Obsidian.
3. **Arraste para executar.** O Kangentic cria a árvore de trabalho, aplica o modo de permissão da coluna e inicia o agente.
4. **Veja-o programar.** Acompanhe o agente no terminal ao vivo, responda quando ele perguntar e arraste o cartão adiante quando ele terminar.

<a name="supported-agents"></a>
## Agentes compatíveis

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli) e [Ollama](https://ollama.com) para modelos locais como chat de turno único.

A retomada após uma reinicialização, as ferramentas de quadro do MCP e a passagem do histórico para o próximo agente dependem da CLI. Veja [o que cada agente oferece](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Idiomas

A interface do Kangentic está disponível em cada um dos idiomas listados no topo desta página. Altere o idioma em Settings > Language, e o Kangentic reinicia nele. As traduções são feitas por máquina e estão abertas a revisão, e [Traduções](../docs/contributing/translations.md) explica como corrigir uma delas.

## Dados e privacidade

Seus quadros, tarefas e transcrições ficam em um banco de dados SQLite local. As CLIs de agentes acessam os próprios provedores com as suas contas, como fariam no seu terminal.

Os builds de release enviam eventos de uso anônimos (Aptabase) e relatórios de erro (Sentry) por padrão. Os eventos de uso nunca contêm texto de tarefas, prompts ou código. Defina `KANGENTIC_TELEMETRY=0` para desativar os dois, ou `KANGENTIC_ERROR_REPORTING=0` para desativar apenas os relatórios de erro. Não há uma opção dentro do app. O app também consulta o GitHub em busca de atualizações e anúncios. Consulte a [política de privacidade](https://www.kangentic.com/privacy/) para ver a lista completa.

## Documentação

Comece pelo [início rápido](https://www.kangentic.com/getting-started/) e depois veja a [documentação](https://www.kangentic.com/overview/) sobre colunas, automações, fluxos de trabalho, o servidor MCP e configuração.

## Desenvolvimento

Compilar a partir do código-fonte requer Node.js 22.14 ou posterior, ou 24 ou posterior.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Como contribuir

Consulte o [CONTRIBUTING.md](../CONTRIBUTING.md) para ver a estrutura do projeto, os testes e as convenções. Os colaboradores assinam um [CLA](../CLA.md) antes que o primeiro pull request deles seja mesclado.

## Suporte

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) para perguntas e pedidos de recursos
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) para relatos de bugs
- [support@kangentic.com](mailto:support@kangentic.com) se você preferir não publicar abertamente

Para relatar um problema de segurança, consulte o [SECURITY.md](../SECURITY.md).

## Licença

[AGPL-3.0](../LICENSE). Para obter uma licença comercial, envie um e-mail para licensing@kangentic.com.
