# ADR 0002: Interactive delivery requires durable completion receipts

- **Durum:** Kabul edildi
- **Tarih:** 2026-07-18
- **Karar sahipleri:** Cihan Taylan, Alpha

## Bağlam

Bridge worker, hedef Hermes webhook'undan bir `2xx` yanıt alabiliyor. Hermes Agent `0.18.2` için `202 Accepted`, isteğin kuyruğa alındığını söyler; model turn'ünün başarıyla tamamlandığını, kalıcı sonucunun saklandığını veya retry sonrası ikinci kez çalışmayacağını kanıtlamaz.

`request` ve `response` modlarında yalnız transport kabulünü `delivered` saymak şu riskleri doğurur:

- Aynı stable request ID restart veya failover sonrasında ikinci model turn'ü başlatabilir.
- Kanal FIFO sırası, önceki turn gerçekten tamamlanmadan ilerleyebilir.
- Request'e bağlı response kaybolabilir veya iki kez üretilebilir.
- API'nin delivery state'i Hermes'in execution state'inden kopabilir.

Process-local cache veya webhook `202` yanıtı bu riskleri çözmez.

## Karar

Production ve staging interactive akışları, aşağıdaki protokol tamamlanana kadar fail-closed kalacak:

1. Hedef Hermes, stable delivery/request ID için durable bir execution ledger tutar.
2. Ledger en az `accepted`, `processing`, `completed` ve `failed` durumlarını atomik olarak yönetir.
3. Duplicate kabul, yeni model turn başlatmak yerine mevcut execution ID ve tamamlanmış sonucu döndürür.
4. Hermes, Bridge API'ye execution ID içeren imzalı completion callback/receipt gönderir.
5. Bridge delivery ancak doğrulanmış `completed` receipt sonrasında terminal `delivered` olur.
6. `failed` receipt retry sınıflandırmasını açıkça belirtir; belirsiz timeout otomatik olarak yeni turn başlatmaz.
7. Restart ve multi-instance testleri, aynı stable ID'nin en fazla bir model turn ürettiğini kanıtlar.

Bu şartlar sağlanana kadar:

- API'de `BRIDGE_REQUESTS_ENABLED=false` zorunludur.
- Plugin'de `HERMES_BRIDGE_REQUESTS_ENABLED` varsayılanı `false` kalır.
- `request` ve `response` kabulü `requests_disabled` ile reddedilir.
- Yalnız side-effect üretmeyen `observe` canary değerlendirilebilir.

## Sonuçlar

- Observe teslimatlarında `2xx`, yalnız hedef observe endpoint'inin payload'ı kabul ettiğini gösterir; LLM/Telegram side effect suppression ayrıca staging'de kanıtlanır.
- Interactive özellik takvim baskısıyla config üzerinden açılamaz; protokol, test ve security review birlikte tamamlanmalıdır.
- Bridge API'deki response causality kontrolleri defense-in-depth olarak uygulanır fakat bu ADR'deki completion guarantee'in yerine geçmez.

## Reddedilen seçenekler

### Her `2xx` yanıtını completion saymak

Transport kabulü ile agent execution completion'ı aynı değildir.

### In-memory dedupe kullanmak

Restart ve çoklu instance durumlarında veri kaybolur veya paylaşılmaz.

### Timeout sonrası kör retry yapmak

İlk turn tamamlanmış ama receipt kaybolmuşsa ikinci model turn üretebilir.
