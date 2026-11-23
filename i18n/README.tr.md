<!-- readme-translation source-blob=ded000bed8af5253da7d62f8cafb9a8369f243a4 -->
> Bu belge, [README.md](../README.md) dosyasının `ded000b` revizyonundaki halinin makine çevirisidir. Esas sürüm İngilizce olandır.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic logosu" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Bir kartı sürükleyin. Bir ajan başlasın.</strong><br />
  Yapay zeka kodlama ajanları için ajan tabanlı bir geliştirme ortamı.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Son sürüm" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm sürümü" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 lisansı" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://kangentic.github.io/kangentic/readme/board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://kangentic.github.io/kangentic/readme/board-light.png" />
      <img src="https://kangentic.github.io/kangentic/readme/board-dark.png" alt="Yapılacaklar, Planlama, Yürütülüyor ve Kod İncelemesi sütunlarında görevler bulunan Kangentic panosu. Çalışan her kart, ajanının son mesajını gösterir ve seçili ajanın terminali panonun altında açıktır. Canlı demoyu açar." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Canlı demo</a> |
  <a href="https://www.kangentic.com/getting-started/">Hızlı başlangıç</a> |
  <a href="https://www.kangentic.com/overview/">Belgeler</a>
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
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  Türkçe |
  <a href="README.pl.md">Polski</a> |
  <a href="README.cs.md">Čeština</a> |
  <a href="README.hu.md">Magyar</a>
</p>
<!-- /language-switcher -->

## Ne yapar

Bir kodlama ajanı bir görevi tek başına yürütebilir ve git çalışma ağaçları birkaç ajanın aynı anda çalışmasını sağlar. Bu durumda sınır siz olursunuz: hangi ajan bir istemde bekliyor, hangisi bitirdi ve her dal nereye gitti. Kangentic her oturumu tek bir panoya yerleştirir ve size ihtiyaç duyanları işaretler.

### Ajanlarınızı tek bir panodan çalıştırın

- **Tek pano, tüm ajanlar.** Her kart; modelini, bağlam penceresinin ne kadarının kullanıldığını ve ajanın en son ne söylediğini gösterir. Size ihtiyaç duyan kartlarda bir işaret bulunur.
- **Kangentic Mobile.** Telefonunuzu bir kez eşleştirin; ardından masanızdan uzaktayken ajanları kontrol edin, bir ajanın takıldığı soruyu yanıtlayın ve diff'ini inceleyin. Bağlantı, Kangentic'in aktarma sunucusu veya sizin barındırdığınız bir aktarma sunucusu üzerinden uçtan uca şifrelenir. [App Store](https://apps.apple.com/app/kangentic/id6794952339) veya [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) üzerinden edinin.
- **On beş ajan CLI'ı.** Claude Code ile planlayıp Codex ile geliştirin ya da her yerde tek bir CLI kullanın. Kangentic, zaten sahip olduğunuz CLI'ları zaten yapılandırdığınız kimlik bilgileriyle çalıştırır. API anahtarı, proxy veya Kangentic hesabı gerekmez.
- **Uzak sunucudaki ajanlar.** Bir projeyi SSH ile eriştiğiniz bir Linux makinesine koyun; deposu, ajanları, derlemeleri ve testleri orada çalışır. Pano bilgisayarınızda kalır ve ajanlar bağlantı koptuğunda ya da uygulamadan çıktığınızda da çalışmaya devam eder. Kurulum ve sınırlamalar için [SSH uzak sunucuları](https://www.kangentic.com/features/ssh-remote-hosts/) sayfasına bakın.
- **Tüm projeler tek yerde.** Her deponun kendi panosu olur ve Ajan İzleyicisi tüm projelerde çalışan ajanları gösterir.
- **Panoda inceleme.** Değişiklikler paneli her görevin diff'ini ve commit geçmişini gösterir. GitHub veya Azure DevOps üzerindeki bağlı bir pull request, durumunu ve birleştirmeye hazır olup olmadığını gösterir.
- **Ücretsiz ve açık kaynak.** AGPL-3.0 lisanslıdır; tüm özellikler dahildir ve ücretli katman yoktur.

### İş akışını şekillendirin

- **Sütunlar.** Pano, işi nasıl teslim ettiğinize uyana kadar sütunları yeniden adlandırın, ekleyin ve yeniden bağlayın. Her sütunun kendi ajanı, modeli, efor düzeyi ve izin modu vardır. Yapılandırma `kangentic.json` içinde depoyla birlikte commit edilir; böylece ekip arkadaşlarınız aynı panoyu alırken görevler ve ajan oturumları herkesin kendi makinesinde kalır.
- **Otomasyonlar.** Bir görev bir sütuna girdiğinde, ajanı bir turu bitirdiğinde veya görev sütundan ayrıldığında, sütun ajana bir mesaj ya da eğik çizgi komutu gönderebilir, bir betik çalıştırabilir, bir webhook çağırabilir, size bildirim gönderebilir veya görevi sonraki sütuna taşıyabilir. Sade sözcüklerle yazılan ve bir ajan tarafından denetlenen bir koşul, bir adımın çalışıp çalışmayacağına karar verir.
- **İş akışları.** İş akışı ajanına bir özet verin, planladığı bağlantılı görevleri inceleyin ve Başlat'a basın. Her görev, beklediği görevler Tamamlandı'ya ulaştığında başlar ve tek bir iş akışı birden fazla projeyi kapsayabilir.
- **Panoyu kullanan ajanlar.** Kangentic'in MCP sunucusu, çalışan bir ajanın görev oluşturmasını, kendi kartını taşımasını, geçmiş konuşmalarda arama yapmasını ve başka bir görevin ajanına mesaj göndermesini sağlar; böylece bir istemde yazılan bir kural işi ilerletebilir.

## Size uygun mu?

**Şu durumlarda iyi bir seçimdir:**

- aynı anda birkaç kodlama ajanı çalıştırıyor ve hangisinin sizi beklediğini takip edemiyorsanız.
- birkaç proje veya müşteri arasında görevlerle uğraşıyor ve tüm ajanları tek bir görünümde görmek istiyorsanız.
- Claude Code, Codex ve diğer CLI'ları zaten ödediğiniz planlarla birlikte kullanmak istiyorsanız.
- çok adımlı bir iş akışınız varsa ve bu akışın ajanlarını ve otomasyonlarını proje bazında özelleştirmek istiyorsanız.
- uzaklaştığınızda ajanlarınıza telefonunuzdan yanıt vermek istiyorsanız.

**Şu durumlarda muhtemelen size göre değildir:**

- bir seferde tek bir görev üzerinde, baştan sona çalışmayı tercih ediyorsanız.
- tek bir projede çalışıyor ve nadiren geçiş yapıyorsanız.
- ajan CLI'ları kullanmıyorsanız veya Cursor ya da Claude Desktop gibi uygulamaları tercih ediyorsanız.
- geliştirme sürecinizde iş akışlarına veya otomasyonlara ihtiyacınız yoksa.
- ajanlarınızı, uygulama kurmanıza gerek kalmadan barındırılan bir hizmetin çalıştırmasını istiyorsanız.

Bu size yararlı görünüyorsa, bir ⭐ diğer geliştiricilerin Kangentic'i bulmasına yardımcı olur.

## Kurulum

```bash
npx kangentic
```

Bu komut, platformunuz için en son sürümü [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) üzerinden indirir, kurar ve açar. Uygulama bundan sonra kendini günceller. Yükleyiciyi kendiniz çalıştırmayı tercih ederseniz yükleyiciler sürümler sayfasında da bulunur.

**Gereksinimler**

- Windows x64, Apple Silicon veya Intel üzerinde macOS 13 ya da sonrası veya Linux x64 ya da arm64 (`.deb` veya `.rpm`).
- `npx` için Node.js 20 veya sonrası ve Git 2.26 veya sonrası.
- Kurulu ve oturum açılmış en az bir [desteklenen ajan CLI'ı](#supported-agents).

WSL kullanıcıları Windows sürümünü kurar ve terminal kabuğu olarak bir WSL dağıtımı seçebilir. Bir dağıtımın içine kurulmuş ajan CLI'ı, yolunu dağıtımdaki kopyaya ayarladığınızda orada çalışır. Projenin kendisini bir Windows sürücüsünde tutun. [Kurulum kılavuzu](https://www.kangentic.com/guide/installation/) her platformu ayrı ayrı ele alır.

## Nasıl çalışır

1. **Panonuzu yapılandırın.** Varsayılan sütunları koruyun veya yeniden şekillendirin ve her sütunun çalıştıracağı ajanı ve izin modunu seçin.
2. **Bir görev oluşturun.** Göreve bir başlık ve bir istem verin ya da GitHub Issues, GitHub Projects, Azure DevOps, Asana, Jira, Linear, Trello, GitLab veya bir Obsidian kasasından içe aktarın.
3. **Çalıştırmak için sürükleyin.** Kangentic çalışma ağacını oluşturur, sütunun izin modunu uygular ve ajanı başlatır.
4. **Kod yazışını izleyin.** Ajanı canlı terminalinde takip edin, bir şey sorduğunda yanıtlayın ve iş bittiğinde kartı sonraki sütuna sürükleyin.

<a name="supported-agents"></a>
## Desteklenen ajanlar

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli) ve yerel modeller için tek turlu sohbet olarak [Ollama](https://ollama.com).

Yeniden başlatmadan sonra kaldığı yerden devam etme, MCP pano araçları ve geçmişi sonraki ajana aktarma özellikleri CLI'a bağlıdır. [Her ajanın neleri desteklediğine](https://www.kangentic.com/features/agent-orchestration/#supported-agents) bakın.

## Diller

Kangentic'in arayüzü bu sayfanın üst kısmında listelenen tüm dillerde sunulur. Dili Settings > Language altından değiştirin; Kangentic seçilen dilde yeniden başlar. Çeviriler makine tarafından yapılmıştır ve incelemeye açıktır; bir çevirinin nasıl düzeltileceği [Çeviriler](../docs/contributing/translations.md) sayfasında açıklanır.

## Veriler ve gizlilik

Panolarınız, görevleriniz ve konuşma dökümleriniz yerel bir SQLite veritabanında kalır. Ajan CLI'ları, terminalinizde olduğu gibi kendi sağlayıcılarına sizin hesaplarınızla bağlanır.

Sürüm derlemeleri varsayılan olarak anonim kullanım olayları (Aptabase) ve hata raporları (Sentry) gönderir. Kullanım olayları hiçbir zaman görev metni, istem veya kod içermez. İkisini birden kapatmak için `KANGENTIC_TELEMETRY=0`, yalnızca hata raporlarını kapatmak için `KANGENTIC_ERROR_REPORTING=0` ayarlayın. Uygulama içinde bu ayar için bir anahtar yoktur. Uygulama ayrıca güncellemeler ve duyurular için GitHub'ı denetler. Tam liste için [gizlilik politikasına](https://www.kangentic.com/privacy/) bakın.

## Belgeler

[Hızlı başlangıç](https://www.kangentic.com/getting-started/) ile başlayın, ardından sütunlar, otomasyonlar, iş akışları, MCP sunucusu ve yapılandırma için [belgelere](https://www.kangentic.com/overview/) geçin.

## Geliştirme

Kaynaktan derlemek için Node.js 22.14 veya sonrası ya da 24 veya sonrası gerekir.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Katkıda bulunma

Proje yapısı, testler ve kurallar için [CONTRIBUTING.md](../CONTRIBUTING.md) dosyasına bakın. Katkıda bulunanlar, ilk pull request'leri birleştirilmeden önce bir [CLA](../CLA.md) imzalar.

## Destek

- Sorular ve özellik istekleri için [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions)
- Hata raporları için [GitHub Issues](https://github.com/Kangentic/kangentic/issues)
- Herkese açık paylaşmak istemiyorsanız [support@kangentic.com](mailto:support@kangentic.com)

Bir güvenlik sorunu bildirmek için [SECURITY.md](../SECURITY.md) dosyasına bakın.

## Lisans

[AGPL-3.0](../LICENSE). Ticari lisans için licensing@kangentic.com adresine e-posta gönderin.
