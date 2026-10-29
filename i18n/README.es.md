<!-- readme-translation source-blob=eecf91791ca282e05478d5f2732f583958463f0e -->
> Esta es una traducción automática de [README.md](../README.md) en `eecf917`. La versión en inglés es la canónica.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Logotipo de Kangentic" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Arrastra una tarjeta. Un agente se pone en marcha.</strong><br />
  Un entorno de desarrollo agéntico para agentes de programación con IA.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Última versión" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="Versión de npm" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="Licencia AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="El tablero de Kangentic con tareas en To Do, Planning, Executing y Code Review. Cada tarjeta en ejecución muestra el último mensaje de su agente, y el terminal del agente seleccionado está abierto debajo del tablero. Abre la demo en vivo." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Demo en vivo</a> |
  <a href="https://www.kangentic.com/getting-started/">Inicio rápido</a> |
  <a href="https://www.kangentic.com/overview/">Documentación</a>
</p>

<!-- language-switcher -->
<p align="center">
  <a href="../README.md">English</a> |
  <a href="README.zh-CN.md">中文(简体)</a> |
  <a href="README.zh-TW.md">中文(繁體)</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.it.md">Italiano</a> |
  Español |
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

## Qué hace

Un agente de programación puede llevar una tarea por sí solo, y los árboles de trabajo de git permiten ejecutar varios a la vez. El límite pasas a ser tú: qué agente espera una respuesta, cuál ha terminado y adónde fue cada rama. Kangentic reúne todas las sesiones en un tablero y marca las que te necesitan.

### Ejecuta tus agentes desde un tablero

- **Un tablero, todos los agentes.** Cada tarjeta muestra su modelo, cuánto de la ventana de contexto se usa y lo último que dijo el agente, con una marca en las que te necesitan.
- **Kangentic Mobile.** Vincula tu teléfono una vez y luego revisa los agentes, responde a la pregunta en la que se detuvo uno y revisa su diff lejos de tu escritorio. La conexión está cifrada de extremo a extremo, a través del relay de Kangentic o de uno que alojes tú. Descárgalo en la [App Store](https://apps.apple.com/app/kangentic/id6794952339) o en [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile).
- **Quince CLI de agentes.** Planifica con Claude Code y construye con Codex, o usa una sola CLI en todas partes. Kangentic ejecuta las CLI que ya tienes con las credenciales que ya configuraste. Sin clave de API, sin proxy, sin cuenta de Kangentic.
- **Todos los proyectos en un solo lugar.** Cada repositorio tiene su propio tablero, y el Agent Monitor muestra los agentes en ejecución en todos ellos.
- **Revisa en el tablero.** El panel Changes muestra el diff y el historial de commits de cada tarea. Un pull request vinculado en GitHub o Azure DevOps muestra su estado y si está listo para fusionarse.
- **Gratuito y de código abierto.** AGPL-3.0, con todas las funciones incluidas y sin plan de pago.

### Da forma al flujo de trabajo

- **Columnas.** Cambia el nombre, añade y reconecta columnas hasta que el tablero se ajuste a tu forma de entregar. Cada columna tiene su propio agente, modelo, nivel de esfuerzo y modo de permisos. La configuración se confirma con el repositorio en `kangentic.json`, así que tus compañeros obtienen el mismo tablero, mientras que las tareas y las sesiones de agente se quedan en la máquina de cada persona.
- **Automatizaciones.** Cuando una tarea entra en una columna, cuando su agente termina un turno o cuando la tarea sale, una columna puede enviar al agente un mensaje o un comando de barra, ejecutar un script, llamar a un webhook, notificarte o mover la tarea a la siguiente columna. Una condición en lenguaje natural, comprobada por un agente, decide si se ejecuta un paso.
- **Flujos de trabajo.** Dale al agente de flujos de trabajo un resumen, revisa las tareas vinculadas que planifica y pulsa Start. Cada tarea empieza cuando las tareas a las que espera llegan a Done, y un flujo de trabajo puede abarcar varios proyectos.
- **Agentes que trabajan en el tablero.** El servidor MCP de Kangentic permite que un agente en ejecución cree tareas, mueva su propia tarjeta, busque conversaciones anteriores y envíe mensajes al agente de otra tarea, de modo que una regla escrita en un prompt puede hacer avanzar el trabajo.

## ¿Es para ti?

**Encaja bien si tú:**

- ejecutas varios agentes de programación a la vez y pierdes de vista cuál te está esperando.
- haces malabares con tareas de varios proyectos o clientes y quieres todos los agentes en una sola vista.
- quieres combinar Claude Code, Codex y otras CLI con los planes que ya pagas.
- tienes un flujo de trabajo de varios pasos y quieres personalizar sus agentes y automatizaciones por proyecto.
- quieres responder a tus agentes desde el teléfono cuando te alejas.

**Probablemente no es para ti si tú:**

- prefieres trabajar en una tarea a la vez, de principio a fin.
- trabajas en un solo proyecto y rara vez cambias.
- no usas CLI de agentes, o prefieres aplicaciones como Cursor o Claude Desktop.
- no necesitas flujos de trabajo ni automatizaciones en tu forma de desarrollar.
- quieres que tus agentes se ejecuten en la nube en lugar de en tu máquina.

Si te parece útil, una ⭐ ayuda a otros desarrolladores a encontrar Kangentic.

## Instalación

```bash
npx kangentic
```

Esto descarga la última versión para tu plataforma desde [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest), la instala y la abre. Después, la aplicación se actualiza sola. Los instaladores también están en la página de versiones si prefieres ejecutar uno tú mismo.

**Requisitos**

- Windows x64, macOS 13 o posterior en Apple Silicon o Intel, o Linux x64 o arm64 (`.deb` o `.rpm`). El Knowledge Graph no está disponible en Mac con Intel.
- Node.js 20 o posterior para `npx`, y Git 2.26 o posterior.
- Al menos una [CLI de agente compatible](#supported-agents), instalada y con la sesión iniciada.

Los usuarios de WSL instalan la versión de Windows y pueden elegir una distribución de WSL como shell del terminal. Los agentes ejecutan la instalación de Windows de cada CLI, así que no se encuentra una CLI instalada solo dentro de la distribución. La [guía de instalación](https://www.kangentic.com/guide/installation/) cubre cada plataforma.

## Cómo funciona

1. **Configura tu tablero.** Conserva las columnas predeterminadas o cámbialas, y elige el agente y el modo de permisos que ejecuta cada una.
2. **Crea una tarea.** Dale un título y un prompt, o impórtala desde GitHub Issues, GitHub Projects, Azure DevOps o Asana.
3. **Arrastra para ejecutar.** Kangentic crea el árbol de trabajo, aplica el modo de permisos de la columna e inicia el agente.
4. **Míralo programar.** Sigue al agente en su terminal en vivo, responde cuando pregunte y arrastra la tarjeta cuando termine.

<a name="supported-agents"></a>
## Agentes compatibles

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-cli), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli) y [Ollama](https://ollama.com) para modelos locales como chat de un solo turno.

La reanudación tras un reinicio, las herramientas de tablero de MCP y el traspaso del historial al siguiente agente dependen de la CLI. Consulta [qué admite cada agente](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Idiomas

La interfaz de Kangentic está disponible en cada idioma que aparece al principio de esta página. Cámbialo en Settings > Language y Kangentic se reinicia en ese idioma. Las traducciones son automáticas y están abiertas a revisión, y [Traducciones](../docs/contributing/translations.md) explica cómo corregir una.

## Datos y privacidad

Tus tableros, tareas y transcripciones se quedan en una base de datos SQLite local. Las CLI de agentes se conectan a sus propios proveedores con tus propias cuentas, como lo harían en tu terminal.

Las compilaciones de versión envían de forma predeterminada eventos de uso anónimos (Aptabase) e informes de errores (Sentry). Los eventos de uso nunca contienen texto de tareas, prompts ni código. Establece `KANGENTIC_TELEMETRY=0` para desactivar ambos, o `KANGENTIC_ERROR_REPORTING=0` para desactivar solo los informes de errores. No hay ningún interruptor en la aplicación. La aplicación también consulta GitHub para buscar actualizaciones y anuncios. Consulta la [política de privacidad](https://www.kangentic.com/privacy/) para ver la lista completa.

## Documentación

Empieza con el [inicio rápido](https://www.kangentic.com/getting-started/) y después consulta la [documentación](https://www.kangentic.com/overview/) sobre columnas, automatizaciones, flujos de trabajo, el servidor MCP y la configuración.

## Desarrollo

Compilar desde el código fuente requiere Node.js 22.14 o posterior, o 24 o posterior.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Contribuir

Consulta [CONTRIBUTING.md](../CONTRIBUTING.md) para conocer la estructura del proyecto, las pruebas y las convenciones. Los colaboradores firman un [CLA](../CLA.md) antes de que se fusione su primer pull request.

## Soporte

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) para preguntas y solicitudes de funciones
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) para informes de errores
- [support@kangentic.com](mailto:support@kangentic.com) si prefieres no publicar de forma pública

Para informar de un problema de seguridad, consulta [SECURITY.md](../SECURITY.md).

## Licencia

[AGPL-3.0](../LICENSE). Para obtener una licencia comercial, escribe a licensing@kangentic.com.
