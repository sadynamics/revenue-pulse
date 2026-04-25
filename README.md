# Revenue Pulse ⚡

RevenueCat benzeri, gerçek zamanlı abonelik analitik dashboard'u — **veriyi doğrudan Apple App Store Server Notifications V2**'den alır. RevenueCat gibi bir aracı servise ihtiyaç yok.

Webhook'lar JWS olarak gelir, imzası doğrulanır, içindeki `signedTransactionInfo` ve `signedRenewalInfo` decode edilir, kendi generic event modelimize map edilir ve dashboard'a real-time olarak yansıtılır.

## Özellikler

- **✅ Anlık subscriber bildirimleri** – Server-Sent Events (SSE) üzerinden canlı toast + feed
- **✅ Renewal geçmişi** – Tüm yenilemeler, filtreli tablo, gelir toplamı
- **✅ Subscriber timeline** – Her kullanıcının tam lifecycle event geçmişi
- **✅ MRR / Churn takibi** – Günlük MRR serisi, churn oranı, nedenleri
- **✅ Aktif subscriber sayısı** – Gerçek zamanlı güncellenen KPI

### Ekstra (bonus) özellikler

- **📈 ARR, Net Revenue, Avg LTV** hesapları
- **🎯 Trial conversion rate** – Intro FREE_TRIAL → paid dönüşüm oranı
- **💸 Refund tracking** – Apple REFUND notification'ı, LTV'den düşülür
- **🏷️ Product breakdown** – Ürün bazlı subscriber & gelir dağılımı
- **🏬 Store & storefront breakdown** – App Store + storefront (ülke) dağılımı
- **🌍 Geographic distribution** – ISO 3166-1 alpha-3 storefront → 2-harfli ülke kodu
- **📅 Upcoming renewals** – 7 gün içinde yenilenecek abonelikler (renewalInfo.renewalDate)
- **🏆 Top subscribers** – LTV'ye göre en değerli kullanıcılar
- **🧪 Webhook debug** – Decode edilmiş raw Apple payload görüntüleyici + test event gönderimi
- **🔐 JWS signature verification** – x5c zinciri doğrulaması, opsiyonel Apple Root CA kontrolü
- **📡 Idempotent ingest** – Aynı `notificationUUID` duplicate olarak işaretlenir
- **🔁 Apple-spesifik alanlar** – `originalTransactionId`, `webOrderLineItemId`, `appAccountToken`
- **📜 Transaction history backfill** – Yeni bir kullanıcı görüldüğünde, App Store Server API üzerinden tüm geçmiş satın alımları (yenilemeler, iade, lifetime, consumable) **otomatik** çekilir. Manuel "Sync from App Store" butonu ve `npm run backfill` da mevcut.
- **🛰 Drift detection** – Subscriber modalında local state vs Apple canlı state karşılaştırması (`autoRenewStatus`, `expiresDate`) ve drift uyarıları
- **🛠 Daily reconcile job** – Aktif kullanıcıları periyodik tarayıp kaçan `EXPIRATION` / `CANCELLATION` / `REFUND` event'lerini otomatik düzeltir
- **🧪 Apple test notification trigger** – Dashboard'dan doğrudan App Store Server API `notifications/test` çağrısı (Sandbox/Production seçimi)
- **📦 Multi-app desteği** – Aynı dashboard'dan birden fazla uygulamayı izleme. Webhook'lar `bundleId`'ye göre otomatik route edilir; UI üst barındaki **App** dropdown'undan filtre. Her app kendi App Store Server API credential'larını kullanır.

## Mimari

```
App Store  ──POST signedPayload──►  /webhook  ──►  JWS verify + decode
                                                        │
                                                        ├─ signedTransactionInfo decode
                                                        ├─ signedRenewalInfo decode
                                                        ├─ mapNotification() → internal event
                                                        │
                                                        ├──► SQLite (events + subscribers + notifications)
                                                        └──► EventBus → SSE → Dashboard (canlı toast)
```

**Kullanıcı kimliği:** Apple size `appAccountToken` verir (müşteri app'i satın alırken uygulamanızın belirlediği UUID). Uygulamanız `StoreKit 2`'nin `Product.PurchaseOption.appAccountToken(...)` yöntemini kullanmalıdır. Yoksa fallback olarak `originalTransactionId` identifier olarak kullanılır.

## Kurulum

```bash
npm install
cp .env.example .env
# .env dosyasını düzenle: APPSTORE_BUNDLE_ID, APPSTORE_ENVIRONMENT, ...
npm run seed        # 90 günlük demo data üret (opsiyonel)
npm run dev         # http://localhost:3000
```

Canlı notification simülatörü (başka bir terminalden):

```bash
npm run simulate -- --interval 3000
```

## Multi-app (birden fazla uygulamayı tek panelden izleme)

Aynı dashboard'dan birden fazla uygulama takip edebilirsiniz. Tek webhook URL'si tüm app'ler için kullanılır; gelen notification içindeki `data.bundleId` değeri ile doğru app'e route edilir.

### Konfigürasyon

Apple App Store Server API key'i Developer team'ine bağlıdır — aynı team'deki tüm app'ler için **tek bir credential set'i** yeterli. O yüzden tipik kurulum şöyledir:

1. **Bir kere** `APPSTORE_ISSUER_ID` / `APPSTORE_KEY_ID` / `APPSTORE_PRIVATE_KEY` (veya `APPSTORE_PRIVATE_KEY_PATH`) env'lerini doldurun.
2. **Her app için** sadece `id` + `bundle_id` (+ opsiyonel `name`/`environment`) listeleyin:

```bash
APPS_CONFIG='[
  {"id":"myapp",   "name":"MyApp",      "bundle_id":"com.acme.myapp"},
  {"id":"otherapp","name":"OtherApp",   "bundle_id":"com.acme.other","environment":"Sandbox"}
]'
```

Bu kadar — credential'lar otomatik tüm app'lere paylaştırılır.

#### Per-app override (farklı team'deki app'ler için)

Bir app farklı bir Developer team'indeyse, sadece o app için `issuer_id` / `key_id` / `private_key` (veya `private_key_path`) ekleyebilirsiniz:

```bash
APPS_CONFIG='[
  {"id":"myapp", "bundle_id":"com.acme.myapp"},
  {
    "id": "otherteam-app",
    "bundle_id": "com.otherteam.app",
    "issuer_id": "11111111-1111-1111-1111-111111111111",
    "key_id": "ZZZZZZ9999",
    "private_key": "-----BEGIN PRIVATE KEY-----\nMIG...\n-----END PRIVATE KEY-----\n"
  }
]'
```

Per-app alanlar (referans):

| Alan | Zorunlu | Açıklama |
|---|---|---|
| `id` | ✅ | İçeride kullanılan kararlı kimlik (URL-safe, kısa). |
| `bundle_id` | ✅ | Apple bundle identifier — webhook routing key'i. |
| `name` | — | UI'da görünecek isim (default = `id`). |
| `environment` | — | `Production` / `Sandbox` (default `Production`). |
| `issuer_id`, `key_id` | — | App Store Server API credential override. Yoksa global `APPSTORE_*` env kullanılır. |
| `private_key` | — | `.p8` PEM içeriği (newline'lar `\n` literal olabilir). |
| `private_key_path` | — | `.p8` dosya yolu. `private_key` veya bu — ikisinden biri yeterli. |

### Eski tek-app ayarı (geriye uyumluluk)

`APPS_CONFIG` set edilmezse eski `APPSTORE_BUNDLE_ID` / `APPSTORE_ENVIRONMENT` / `APPSTORE_ISSUER_ID` / `APPSTORE_KEY_ID` / `APPSTORE_PRIVATE_KEY[_PATH]` değişkenleri okunur ve default app olarak yüklenir. Yani tek app kullanan mevcut deploy'lar hiçbir şey değiştirmek zorunda değil.

### Webhook routing & strict mode

- Apple `signedPayload` decode edilir, içindeki `data.bundleId` ile `APPS_CONFIG`'teki `bundle_id` eşleşir.
- Eşleşme yoksa **default app**'e (registry'deki ilk app) düşer ve `[webhook] unknown bundleId ... falling back to default` warning loglanır.
- Bilinmeyen bundle'lardan gelen webhook'ları reddetmek için `STRICT_BUNDLE_ID=true` set edin (HTTP 400 döner).
- App Store Connect'te her uygulamada aynı webhook URL'i kullanılabilir, çünkü routing payload içeriğinden yapılır.

### UI

Dashboard üst barında bir **App** dropdown'u görünür. Birden fazla app varsa:

- **All apps** → tüm metrikler agregate.
- Tek app seçilirse → KPI, subscriber listesi, daily revenue, MRR, breakdown'lar, event feed ve canlı SSE stream tamamen o `app_id` ile filtrelenir. Seçim `localStorage`'da tutulur.

### Scriptler

```bash
# Tek app için backfill
npm run backfill -- --app myapp-prod

# Tüm konfigüre app'ler için backfill
npm run backfill

# Tek app için reconcile
npm run reconcile -- --app myapp-prod

# Belirli bir app'e doğru webhook simulator
npm run simulate -- --app myapp-sandbox --bundle com.acme.myapp.sandbox
```

### API filtresi

Tüm read endpoint'leri opsiyonel `app_id` query parametresi alır:

```
GET /api/metrics?app_id=myapp-prod
GET /api/subscribers?app_id=myapp-prod&q=...
GET /api/daily?days=30&app_id=myapp-prod
GET /sse/stream?app_id=myapp-prod
```

`GET /api/apps` konfigüre edilen tüm app'lerin listesini döner (UI dropdown'u bunu kullanır).

## App Store Connect'te webhook ayarı

1. https://appstoreconnect.apple.com → uygulamanızı seçin.
2. **App Information** → scroll → **App Store Server Notifications**.
3. **Production Server URL**: `https://<your-railway-app>.up.railway.app/webhook`
4. **Sandbox Server URL**: aynı URL'i ya da test için farklı bir deploy.
5. **Version**: **Version 2** seçin (bu dashboard yalnızca v2 destekler).

Apple imzalı (JWS) bir POST atar:

```json
{ "signedPayload": "eyJhbGciOiJFUzI1NiIsIng1YyI6WyIu..." }
```

## JWS signature verification

Varsayılan olarak imza **doğrulanır**: JWS header'daki `x5c` zincirinin ilk sertifikasının public key'i ile imza ES256 ile verify edilir.

### Apple Root CA ile tam zincir doğrulaması (önerilen)

1. İndir: https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
2. PEM'e çevir:

   ```bash
   mkdir -p certs
   openssl x509 -inform der -in AppleRootCA-G3.cer -out certs/AppleRootCA-G3.pem
   ```
3. `.env`'de:

   ```
   APPLE_ROOT_CERT_PATH=./certs/AppleRootCA-G3.pem
   ```

### Dev/test ortamında doğrulamayı atlama

```
APPSTORE_SKIP_VERIFICATION=true
```

Bu durumda sadece JWS decode edilir, imza doğrulanmaz. Prod'da **asla** açık olmamalı.

## Transaction history backfill (App Store Server API)

Webhook'lar **sadece olduğu anda gerçekleşen olayı** anlatır. Bir kullanıcı dashboard'a webhook ile geldiğinde, geçmişteki tüm satın alımlarını da görmek için Apple'ın **App Store Server API**'sine bağlanırız.

Bu sayede:

- Yeni bir abone webhook ile geldiğinde geçmiş tüm transaction'ları (lifetime, consumable, eski yenilemeler, eski iade'ler dahil) otomatik dolar.
- Subscriber detay panelinde **🔄 Sync from App Store** butonu o kullanıcının geçmişini bir kez daha senkronlar.
- Webhook Debug sayfasındaki **🔁 Backfill all users** butonu DB'deki tüm kullanıcıları toplu senkronlar.
- `npm run backfill` ile sunucu tarafında aynı işlem yapılabilir (`-- --user <txId>` ile tek kullanıcı).

### API Key oluşturma (1 dakika)

1. https://appstoreconnect.apple.com → **Users and Access** → **Integrations** sekmesi.
2. Sol menüden **In-App Purchase** → **Generate API Key (+)**.
3. Bir isim ver, **Generate**'a bas.
4. Listeden:
   - **Key ID**'yi kopyala (10 karakterli kod).
   - **Issuer ID**'yi kopyala (sayfanın üstünde, UUID).
   - **Download API Key**'e basıp `.p8` dosyasını indir. **Bir kere indirilebilir, kaybedersen yeni key oluşturmak zorundasın.**

### Environment variables

```bash
APPSTORE_ISSUER_ID=00000000-0000-0000-0000-000000000000
APPSTORE_KEY_ID=ABCDEF1234

# .p8 PEM içeriğini direkt env'e koy (Railway'de en kolayı):
APPSTORE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIG...\n-----END PRIVATE KEY-----\n"

# veya dosya yolu:
# APPSTORE_PRIVATE_KEY_PATH=/app/certs/AuthKey_ABCDEF1234.p8
```

> Railway'de PEM string'i kopyalarken newline'ları `\n` literal olarak yaz; uygulama içinde tekrar satır sonlarına çevriliyor.

Reconcile scheduler ayarları:

```bash
APPSTORE_RECONCILE_ENABLED=true
APPSTORE_RECONCILE_INTERVAL_HOURS=24
APPSTORE_RECONCILE_BATCH_LIMIT=200
```

Konfigüre edilmediği sürece:

- Webhook'lar normal çalışır, **dashboard hiçbir geriye dönük veri görmez** — sadece deploy sonrası gelen event'ler işlenir.
- Subscriber paneli **App Store API not configured** uyarısı gösterir.

### Desteklenen transaction tipleri

History endpoint'i tüm IAP tiplerini döner:

- `Auto-Renewable Subscription` → `INITIAL_PURCHASE` veya `RENEWAL`
- `Non-Renewing Subscription` → `NON_RENEWING_PURCHASE`
- `Non-Consumable` (lifetime) → `NON_RENEWING_PURCHASE`
- `Consumable` (örn. coin paketi) → `NON_RENEWING_PURCHASE`
- `revocationDate` set ise → `REFUND`

İdempotent: aynı `transactionId` zaten DB'de varsa atlanır. Aynı kullanıcıyı sürekli senkronlamak güvenlidir.

## Desteklenen Apple notification tipleri

| Apple `notificationType` | `subtype` | İç event |
|---|---|---|
| `SUBSCRIBED` | `INITIAL_BUY` | `INITIAL_PURCHASE` |
| `SUBSCRIBED` | `RESUBSCRIBE` | `UNCANCELLATION` |
| `DID_RENEW` | — / `BILLING_RECOVERY` | `RENEWAL` |
| `DID_CHANGE_RENEWAL_STATUS` | `AUTO_RENEW_DISABLED` | `CANCELLATION` |
| `DID_CHANGE_RENEWAL_STATUS` | `AUTO_RENEW_ENABLED` | `UNCANCELLATION` |
| `DID_CHANGE_RENEWAL_PREF` | `UPGRADE` / `DOWNGRADE` / — | `PRODUCT_CHANGE` |
| `DID_FAIL_TO_RENEW` | — / `GRACE_PERIOD` | `BILLING_ISSUE` |
| `EXPIRED` | `VOLUNTARY` / `BILLING_RETRY` / `PRICE_INCREASE` / `PRODUCT_NOT_FOR_SALE` | `EXPIRATION` |
| `GRACE_PERIOD_EXPIRED` | — | `EXPIRATION` |
| `REFUND` | — | `REFUND` |
| `REFUND_DECLINED` | — | `REFUND_DECLINED` |
| `REFUND_REVERSED` | — | `REFUND_REVERSED` |
| `REVOKE` | — | `EXPIRATION` (family sharing) |
| `RENEWAL_EXTENDED` / `RENEWAL_EXTENSION` | — | `SUBSCRIPTION_EXTENDED` |
| `OFFER_REDEEMED` | çeşitli | duruma göre `INITIAL_PURCHASE` / `PRODUCT_CHANGE` / `UNCANCELLATION` |
| `PRICE_INCREASE` | `PENDING` / `ACCEPTED` | `PRICE_INCREASE_CONSENT` |
| `ONE_TIME_CHARGE` | — | `NON_RENEWING_PURCHASE` (Non-consumable) |
| `TEST` | — | `TEST` |

## Railway'e deploy

1. Bu repoyu GitHub'a pushla.
2. Railway → **New Project** → **Deploy from GitHub** → repoyu seç.
3. Environment variables:
   - **Tek app:** `APPSTORE_BUNDLE_ID=com.senin.app`, `APPSTORE_ENVIRONMENT=Production`
   - **Çoklu app:** `APPS_CONFIG='[{"id":"app1",...},{"id":"app2",...}]'` (yukarıdaki Multi-app bölümüne bak)
   - `APPSTORE_SKIP_VERIFICATION=false`
   - `STRICT_BUNDLE_ID=false` (true → bilinmeyen bundle'ları reject et)
   - `DASHBOARD_USER=admin`
   - `DASHBOARD_PASS=strongpass`
   - `DB_PATH=/data/revenue.db`  *(volume kalıcılığı için)*
   - (opsiyonel) `APPLE_ROOT_CERT_PATH=/app/certs/AppleRootCA-G3.pem` + cert'i repoya commit et.
4. **Volumes** sekmesinden `/data`'ya volume bağla.
5. Deploy. Health check: `/healthz`.
6. App Store Connect'te her uygulamada aynı webhook URL'i kullanın — routing payload içeriğinden otomatik yapılır.

## Endpoint'ler

| Endpoint | Açıklama |
|---|---|
| `POST /webhook`                   | Apple signedPayload kabul eder (JWS verify edilir, bundleId → app routing) |
| `POST /webhook/test`              | Dev test — imza olmadan decoded notification ya da internal event kabul eder (`?app_id=` ile override) |
| `GET  /sse/stream?app_id=`        | Canlı bildirim akışı (SSE), opsiyonel app filtresi |
| `GET  /api/apps`                  | Konfigüre edilen tüm app'lerin listesi (UI dropdown'u için) |
| `GET  /api/config`                | App Store Server API konfig durumu (seçili app için) |
| `POST /api/subscribers/:id/sync`  | Kullanıcının tüm geçmiş transaction'larını Apple'dan çek + ingest et |
| `GET  /api/subscribers/:id/apple-status` | Apple canlı state + local state drift analizi (`has_drift`, issue listesi) |
| `POST /api/appstore/test-notification` | Apple'a TEST notification gönderimini tetikler (Sandbox/Production) |
| `GET  /api/appstore/test-notification/:token` | Gönderilen test notification sonucunu poll eder |
| `POST /api/reconcile/run`         | Reconcile job'ı manuel tetikler |
| `GET  /api/reconcile/status`      | Son reconcile run sonucunu döner |
| `GET  /api/metrics`               | Güncel KPI'lar |
| `GET  /api/daily?days=30`         | Günlük gelir/refund/net + sandbox/production kırılımı |
| `GET  /api/mrr-history?days=30`   | Günlük MRR snapshot'ları |
| `GET  /api/subscribers?q=&status=`| Subscriber listesi |
| `GET  /api/subscribers/:id`       | Subscriber + event timeline |
| `GET  /api/events?type=`          | Tüm event'ler |
| `GET  /api/events/:id`            | Event detay + raw JSON |
| `GET  /api/renewals`              | Sadece RENEWAL event'leri |
| `GET  /api/products`              | Ürün breakdown |
| `GET  /api/countries`             | Storefront/ülke breakdown |
| `GET  /api/stores`                | Store breakdown |
| `GET  /api/churn-reasons`         | Churn sebepleri (90d) |
| `GET  /api/top-subscribers`       | LTV'ye göre TOP kullanıcılar |
| `GET  /api/upcoming-renewals`     | 7 gün içinde yenilenecekler |
| `GET  /api/notifications`         | Son 50 bildirim |
| `GET  /api/summary`               | Overview için toplu response |
| `GET  /healthz`                   | Health check |

> Read endpoint'lerinin tamamı (metrics, subscribers, events, daily, mrr-history, products, countries, stores, churn-reasons, top-subscribers, upcoming-renewals, notifications, summary, renewals) opsiyonel `?app_id=<id>` query parametresini kabul eder. Verilmezse tüm app'ler için agregate sonuç döner.

## Sınırlamalar / notlar

- **Geçmiş veriye erişim** App Store Server API entegrasyonu ile mümkündür (yukarıdaki bölüm). Konfigüre edilmediği sürece webhook'lar sadece "şu anda olan" event'leri görür.
- **Reconcile job** aktif kullanıcılar için çalışır; çok büyük datasetlerde batch boyutunu düşürerek API rate-limit riskini azaltın.
- **MRR hesabı için period_type tahmini:** Apple `DID_RENEW` notification'ında ürünün periyodunu direkt söylemez. `transaction.type` ve `expiresDate - purchaseDate` farkından tahmin ederiz (weekly/monthly/quarterly/annual). Daha kesin sonuç için `APP_STORE_CONNECT_API` üzerinden product config çekebilirsiniz (isteğe bağlı genişletme).
- **Kısmi refund desteklenmez** — Apple notification'ında refund her zaman full transaction iadesidir.
- **Family sharing:** `inAppOwnershipType === 'FAMILY_SHARED'` durumu event'te `is_family_share=1` olarak işaretlenir.
- **MRR dönüşümü:** `price` milli-units'dan major unit'e çevrilir, ardından `toUsd()` ile FX tablosu üzerinden USD'ye çevrilir. Prod'da canlı FX API önerilir (`src/services/fx.js`).

## Lisans

MIT
