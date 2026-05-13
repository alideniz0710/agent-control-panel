# Korea Work Plan — Claude Code Briefing

**Bu dosya MacBook Air'da Claude Code'a verilecek brief.** Founder Korea'ya geldi, kontekst tamamen burada. Top-to-bottom oku, sonra önceliklendirilmiş listeden çalış. Plan modunda olduğundan emin ol — kod yazmadan önce her zaman founder'a planı göster.

---

## 0. Founder + ortam

**Kim:** Ali Deniz Aslan, solo founder, developer DEĞİL (kod okuyamaz). Türkçe konuşur.

**Nerede:** South Korea, MacBook Air 2026'da yeni satın alındı.

**Ne çalışıyor:**
- **Mac Mini (Türkiye, evde):** agent-control-panel + Tailscale Funnel + B2 backup cron + Telegram poller. 7/24 çalışır.
- **Vercel (cloud):** Splitbill production (`https://splitbill-chi-gilt.vercel.app`). Main branch'in her merge'ünde otomatik deploy.
- **MacBook Air (Korea, sen):** Claude Code burada çalışıyor. Telegram + GitHub + Tailscale → MacBook tarayıcı / SSH / web.

**İletişim modeli:**
- Telegram = canlı operasyonlar (founder phone, otelden, kafeden)
- Sen (Claude Code) = derin iş, kompleks plan, multi-file refactor, founder MacBook başına oturduğunda

**Iki ayrı repo:**
- `~/splitbill` — restaurant bill-split (Next.js 14 App Router + Supabase)
- `~/agent-control-panel` — bu panel (Next.js 16 + Prisma + SQLite)

İlk turn'de `git pull` yap her ikisinde de. Founder'a `pull yapıldı, başlıyorum` de.

---

## 1. Anlaman gereken kritik şeyler

### 1.1 Auto-merge gate (sadece agent-control-panel)
PR title'ın `[S]` veya `[XS]` ile başlamalı + (test eklediysen veya) `[no-test]` token'ı içermeli + deny-list dosyaları dokunmamalı. Aksi halde otomatik mergelemez, founder telefondan manuel mergeler.

Deny-list: `.env`, `package.json`, `package-lock.json`, `*.config.*`, `middleware.ts`, `migrations/`, `auth/`, `api/webhook/`.

**Format her PR için zorunlu:**

```
[S] kısa açıklama [no-test]
```

PR description'da şu başlık zorunlu:

```markdown
## Telefon test adımları
1. <Vercel preview URL veya production URL>
2. <ne tıklayacak / ne girecek>
3. <beklenen sonuç>
```

Splitbill'in auto-merge'i yok — founder manuel mergeleyecek. PR description'ı yine de yazıma uygun tut.

### 1.2 Memory system
`memory/` klasörü her agent'ın kalıcı bağlamı. Her task öncesinde otomatik prepend ediliyor.
- `memory/shared.md`: proje-genel, tüm agent'lar
- `memory/agents/<slug>.md`: agent-spesifik

Kendin de bir önemli karar verirsen veya bir bug bulursan, ilgili dosyaya markdown bullet ekle. Founder Telegram'dan `/memo <text>` ile de ekleyebilir.

### 1.3 Cost discipline
- `/cap set 8` günlük (Telegram'dan)
- Çoğu /se [S] olmalı → Haiku'ya gider, 5x ucuz
- Şu an günlük baseline $1-2; >$5/gün'e çıkarsa bir şey yanlış
- Founder MacBook'ta seninle ağır plan yaparken Anthropic API hesabı her çağrıda ödenir — kod yazma çağrıları pahalı, plan çağrıları ucuz. Plan'ı netleştir, kod tek seferde yaz.

### 1.4 Founder ile iletişim kuralları
- Türkçe yaz, plain language
- Kod blok'u zorunda kalmadıkça gösterme — "şu dosyada şu fonksiyonu güncelliyorum" yeter
- Plan modunda her zaman onay bekle (`Shift+Tab×2`)
- Her plan: dosya listesi + her birinde ne değişecek + risk + test adımı
- "Should work" deme — "lütfen test et ve sonucu söyle"

---

## 2. Önceliklendirilmiş iş listesi

### 🔴 P0 — Splitbill MVP'yi pilot kafeye hazır etmek (1-2 hafta deadline)

#### Task 1: Sprint 2.2 frontend (item selection UI)
**Niye:** Backend deploy edildi (Prisma ItemSelection tablosu + API endpoint'leri). Frontend orphan. Müşteri item seçimini göremiyor. **Demo için kritik.**

**Spec:**
- `app/bill/[token]/page.tsx`'e "Kendi seçimini yap" butonu ekle (mevcut "Eşit böl" yanına)
- Tıklayınca state `activeView='selecting'`'e geç
- ItemList kartlarını tıklanabilir yap; seçilenlere `border-blue-500`
- Üstte dinamik "Senin payın: X TL" hesaplaması (seçili item fiyatları toplamı + service/VAT proportional)
- Sticky bottom: "Vazgeç" (`POST /api/bill/[token]/cancel-selection`) + "Bittim — X TL" (`POST /api/bill/[token]/finish-selection`)
- SSE/Realtime event `selection-changed` dinleyerek diğer kullanıcılar canlı görsün
- Mobile-first, kart min-height 56px, buton min-height 44px
- Toast for errors

**Endpoint'ler (zaten deploy):**
- `POST /api/bill/[token]/select-mode` body: `{userId}`
- `POST /api/bill/[token]/toggle-item` body: `{userId, itemId}`
- `POST /api/bill/[token]/finish-selection` body: `{userId}`
- `POST /api/bill/[token]/cancel-selection` body: `{userId}`

**Test:**
- 2 ayrı tarayıcı sekmesinde aynı bill aç
- 1. sekme "Kendi seçimini yap" → 2 item seç → ekrandaki "X TL" güncelleniyor mu?
- 2. sekme'de aynı bill → seçili itemler kilitli görünüyor mu?
- 1. sekme "Bittim" → ödeme adımına geçiyor mu?

**PR title:** `[M] sprint 2.2 frontend: item selection UI`

#### Task 2: Sprint 2.3 (custom amount)
**Niye:** Bazı müşteriler item seçmek yerine "X TL ödüyorum" demek ister. MVP feature parity.

**Spec:**
- Prisma `CustomAmountSelection` tablosu veya `users` tablosuna `customAmount Decimal? nullable` (founder seçecek). Migration: `2026_05_15_custom_amount`
- `POST /api/bill/[token]/set-custom-amount` body: `{userId, amount}`
- Validation: amount > kalan tutar → 400 "amount exceeds remaining"; item-mode'daysa → 400 "switch from item-mode first"
- `app/bill/[token]/page.tsx`'e "Manuel TL gir" butonu (item-selection yanına)
- Modal/sheet açılır, number input, "Onayla"
- State machine: item-mode ↔ custom-mode mutually exclusive
- SSE event `custom-amount-set` broadcast

**Test:**
- Manuel TL gir → 10 TL → kabul ediliyor mu?
- Kalan toplamı aşan değer dene → 400 "amount exceeds remaining" hata mesajı
- Önce item seçim yap, sonra manuel TL → "switch first" hatası

**PR title:** `[M] sprint 2.3: custom amount mode`

#### Task 3: Sprint 3.1 (soloist lock UI banner)
**Niye:** Bir kullanıcı item-selection veya custom-amount-mode'a geçtiğinde diğerleri için "X şu an seçim yapıyor, bekleyin" sticky banner. Çakışmaları önler.

**Spec:**
- `SoloistBanner` component'i `app/bill/[token]/page.tsx`'e ekle
- Sticky top, `bg-yellow-100`, slide-down animasyon
- Mevcut SSE events kullan, yeni backend gerekmiyor (state 2.2'de zaten broadcast ediliyor)
- Soloist bittiğinde banner kaybolur

**PR title:** `[S] sprint 3.1: soloist lock banner [no-test]`

### 🟡 P1 — Splitbill polish + güvenilirlik

#### Task 4: Test coverage boost
Splitbill'de Vitest var ama coverage düşük. 2.2, 2.3, 3.1 backend endpoint'leri için happy path + 1 error case + 1 auth failure yaz.

**PR title:** `[M] test: bill flow endpoint coverage`

#### Task 5: Mobile responsiveness audit
Tüm bill akışında tap target'lar 44px+ mı, font'lar okunabilir mi, transitions smooth mı? Specific issue'ları PR olarak topla.

**PR title:** `[S] polish: mobile tap targets + micro-interactions [no-test]`

#### Task 6: Sentry SDK kurulumu
Webhook receiver hazır (`/api/hooks/sentry`), sadece SDK splitbill'de yok. `@sentry/nextjs` kur, `sentry.client.config.ts` + `sentry.server.config.ts` ekle. SENTRY_DSN env var Vercel'a ekle (founder yapacak).

**PR title:** `[S] feat: integrate Sentry SDK (web + server) [no-test]`

### ⚪ P2 — Panel kendisi

#### Task 7: TS strict cleanup (33 implicit-any errors)
`agent-control-panel`'de `npx tsc --noEmit` 33 hata buluyor (CI continue-on-error olarak işaretliydi). Hepsini düzelt, CI'da blocking yap.

**PR title:** `[M] cleanup: fix all implicit-any TS errors`

#### Task 8: Auto-rollback on Sentry spike
Sentry webhook'undan gelen issue.created event'lerini panel sayıp, son 10 dk'da deploy sonrası 5+ yeni error gelirse `/revert <son-pr>` otomatik tetiklesin (founder onay alarak).

**PR title:** `[M] feat: auto-rollback on Sentry error spike`

#### Task 9: Committee reviewer for M+ PRs
Auto-merge gate şu an [S]/[XS] mergelıyor. M+ PR'lar için "2 specialist review = otomatik merge" mantığı ekle (cc:debug + cc:software-engineer paralel).

**PR title:** `[L] feat: committee reviewer for M+ PRs`

### 🔵 P3 — Blue-sky (vakit kalırsa)

#### Task 10: Iyzico/PayTR integration prep
Keys gelmeden iskelet kod yaz. `lib/payment/provider.ts` interface tasarımı zaten var, sadece concrete `iyzico.ts` ve `paytr.ts` adapter'ları için class shell.

**PR title:** `[L] feat: payment provider scaffolding (iyzico+paytr)`

---

## 3. Günlük rutin (Korea'da)

**Sabah:**
1. Telegram → `/ping` `/cap status` `/cost`
2. `cd ~/agent-control-panel && git pull` ve `cd ~/splitbill && git pull`
3. Bu doc'a bak — bugün hangi task'a girişiyorsun?

**Çalışma:**
1. Plan modu (`Shift+Tab×2`) → founder onayı bekle
2. Onay sonrası kodla
3. Test instructions yaz (founder'ın telefondan test edeceği adımlar)
4. PR aç + founder'a Telegram'dan link gönder (`/se` ile değil — kendin yaz)

**Akşam:**
1. PR durumlarını gör (auto-merge mu olmuş, manuel mi)
2. Memory'ye not ekle eğer önemli bir şey öğrendiysen
3. `/cost` ile günlük spend kontrol

---

## 4. Hata durumunda

### Build kırılırsa
- Önce `npm install` yap (lockfile değişmiş olabilir)
- TypeScript hatası varsa düzelt
- Vercel preview'de kırılırsa env vars'ı kontrol et

### CI fail olursa
- Mostly bu pre-existing implicit-any errors (continue-on-error). Sorun değil.
- Build step kırılırsa → real issue, fix

### Auto-merge tetiklenmezse
- PR title formatı doğru mu? `[S] ... [no-test]`
- Deny-list dosya değişti mi?
- CI yeşil mi? (büyük ihtimal sebep)

### Memory'de bir agent'ın aptal kalıyorsa
- `memory/agents/<slug>.md` dosyasını manuel oku
- Eksik yönergeler varsa ekle
- Founder'a "memory'ye şu maddeyi koydum, agent buradan sonra şunu bilecek" de

---

## 5. URL + komut cheat sheet

**Repolar:**
- https://github.com/alideniz0710/agent-control-panel
- https://github.com/alideniz0710/splitbill

**Production:**
- Splitbill: https://splitbill-chi-gilt.vercel.app
- Panel: Tailscale-only, `http://localhost:3000` Mac Mini'de veya `https://alidenizs-mac-mini.tail82cdd7.ts.net:8443` tailnet'ten

**Webhooks (public):**
- https://alidenizs-mac-mini.tail82cdd7.ts.net/api/hooks/{github,vercel,sentry}

**Telegram komutları (founder kullanır, sen değil):**
- `/se` `/debug` `/pa` — direct agent dispatch
- Plain text — orchestrator'a yönlendirir
- `/cost [hours]` — cost dağılımı
- `/memo [agent] <text>` — memory ekle
- `/cap` `/auto` `/ping` `/agents` `/sync` `/undo` `/revert <pr>` `/deploy`

**Mac Mini deploy (founder yapacak veya sen SSH ile):**
```bash
cd ~/agent-control-panel && git pull && npm run build && pm2 reload ecosystem.config.js --update-env
```

Splitbill kendisi Vercel auto-deploy.

---

## 6. Senin kuralların (Claude Code'a özel)

1. **Önce plan mode** — kod yazmadan founder onayı al
2. **Türkçe yaz**, kısa cümleler
3. **Tek seferde PR aç**, multiple commit'i tek PR'a bağla (squash merge edilebilsin)
4. **Test instructions zorunlu** — founder telefondan denemek istiyor
5. **CLAUDE.md, SPEC.md, memory/ dosyalarını her oturumda OKU**
6. **`/cost` numarası > $5 ise kod yazma, plan tartış** — yanlış bir şey var
7. **Bir karar uçtan-uca cost > $1 olacaksa founder'a sor** (örn "Opus kullanayım mı?")
8. **Her PR'dan sonra memory/agents/software-engineer.md'ye** o oturumun "öğrendim X" satırını ekle (auto-write zaten yapıyor ama elinle de ekle eğer önemliyse)

---

## 7. Acil iletişim

Bir şey çok yanlış giderse founder Türkiye'de uyuyor olabilir. Şunları DENEME:
- Migration çalıştırma (database)
- `.env` düzenleme
- Force push, hard reset, git clean
- `rm -rf`
- DROP TABLE / TRUNCATE / DELETE FROM
- `--no-verify`

Bunların hepsinde founder onayı SHART. Founder'a Telegram mesajı bırak, sabah onaylar.

Acil çağrı kanalı: founder'ın `/sync` ile manuel müdahalesi gerekirse aşağıdaki gibi bir Telegram mesajı:

```
🚨 Founder, MacBook'ta şunu yapmaya çalıştım [X]. Şu hatayla karşılaştım [Y].
Devam etmek için Mac Mini'ye SSH ile bağlanıp [Z] komutunu çalıştırmam gerek.
Onaylar mısın?
```

---

## 8. Bitince ne yapıyoruz

P0'ı bitirdiğinde **MVP demo-ready** olur. Founder pilot kafeyle görüşmeye gider, ekran kaydı / demo / vs.

P1'i bitirdiğinde **MVP production-ready** olur (sadece payment integration eksik kalır, o keys'e bağlı).

P2'yi bitirdiğinde **panel + product hep birlikte enterprise-grade** olur.

P3 lüks.

---

**Son söz:** Founder seni Korea'da yanına aldı çünkü onun yapamadığı şeyleri yapasın diye. Onu yormamak ana hedef. Telefondan onay alabileceğin şekilde planla; ona sadece "evet" veya "1/2/3" sormaya bırak. Karmaşık trade-off'lar değil, basit tavırlar.

İyi çalışmalar 🇰🇷

— Claude (Türkiye'den, 2026-05-14 gece)
