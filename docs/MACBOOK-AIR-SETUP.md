# MacBook Air Setup Runbook

**Korea'da yeni MacBook Air aldığında, sıfırdan panele erişimi nasıl kurarsın.** ~45 dk toplam.

Bu doküman Türkiye'deki Mac Mini'ye sadece **VIEWER** olarak erişim sağlar — yani:
- ✅ Panel UI'sini tarayıcıdan görmek
- ✅ PR'ları GitHub'dan review etmek
- ✅ Tailscale'den Mac Mini'nin loglarına bakmak (SSH ile)

Asıl ağır iş Mac Mini'de Türkiye'de çalışıyor. MacBook Air sadece bir window/console.

---

## 1. Apple ID ile ilk kurulum (10 dk)

MacBook Air'ı aç. macOS setup wizard:
- Bölge: South Korea (saat dilimi için) veya Turkey (zaten Apple ID Türkiye)
- Wi-Fi: otel/Airbnb
- Apple ID: kendi mevcut Apple ID hesabını gir
- Touch ID + parola kur (parola güçlü olsun, MacBook'u kaybedersen Find My koruyacak)

iCloud Drive aç — Mac Mini'deki dosyalara erişebilirsen avantaj.

---

## 2. Terminal + Homebrew (10 dk)

Spotlight (Cmd+Space) → "Terminal" yaz, aç.

Homebrew kurulumu (resmi):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Bittikten sonra brew'i shell'e ekle:

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Doğrula:

```bash
brew --version
```

---

## 3. Tailscale (5 dk) ← EN KRİTİK

Bu olmadan panele bağlanamazsın.

```bash
brew install --cask tailscale
```

Sonra **Applications**'tan Tailscale'i aç. Menü bar'da bir küçük ikon belirir → tıkla → "Log in..." → tarayıcıda Tailscale hesabına giriş yap (aynı hesap, Mac Mini'nin olduğu hesap).

Login olur olmaz tailnet'e katılırsın. Doğrulama:

```bash
tailscale status
```

Çıktıda Mac Mini'nin gözükmesi gerekiyor (`alidenizs-mac-mini` veya ne ismi koymuştuysan).

**Test:**

```bash
ping alidenizs-mac-mini
```

Cevap gelirse Mac Mini'ye direkt görüşüyorsun. 🎯

---

## 4. Panel'e tarayıcıdan erişim (1 dk)

Safari veya Chrome'da aç:

```
http://alidenizs-mac-mini.tail82cdd7.ts.net:3000
```

Panel UI gözükmeli — workflow listesi, agent listesi, runs, schedule sekmeleri. Bu Tailscale içinden geliyor, public değil — sadece sen erişiyorsun.

---

## 5. Mac Mini'ye SSH (opsiyonel ama önerilen) (5 dk)

Mac Mini'ye Tailscale üzerinden SSH ile bağlanmak istersen önce Türkiye'deyken Mac Mini'de SSH'i aç:

**(Türkiye'de yapılacak — Korea'da değil):**
- System Settings → General → Sharing → "Remote Login" ✅

Sonra MacBook Air'dan:

```bash
ssh alidenizaslan@alidenizs-mac-mini.tail82cdd7.ts.net
```

(kullanıcı adı senin Mac Mini'deki user adın — `whoami` ile öğrendin)

İlk seferde "host key" onayla. Şifre = Mac Mini'nin login şifresi.

İçeri girdiğinde:

```bash
cd ~/agent-control-panel
pm2 list
pm2 logs --lines 50
```

Mac Mini'nin terminal'inde gibi çalışırsın.

---

## 6. Git + GitHub erişimi (opsiyonel) (5 dk)

PR'ları çoğunlukla web'den mergeleyeceksin ama nadiren bir şey clone etmek istersen:

```bash
brew install git gh
gh auth login
```

GitHub CLI tarayıcıya yönlendirir, kendi hesabına onay verirsin.

---

## 7. Visual Studio Code (opsiyonel) (5 dk)

Kod review yapmak istersen:

```bash
brew install --cask visual-studio-code
```

Açtığında "Open Folder" ile bir git repo'sunu açabilirsin (tabii önce clone etmen lazım).

---

## 8. Şifre yönetimi (önemli)

MacBook Air'da:
- iCloud Keychain otomatik senkron olur (Tailscale, GitHub, Anthropic, Vercel, vs şifreler eski Mac'inden gelir)
- Veya 1Password / Bitwarden gibi bir password manager kur

`.env` secret'ları **DİSKLE ALMAK İSTEMEZSEN** = sadece Mac Mini'deki dosyada kalsın. MacBook Air sadece UI ve PR review içindir.

---

## Acil senaryolar (Korea'da)

### "MacBook Air çalındı / kayboldu"

1. Başka bir cihazdan https://icloud.com/find aç
2. MacBook Air'ı bul → "Mark as Lost" → şifre koy
3. Tailscale console (https://login.tailscale.com/admin/machines) → MacBook Air entry'sini sil (tailnet'ten çıkar)
4. Anthropic/Vercel/GitHub şifrelerini değiştir (paranoya için)

Mac Mini Türkiye'de hala çalışır, Telegram'dan komut verme yeteneğin etkilenmez.

### "Tailscale bağlanmıyor"

```bash
sudo killall tailscaled
brew services restart tailscale
```

Veya menü bar'dan: Tailscale → "Disconnect" → 5 sn bekle → "Connect".

### "ssh giriyor ama parola hatası"

Mac Mini'de System Settings → General → Sharing → Remote Login → "Allow access for:" altında kullanıcı adın işaretli mi kontrol et. Türkiye'de oradayken yap.

---

## Setup başarı kriterleri

Şunlar hepsi çalışmalı:

- [ ] `ping alidenizs-mac-mini` → cevap geliyor
- [ ] Tarayıcı: panel açılıyor
- [ ] `ssh alidenizaslan@alidenizs-mac-mini.tail82cdd7.ts.net` → giriyor
- [ ] Telegram bot mesajları geliyor (zaten cellular'dan da gelmeli)

Hepsi yeşilse Korea operasyonu hazır. 🇰🇷
