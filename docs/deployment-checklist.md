# Staging deployment checklist

Bu checklist Bridge API'yi yalnızca doğrulanmış immutable image ile Dokploy staging'e çıkarır. Production bu dokümanın kapsamında değildir.

## 1. Artifact gate

- [ ] Deploy edilecek commit `main` üzerinde ve GitHub `ci` workflow sonucu `success`.
- [ ] `publish-image` workflow aynı commit için `success`.
- [ ] Publish yalnız başarılı `ci` `workflow_run` event'inden geldi; manual dispatch yolu yok.
- [ ] Image reference tam digest içeriyor: `ghcr.io/<owner>/hermes-agent-bridge@sha256:<64-hex>`.
- [ ] Digest, workflow artifact'i `image-ref-<short-sha>` ve job summary ile eşleşiyor.
- [ ] Mutable `latest`, `main` veya yalnız `sha-*` tag'i Dokploy'a girilmiyor.
- [ ] GHCR pull credential yalnız `read:packages` yetkisine sahip ve Dokploy host'ta doğrulanmış.

## 2. Staging isolation gate

- [ ] Dokploy target `hermes-agent-bridge / staging / bridge-staging`.
- [ ] Production environment ve production Telegram grubu değiştirilmiyor.
- [ ] Staging için ayrı PostgreSQL volume/database kullanılıyor.
- [ ] Staging domain ve TLS endpoint'i hazır.
- [ ] Ayrı Telegram staging grubu ve iki staging bot kimliği canlı gateway verisinden doğrulandı.
- [ ] Alpha ve Beta staging Hermes profile/host erişimleri doğrulandı.
- [ ] Gerçek `chat_id` ve varsa `thread_id` iki gateway'den çapraz doğrulandı; tahmin edilmedi.

## 3. Dokploy runtime gate

Aşağıdaki değerler Dokploy secret/environment alanında bulunmalı; gerçek değerler repo, ticket, log veya chat'e yazılmaz:

- [ ] `BRIDGE_IMAGE_DIGEST` immutable digest reference.
- [ ] `BRIDGE_STAGING_HOST` yalnız staging DNS hostname'i.
- [ ] Staging database credential'ını taşıyan tek canonical `DATABASE_URL`.
- [ ] `BRIDGE_PAYLOAD_KEY_VERSION` + current 32-byte base64 payload key.
- [ ] Rotation için gerekli current/previous key değişkenleri compose tarafından container'a geçiriliyor; first deploy öncesi key-ID preflight sonucu kaydedildi.
- [ ] Alpha ve Beta için ayrı ingress HMAC secret'ları.
- [ ] Alpha ve Beta webhook URL'leri + birbirinden ayrı delivery HMAC secret'ları.
- [ ] `BRIDGE_METRICS_TOKEN`.
- [ ] `BRIDGE_REQUESTS_ENABLED=false`.
- [ ] `PORT=3000`, `NODE_ENV=production`.

Compose doğrulaması:

Gerçek değerler terminal komut satırına yapıştırılmaz. Secret manager/Dokploy export ile mode `0600` hazırlanmış geçici bir env dosyası kullanılır; render stdout'a basılmaz ve dosya işlem sonunda secure-delete politikasına göre kaldırılır:

```bash
docker compose --env-file /run/secrets/hermes-bridge-staging.env \
  -f docker-compose.staging.yml config --quiet >/dev/null
```

Bu gate yalnız syntax/interpolation doğrular; secret değerleri log, shell history veya acceptance report'a girmez.

## 4. Deploy gate

- [ ] Staging compose auto-deploy, eksik runtime config varken kapalı.
- [ ] Dokploy compose tanımı, yayınlanan aynı commit'teki `docker-compose.staging.yml` dosyasının immutable raw snapshot'ı; deploy anında mutable `main` branch'ten okunmuyor.
- [ ] Commit SHA ve raw compose `sha256` değeri deployment kaydına secret içermeden yazıldı.
- [ ] Deploy Dokploy API/UI üzerinden tetikleniyor; doğrudan `docker build`, `docker push` veya `docker service update` yok.
- [ ] Migration'lar idempotent ve API readiness'ten önce tamamlanıyor.
- [ ] Tek replica ile başlanıyor.
- [ ] Önceki known-good image digest + compose snapshot hash rollback kaydında mevcut.
- [ ] Dokploy deployment kaydı `done`.
- [ ] API container için `docker inspect <container-id> --format '{{.Config.Image}}'` çıktısı beklenen `registry/name@sha256:...` reference ile birebir aynı.

## 5. Health and security gate

- [ ] `GET /healthz` → `200`.
- [ ] `GET /readyz` → `200` ve DB/worker hazır.
- [ ] `GET /metrics` token olmadan → `401`.
- [ ] `GET /metrics` doğru token ile → `200`.
- [ ] Geçersiz imza ve expired timestamp → `401`.
- [ ] Unknown source/target ve aynı source/target fail-closed.
- [ ] Container/runtime loglarında secret veya tam message body yok.

## 6. Hermes staging gate

Her profile için:

- [ ] Plugin gerçek Hermes `PluginManager` ile keşfedilip bir kez yükleniyor.
- [ ] `HERMES_BRIDGE_ENABLED=true` yalnız staging profile'da.
- [ ] `HERMES_BRIDGE_REQUESTS_ENABLED=false`.
- [ ] `HERMES_BRIDGE_ALLOWED_CHAT_IDS` yalnız doğrulanmış staging group ID içeriyor.
- [ ] `HERMES_BRIDGE_ALLOWED_THREAD_IDS` gerekiyorsa yalnız doğrulanmış staging topic ID içeriyor.
- [ ] `HERMES_BRIDGE_ALLOWED_WEBHOOK_ROUTES` yalnız peer route'u içeriyor.
- [ ] Alpha `peer-beta`, Beta `peer-alpha` subscription'ına sahip.
- [ ] Peer webhook turn'lerinde terminal/file/code/delegation/cron/MCP araçları kapalı.
- [ ] Outbox path kalıcı profile storage altında, mode `0600`, plaintext içerik yok.

## 7. Observe-only canary

- [ ] Alpha → Beta event tekil teslim; Telegram'da ek Beta cevabı yok.
- [ ] Beta → Alpha event tekil teslim; Telegram'da ek Alpha cevabı yok.
- [ ] Duplicate request tek peer turn oluşturuyor.
- [ ] Replay-window dışındaki signed request reddediliyor.
- [ ] Bridge 5 dakika kapalıyken Telegram cevabı bloklanmıyor; outbox birikiyor.
- [ ] Bridge geri geldiğinde queued event'ler birer kez teslim ediliyor.
- [ ] Gateway ve Bridge restart sonrası pending event kaybolmuyor.
- [ ] DLQ, retry, outbox age ve loop-prevented metric'leri kontrol edildi.

## 8. Review gate

- [ ] [`rollback.md`](rollback.md) staging'de drill edildi.
- [ ] [`secret-rotation.md`](secret-rotation.md) en az ingress HMAC için drill edildi.
- [ ] Kabul raporu commit SHA, image digest, Dokploy deployment ID ve redacted kanıtlarla güncellendi.
- [ ] `pnpm verify` fresh geçti.
- [ ] Tüm Hermes-authored değişiklikler commit/push edildi; working tree clean.
- [ ] Kart `Review` aşamasında bırakıldı; insan onayı olmadan production/Done yok.
