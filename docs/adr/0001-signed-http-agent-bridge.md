# ADR 0001: Telegram yerine imzalı HTTP agent bridge

- **Durum:** Kabul edildi
- **Tarih:** 2026-07-18
- **Karar sahipleri:** Cihan Taylan, Alpha

## Bağlam

Telegram Bot API, bir botun yazdığı mesajı gruptaki diğer botlara teslim etmez. Privacy Mode, admin rolü veya mention bu davranışı değiştirmez. Bu nedenle `@AlphaAgentBot` ve `@BetaAgentBot` Telegram grubunu transport olarak kullanarak güvenilir biçimde haberleşemez.

Hermes tarafında inbound webhook, dynamic subscription, session metadata ve plugin hook altyapısı var. İhtiyaç; bu parçaları botlar arası doğrudan, güvenli ve gözlenebilir bir event hattında birleştirmektir.

## Karar

Ajanlar merkezi bir Bridge API üzerinden imzalı HTTP event alışverişi yapacak.

- Outbound Hermes plugin, yalnızca açık allow-list policy'sine uyan final model çıktısını encrypted SQLite outbox'a yazar.
- Plugin worker event'i raw-body HMAC-SHA256 V2 ile Bridge API'ye gönderir.
- Bridge API kaynağı doğrular, payload'ı şifreli PostgreSQL kaydına alır ve `(source_agent, event_id)` ile dedupe eder.
- Bridge worker hedef ajan webhook'una aynı logical delivery ve request ID ile retry yapar.
- `source_agent`, `target_agent`, `event_id`, `causation_id` ve `hop` alanları route/loop policy'sini deterministik yapar.
- `delivery_semantics=generated`; model üretimi, Telegram teslim başarısından bağımsızdır.
- İlk canlı aşama `observe`-only staging canary'dir; `request/response` daha sonra açılır.

## Reddedilen seçenekler

### Telegram Privacy Mode veya admin rolü

Bot yazarlı update'ler diğer botlara verilmediği için problemi çözmez.

### İnsan relay'i

Demo için çalışabilir ama güvenilir, otomatik ve izlenebilir değildir.

### MTProto userbot

Teknik olarak bot mesajlarını okuyabilir; ancak ayrı kimlik/oturum güvenliği, ToS ve operasyon yükü getirir. Bu kararın scope'u dışındadır.

### Prompt tabanlı loop prevention

Model davranışına güvenmek deterministik değildir. Loop kontrolü transport ve persistence katmanında uygulanmalıdır.

## Sonuçlar

### Olumlu

- Telegram kısıtından bağımsız iki yönlü iletişim.
- Replay, dedupe, retry ve DLQ gözlenebilirliği.
- Secret rotation ve least-privilege route policy.
- Retry sırasında ikinci agent turn'ü oluşmaması.

### Maliyet

- Bridge API, PostgreSQL ve iki instance'ta plugin işletme yükü.
- İki tarafın secret/config senkronizasyonu.
- Canlı doğrulama için her iki Hermes instance'ına erişim gereksinimi.

## Kabul kapısı

Production açılımı için local iki yönlü E2E, replay/dedupe/loop testleri, staging observe canary, rollback ve secret rotation runbook'u geçmelidir.
