# Korea Trip Runbook

**Bu doküman tatil boyunca panele uzaktan müdahale ederken kullanacağın referanstır. Yatağında, kafede, treninde — telefondan Telegram ile her şeyi nasıl yönetirsin.**

Bir kez okumadan yatma. Sonra unutursan endişelenme — `/help` her zaman çalışır.

---

## Günlük rutin (her sabah 2 dk)

Uyanır uyanmaz Telegram'da sırayla:

```
/ping
/backup status
/cap status
```

| Komut | Beklenen cevap | Tehlike işareti |
|---|---|---|
| `/ping` | "pong" | Hiç cevap yok → Mac uyumuş/kapanmış |
| `/backup status` | Son backup 24h içinde | "no backups" → cron çalışmamış |
| `/cap status` | Bugünkü harcama < $5 | $10+ → bir görev kaçmış olabilir, `/kill` |

Üçü de yeşilse → günü başlat, sorun yok.

---

## Uzaktan görev verme

### Plain text (en doğal yol)

Slash komut olmadan Türkçe yaz, orchestrator-router uygun specialist'e route eder:

> "splitbill'de buton rengini koyu mavi yap"

→ Otomatik `cc:software-engineer`'a gider, PR açar, auto-merge ederse Vercel deploy eder.

### Hedef agent biliyorsan `/se` `/debug` `/pa`

Direkt specialist çağırır, orchestrator atlanır (daha hızlı):

> `/se splitbill bill sayfasında ödeme butonunu büyüt [S] [no-test]`

`[S]` boyut tag'ı + test ekleneceğine bağlı olarak `[no-test]` (test yok ama merge edilebilsin) eklemeyi unutma — auto-merge gate zorunlu kılıyor.

### Ses mesajı (yürürken/yemek yerken)

10-30 saniyelik Türkçe ses kaydı gönder. Whisper transcribe eder, sonra normal text gibi orchestrator'a gider. Ücret: ~$0.003 per message, ihmal edilebilir.

### Fotoğraf (ekran görüntüsü + soru)

Telefondan screenshot çek, Telegram'a gönder, caption olarak yorum yaz:

> *(screenshot)* "burada masa eklenmiyor neden"

→ Claude vision görüntüyü tarif eder, orchestrator'a dispatch eder.

---

## Acil durum komutları

| Komut | Ne yapar | Ne zaman |
|---|---|---|
| `/kill` | En son çalışan görevi durdurur | Agent saçmalıyor, cost yiyiyor |
| `/kill <task-id>` | Belirli görevi durdurur | Birden fazla görev var, biri sorunlu |
| `/undo` | Son agent commit'ini revert eder | Yanlış bir şey commit etmiş |
| `/undo confirm` | Onaylı revert (yıkıcı işlemler için) | Ekstra güvenlik istiyorsan |
| `/revert <PR-no>` | Belirli bir PR'ı geri al (revert PR'ı açar) | "Bu merge production'ı kırdı" |
| `/sync` | Mac'in develop branch'ini GitHub'tan günceller | "Mac'te eski versiyon var sanki" |
| `/cap set 5` | Günlük cost limit'i 5$ olarak ayarla | Cost yedi, limit dolduğunda görevler reddediliyor |
| `/auto on` veya `/auto off` | Auto-merge'i aç/kapat | Üst üste tehlikeli PR varsa kapat |
| `/deploy status` | Son Vercel deploy durumunu gösterir | "Deploy başarısız mı?" |
| `/backup now` | Manuel backup tetikler | Önemli bir değişiklikten önce |
| `/agents` | Kayıtlı agent listesi | Sanity check, panel hayatta mı |

---

## Failure modes — neyse ne yap

### "Bot hiç cevap vermiyor"

1. **İlk reflex:** Bir-iki dakika bekle. Geçici Telegram gecikmesi olabilir.
2. Hala yoksa Tailscale ile Mac'in panel UI'sine eriş:
   - Mac'i tailnet'te bul: `http://alidenizs-mac-mini.tail82cdd7.ts.net:3000`
   - UI açılıyorsa Mac çalışıyor → Telegram poller takılmış
3. Hala açılmıyorsa **Mac'i uzaktan reboot edemezsin**. Mac'te birinin eline talimat:
   - "Mac Mini'de Ctrl+Eject (veya Power tuşu) ile yeniden başlat"
4. Reboot sonrası panel otomatik gelir (PM2 startup configured)

### "Bir görev takıldı, costs çıldırıyor"

```
/cap status   # ne kadar harcamış görelim
/kill         # son task'ı öldür
/cap set 3    # bütçeyi düşür, gece için
```

### "Yanlış bir şey commit edildi"

```
/undo               # son agent commit'ini gör + revert için onay iste
/undo confirm       # gerçekten revert et
```

veya GitHub'dan belirli bir PR'ı:

```
/revert 42          # PR #42 için revert PR aç
```

### "Deploy kırıldı, production down"

Önce Telegram'a Vercel webhook'tan otomatik mesaj gelmiş olmalı:
> ❌ [vercel/splitbill] deployment error on main (production)

Eğer Sentry SDK kuruluysa Sentry de issue olarak fırlatır.

Hızlı geri çekme:

```
/revert <son-merge-PR-no>
```

GitHub'da otomatik bir revert PR açar, mergele → Vercel önceki versiyona deploy eder.

### "Backup alınmamış"

```
/backup now
```

Manuel tetikler. Cron'un niye fail olduğunu Telegram log'undan görmeden o günü ileriye al. Geceleyin ev wifisi/elektrik kesilmiş olabilir.

---

## Cost takibi

Anthropic API'ye otomatik yüklenme açıkladıysan rahatsın. Aksi halde:

```
/cap status
```

Günlük harcamanı gösterir. Bütçe = `$12`. Korea ilk haftası için tüm görevlerle birlikte `$5-8` arası beklenir. Üstüne çıkıyorsa bir görev fazla pahalı, bak.

Anthropic console.anthropic.com → Billing → Credits → kalan bakiyeyi gör. $5 altına düştüyse $20 daha yükle.

---

## "Yapma" listesi (canını yakar)

- ❌ **Tailscale'i durdurma.** Mac panele erişimini koparırsın.
- ❌ **PM2'yi `pm2 stop all` ile durdurma.** Telegram bot ölür.
- ❌ **`rm -rf` veya `git reset --hard` komutu içeren /se prompt'u gönderme** — agent korumalı ama yine de risk.
- ❌ **`.env`'i agent'a bırakma.** Secret değişiklikleri Mac'te eliyle yapılır.

---

## Cellular dry-run checklist (gitmeden BUGÜN yap)

Telefonu Wi-Fi'den ayır, **sadece cellular ile**:

- [ ] `/ping` cevap geldi
- [ ] 10sn'lik Türkçe ses mesajı → transcribe edip cevap geldi
- [ ] Screenshot + caption "test" → `[photo: ...]` ile başlayan cevap
- [ ] `/backup status` cevap geldi
- [ ] `/cap status` cevap geldi
- [ ] `/agents` cevap geldi
- [ ] Plain text "merhaba neler yapabilirsin" → bir cevap geldi (orchestrator)
- [ ] `/help` cevap geldi

8/8 yeşilse Korea'ya hazırsın. Bir tanesi başarısızsa düzelt ve tekrar dene.

---

## Eve dönünce (Korea'dan sonra)

Tatil bitince ilk gün:

```bash
# Mac'te
cd ~/agent-control-panel
git pull
pm2 list                # online mı
pm2 logs --lines 100    # 1 hafta boyunca neler olmuş özet
```

Telegram'dan:

```
/backup status   # 7 yedek olmalı (haftalık)
/cap status      # toplam ne harcanmış
```

---

**Acil iletişim:** Eğer her şey kırıldıysa ve Mac'e ulaşamıyorsan, Türkiye'deki güvendiğin biri (kardeş, arkadaş) Mac'in başına gidip şu komutu çalıştırırsa panel yeniden hayat bulur:

```bash
cd ~/agent-control-panel && pm2 restart all
```

Bu kadar. İyi tatiller, panel arkanı kollar. 🇰🇷
