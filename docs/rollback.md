# Rollback runbook

Amaç Bridge'i Telegram botlarının normal davranışını bozmadan güvenli biçimde durdurmak veya son bilinen iyi immutable image digest'ine dönmektir.

## Öncelik sırası

1. Yeni outbound event üretimini durdur.
2. Peer webhook delivery'lerini durdur.
3. Gerekirse Bridge runtime'ı önceki digest'e döndür.
4. DB ve outbox verisini koru; incident kanıtını silme.

## Seviye 0 — Interactive modu kapat

Bu sürüm zaten `BRIDGE_REQUESTS_ENABLED=true` ile başlamayı reddeder. Runtime config ve iki plugin profile'da değer yine de doğrulanır:

```dotenv
BRIDGE_REQUESTS_ENABLED=false
HERMES_BRIDGE_REQUESTS_ENABLED=false
```

## Seviye 1 — Plugin kill switch

Her staging Hermes profile'da:

```dotenv
HERMES_BRIDGE_ENABLED=false
HERMES_BRIDGE_REQUESTS_ENABLED=false
```

Gateway/plugin reload sonrası şunları doğrula:

- Yeni `post_llm_call` event'i outbox'a eklenmiyor.
- Mevcut Telegram cevap akışı çalışıyor.
- Outbox DB silinmiyor.

## Seviye 2 — Inbound route isolation

Alpha `peer-beta`, Beta `peer-alpha` subscription'larını disable et. Remove ancak incident analizi ve rollback testi bittikten sonra yapılır.

Doğrulama:

- Route listesinde iki subscription disabled.
- Signed test delivery agent turn başlatmıyor.
- Normal Telegram session'ları etkilenmiyor.

## Seviye 3 — Runtime image rollback

1. Son başarılı Dokploy deployment'ın immutable image reference'ını, source commit'ini ve raw compose `sha256` değerini kaydet.
2. Dokploy compose tanımını son bilinen iyi immutable raw compose snapshot'ına döndür; mutable branch'ten yeniden çekme.
3. `BRIDGE_IMAGE_DIGEST` değerini aynı snapshot ile doğrulanmış son bilinen iyi `ghcr.io/...@sha256:<digest>` değerine döndür.
4. Deploy'u yalnız Dokploy API/UI üzerinden tetikle.
5. Deployment kaydı `done` olmadan başarılı sayma.
6. `docker inspect <api-container-id> --format '{{.Config.Image}}'` çıktısının beklenen digest reference ile birebir aynı olduğunu doğrula.
7. `/healthz`, `/readyz` ve authenticated `/metrics` kontrollerini tekrar çalıştır.

Yasak:

- Mutable tag'e dönmek.
- Image digest'i rollback ederken compose tanımını güncel mutable `main` branch'ten almak.
- Doğrudan `docker build`, `docker push`, `docker service update` veya container recreate yapmak.
- DB volume/outbox silmek.

## Database rollback politikası

Migration'lar forward-only ve idempotenttir. Otomatik down migration yoktur.

- Uygulama rollback'i önceki schema-compatible image digest ile yapılır.
- Destructive SQL çalıştırılmaz.
- Schema incompatibility varsa Bridge disabled tutulur, DB snapshot alınır ve ayrı reviewed migration hazırlanır.
- Payload/outbox retention cleanup incident sırasında durdurulabilir; kanıt kaybı yaratacak purge yapılmaz.

## Queue recovery

Rollback sonrası:

- Plugin outbox pending/oldest age değerlerini kaydet.
- Bridge delivery queue ve DLQ sayısını kaydet.
- Önce tek agent yönünü enable et.
- Queue'nun duplicate peer turn üretmeden azaldığını doğrula.
- İkinci yönü ancak ilk yön temizlendikten sonra enable et.

## Başarı kriteri

- Telegram botları bridge olmadan normal yanıt veriyor.
- Yeni bridge event üretimi/delivery'si durmuş veya kontrollü tek yönlü.
- DB ve local outbox korunmuş.
- Runtime beklenen immutable digest üzerinde.
- Secret/message body loglanmamış.
- Incident notunda commit SHA, önceki/yeni digest, Dokploy deployment ID ve zaman çizelgesi var; secret yok.
