# Agent Memory

Bu klasör, panel'in agent'larına çağrı başına otomatik prepend edilen "kalıcı bağlam"dır.

## Yapı

```
memory/
├── README.md                      # Bu dosya
├── shared.md                      # TÜM agent'lar görür (proje genel context)
└── agents/
    ├── software-engineer.md       # cc:software-engineer-only
    ├── debug.md                   # cc:debug-only
    └── personal-assistant.md      # cc:personal-assistant-only
```

## Nasıl çalışır

Her agent çağrısında (orchestrator dispatch veya `/se` `/debug` `/pa` direct route):

1. `memory/shared.md` okunur
2. İlgili `memory/agents/<agent-slug>.md` okunur
3. İkisi birleştirilip görev metninin başına eklenir (markdown header'larla)
4. Sonra agent'a gönderilir

Agent görevi okumadan önce projeyi, son hataları, kararları, kuralları görür.

## Düzenleme

### Manuel (Mac'te VS Code veya nano)

Dosyaları düzenle, commit + push. Bir sonraki agent çağrısında değişiklik yansır.

### Telegram'dan (Korea'dayken)

```
/memo Splitbill production URL'i splitbill-chi-gilt.vercel.app
/memo software-engineer Bugün PR title'a [no-test] eklemeyi unutmadın, devam et
```

İlk komut `shared.md`'ye, ikincisi `agents/software-engineer.md`'ye satır ekler.
Otomatik timestamp + commit + push yapılır (Mac'te git config'in yüklenmesi gerek).

## Format

Markdown, kısa cümleler. Çok uzatma — her satır agent'ın system prompt token'larına dahil olur, maliyeti var.

Yapı önerisi:

```markdown
# Bölüm başlığı

- Kısa madde 1
- Kısa madde 2

## Alt bölüm

Paragraf.

## Son güncellemeler

- 2026-05-13: Bug X çözüldü, sebebi Y'di. Tekrarlanmamasi için Z.
```

## Idempotency

Memory dosyaları çağrıdan çağrıya değişmediği sürece agent davranışı stabil. Bir madde eklediğinde sadece o değişiklik yansır.

## "Çok büyür" diye endişe etme

Her dosya max 200 satır olsun yeterli. Daha fazla olursa eski + çözülmüş şeyleri kaldır.
Agent'ın 100KB tarihçeyi okumasına gerek yok — son ay yeterli.
