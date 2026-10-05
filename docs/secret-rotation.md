# Secret rotation runbook

Tüm secret'lar ayrı işlevlere sahiptir; aynı değer iki yönde veya iki ajan arasında tekrar kullanılmaz. Gerçek değerler repo, chat, log, ticket veya Dokploy deployment açıklamasına yazılmaz.

## Secret envanteri

| Sınıf | Yer | Rotation modeli |
|---|---|---|
| Alpha/Beta ingress HMAC | Plugin → Bridge | Bridge active + previous grace window |
| Alpha/Beta delivery HMAC | Bridge → Hermes webhook | Route/target kontrollü handoff |
| Payload encryption key | Bridge runtime | Versioned current + previous decrypt key |
| Plugin outbox encryption key | Her Hermes profile | Drain, stop, rotate, reopen |
| Metrics bearer token | Bridge runtime/monitor | Consumer-first replacement |
| PostgreSQL credential | Dokploy Postgres/API | Database role + runtime coordinated restart |

## Genel kurallar

- Önce staging drill, sonra production review.
- Her secret için bağımsız en az 32 random byte kullan.
- Rotation sırasında `BRIDGE_REQUESTS_ENABLED=false` ve `HERMES_BRIDGE_REQUESTS_ENABLED=false` kalır.
- Secret değeri yerine yalnız version/fingerprint ve zaman damgası raporlanır.
- Başarısız rotation'da eski secret grace window bitmeden geri dönülebilir.

## Ingress HMAC rotation

Bir agent için sırasıyla:

1. Yeni secret üret.
2. Bridge'de yeni değeri `ACTIVE`, mevcut değeri `PREVIOUS` olarak ayarla.
3. Dokploy üzerinden Bridge'i redeploy et; readiness ve eski imzalı probe'u doğrula.
4. İlgili Hermes plugin'i yeni ingress secret ile reload et.
5. Yeni event'in `202`, duplicate event'in idempotent olduğunu doğrula.
6. En az replay window + maksimum retry jitter süresi bekle.
7. Bridge'den `PREVIOUS` değeri kaldır ve yeniden deploy et.
8. Eski imzalı probe'un `401`, yeni imzalı probe'un `202` olduğunu doğrula.
9. Diğer agent için aynı adımları ayrı change window'da tekrarla.

## Delivery HMAC rotation

Hermes webhook subscription tek active secret kabul ettiği için zero-gap dual-secret varsayılmaz.

1. İlgili plugin outbound'u disable et; yeni event üretimini durdur ama outbox'ı silme.
2. Bridge target delivery worker'ını bakım penceresinde durdur veya hedef yönü isolate et.
3. Hermes peer subscription secret'ını yenile.
4. Bridge'in aynı target için delivery secret'ını yenile ve Dokploy redeploy yap.
5. Signed webhook test ile tam raw-body HMAC doğrula.
6. Delivery worker'ı aç; retry queue'nun tekil teslim edildiğini kontrol et.
7. Plugin outbound'u aç.
8. DLQ ve signature failure metriği sıfır/normal değilse yönü tekrar kapat ve eski pair'e dön.

Alpha ve Beta yönleri aynı anda rotate edilmez.

## Payload encryption key rotation

Önce database'teki gerçek key referanslarını read-only sorguyla say. Bir key'i kaldırma gate'i, iki tabloda da o key için toplam `0` kayıttır:

```sql
WITH key_references AS (
  SELECT payload_key_id AS key_id, count(*) AS reference_count
  FROM bridge_events
  GROUP BY payload_key_id
  UNION ALL
  SELECT outbound_key_id AS key_id, count(*) AS reference_count
  FROM bridge_deliveries
  WHERE outbound_key_id IS NOT NULL
  GROUP BY outbound_key_id
)
SELECT key_id, sum(reference_count) AS reference_count
FROM key_references
GROUP BY key_id
ORDER BY key_id;
```

First staging deploy öncesi bu sorgu çalıştırılır. `v0` sonucu sıfır değilse `BRIDGE_PAYLOAD_KEY_V0_BASE64` boş bırakılamaz ve deploy **NO-GO** olur.

1. Yeni key version belirle; örneğin `v2`.
2. Compose pass-through'ünün `BRIDGE_PAYLOAD_KEY_V2_BASE64` değişkenini container'a geçirdiğini render ve runtime environment key-name kontrolüyle doğrula; değer loglanmaz.
3. Yeni 32-byte base64 key'i `BRIDGE_PAYLOAD_KEY_V2_BASE64` olarak ekle.
4. `BRIDGE_PAYLOAD_KEY_VERSION=v2` yap.
5. `BRIDGE_PAYLOAD_PREVIOUS_KEY_VERSION=v1` ve v1 key'i decrypt için tut.
6. Dokploy redeploy; readiness ve old/new ciphertext round-trip kontrolü yap.
7. Önceki key ile encrypted event/frozen-request kayıtları retention purge olana kadar v1'i kaldırma.
8. Yukarıdaki preflight sorgusunda `v1` toplamı `0` olmadan previous version/key'i kaldırma.

Destructive bulk re-encryption change'i ayrı migration/review olmadan yapılmaz.

## Plugin outbox key rotation

Outbox mevcut ciphertext'i tek key ile açtığı için key'i dolu queue üzerinde değiştirme.

1. Bridge ve hedef route sağlıklıyken outbox pending sayısını sıfıra indir.
2. Plugin'i disable edip gateway/plugin worker'ı durdur.
3. Outbox dosyasının encrypted backup'ını restricted storage'a al; plaintext export yapma.
4. Pending/dead kayıt olmadığını doğrula.
5. Yeni key'i profile secret store'a yaz.
6. Plugin'i aç; yeni test event'inin encrypted tutulup teslim edildiğini doğrula.
7. Eski key ve backup retention'ını incident policy'ye göre kaldır.

Queue boşaltılamıyorsa rotation durdurulur; veri silinmez.

## Metrics token rotation

1. Yeni token'ı monitor consumer'a ekle.
2. Bridge runtime token'ını değiştirip Dokploy redeploy yap.
3. Yeni token ile `200`, eski token ile `401` doğrula.
4. Eski consumer credential'ını kaldır.

## PostgreSQL credential rotation

1. Staging DB snapshot/backup doğrula.
2. Yeni role/password veya provider-supported dual credential hazırla.
3. Database role credential'ını ve API'nin canonical `DATABASE_URL` secret'ını coordinated Dokploy change olarak uygula.
4. `/readyz`, migration startup ve worker claim testini doğrula.
5. Eski credential'ı revoke et.

Compose içinde kullanılmayan ayrı bir `POSTGRES_PASSWORD` tutulmaz; credential yalnız database role/provider ve canonical `DATABASE_URL` üzerinden yönetilir.

## Rotation tamamlanma kriteri

- Fresh signed event iki yönde beklenen auth sonucu veriyor.
- Replay ve eski secret fail-closed.
- Pending outbox/delivery queue kaybolmamış.
- DLQ/signature failure artışı yok.
- Runtime immutable image digest değişmediyse aynı kalmış; değiştiyse ayrı deployment kaydı var.
- Rapor yalnız secret version/fingerprint içeriyor; gerçek değer içermiyor.
