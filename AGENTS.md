# AGENTS.md

## Scope

Bu repo imzalı Hermes ↔ Hermes event bridge'idir. Ana tasarım `docs/implementation-plan.md`.

## Zorunlu kurallar

- TypeScript strict, pnpm, Biome; Python'da pathlib ve type hints.
- TDD: önce failing test, sonra minimum implementation, sonra refactor.
- Raw request body imzalanır; parse/re-serialize edilmiş body imzalanmaz.
- Signature karşılaştırması constant-time; replay penceresi fail-closed.
- Secret, plaintext payload veya tam mesaj loglanmaz.
- Migration'lar idempotent olmalı.
- Retry aynı event için ikinci Hermes turn'ü oluşturamaz.
- `observe` ve `response` zinciri bitirir; `request` yalnızca tek `response` üretir.
- Production deploy yalnız GitHub push + Dokploy auto-deploy ile yapılır; staging-first.
- Hermes-authored değişiklikler verify, commit, push edilir; working tree clean bırakılır.

## Verification

```bash
pnpm verify
```

Değişiklik sonrası hedefli testin yanında fresh full verification çalıştır.
