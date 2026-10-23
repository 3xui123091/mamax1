# MAMAX — پنل مدیریت روی Cloudflare Pages

پنل مدیریت کاربر، حجم، انقضا، کانفیگ و Subscription که **فقط روی Cloudflare** اجرا می‌شود
(Pages + Pages Functions + D1). نیازی به VPS، Docker یا سرور بیرونی نیست و هیچ فایلی را لازم نیست ویرایش کنید.

---

## این پروژه دقیقاً چه کاری می‌کند؟ (صادقانه)

| بخش | وضعیت |
|---|---|
| پنل ادمین، کاربران، حجم، انقضا، Subscription، QR، صفحه‌ی کاربر | کامل و واقعی (D1) |
| پروکسی | **VLESS روی WebSocket (+TLS)** داخل خود Pages Function (`/ws`) |
| حسابداری ترافیک | **واقعی**: بایت‌های Upload/Download همین Worker شمرده و در D1 ذخیره می‌شود |
| قطع دسترسی | هنگام اتصال بررسی می‌شود (غیرفعال / منقضی / اتمام حجم) و حین اتصال هم هر چند ثانیه دوباره چک می‌شود |
| UDP | فقط **DNS** (از طریق DoH). UDP عمومی (QUIC, بازی, VoIP) روی Cloudflare Workers ممکن نیست |
| Reality / XTLS / TCP خام / Trojan / VMess / Mux | **پشتیبانی نمی‌شود** (Cloudflare Pages فقط HTTP/WebSocket می‌پذیرد و روی پورت دلخواه Listen نمی‌کند). در کلاینت Mux را خاموش کنید |
| پورت‌ها | فقط پورت‌هایی که Cloudflare پروکسی می‌کند: TLS ← 443, 8443, 2053, 2083, 2087, 2096 ؛ بدون TLS ← 80, 8080, 8880, 2052, 2082, 2086, 2095. پنل پورت‌های دیگر را رد می‌کند |

**نکات دقت ترافیک:** شمارش بر اساس Payload عبوری از Worker است؛ سربار TLS/WebSocket شمرده نمی‌شود، پس ممکن است چند درصد با عدد کلاینت فرق کند.
مصرف هر چند ثانیه یک‌بار در D1 ثبت می‌شود؛ اگر کاربر هم‌زمان از چند Isolate/منطقه وصل باشد، ممکن است چند ده مگابایت بیشتر از سقف مصرف کند قبل از قطع‌شدن.

**KV استفاده نشده؛ عمداً.** KV «Eventually Consistent» است و برای اعمال دقیق حجم/انقضا مناسب نیست؛ Session، Rate-limit و ترافیک همه در D1 هستند.

**هشدار شرایط Cloudflare:** Cloudflare در شرایط استفاده‌اش محدودیت‌هایی روی عبور ترافیک حجیم/پروکسی از Workers/Pages دارد و ممکن است حساب را محدود کند. مسئولیت استفاده با شماست؛ شرایط فعلی Cloudflare را بخوانید. پلن‌های رایگان محدودیت درخواست روزانه و زمان CPU دارند (برای کاربر زیاد پلن Workers Paid توصیه می‌شود).

---

## نصب مرحله‌به‌مرحله

### STEP 1 — ساخت GitHub Repository
در github.com ← **New repository** ← نام دلخواه (مثلاً `mamax`) ← **Private** ← Create.

### STEP 2 — آپلود فایل‌ها
ZIP را Extract کنید. در صفحه‌ی ریپازیتوری **Add file → Upload files** بزنید و **محتوای داخل پوشه** (`package.json`, `README.md`, `functions/`, `public/`, `migrations/`, …) را بکشید و **Commit changes** بزنید.
دقت: `package.json` باید در ریشه‌ی ریپازیتوری باشد، نه داخل یک پوشه‌ی اضافه.

### STEP 3 — ساخت پروژه Cloudflare Pages
وارد dash.cloudflare.com شوید ← **Workers & Pages** ← **Create application** ← تب **Pages** ← **Connect to Git**.

### STEP 4 — اتصال به GitHub
**Connect GitHub** و اجازه‌ی دسترسی به ریپازیتوری را بدهید.

### STEP 5 — انتخاب Repository
ریپازیتوری `mamax` را انتخاب و **Begin setup** بزنید. نام پروژه (مثلاً `mamax`) آدرس `mamax.pages.dev` را می‌سازد.

### STEP 6 — Build Settings (دقیقاً این‌ها)
| فیلد | مقدار |
|---|---|
| Framework preset | **None** |
| Build command | **خالی بگذارید** |
| Build output directory | **public** |
| Root directory (advanced) | **خالی** (یعنی ریشه‌ی ریپازیتوری) |
| Node version | پیش‌فرض کافی است (۱۸ یا بالاتر). اگر خواستید متغیر `NODE_VERSION=20` بگذارید |

هنوز **Save and Deploy** نزنید، یا اگر زدید مشکلی نیست (بعد از اتصال دیتابیس دوباره Deploy می‌شود).

### STEP 7 — ساخت D1 Database
**Workers & Pages → D1 SQL Database → Create** ← نام: `mamax-db` ← Create.

### STEP 8 — Migration (اختیاری، پنل خودکار انجام می‌دهد)
پنل در اولین درخواست همه‌ی جدول‌ها را خودش می‌سازد. اگر می‌خواهید دستی هم بسازید: در D1 ← تب **Console** ← محتوای `migrations/0001_initial.sql` را Paste و **Execute** بزنید (امن است؛ همه‌ی دستورها `IF NOT EXISTS` هستند).

### STEP 9 — اتصال D1 به Pages
پروژه‌ی Pages ← **Settings → Bindings** (یا Functions) ← **Add → D1 database**
- Variable name: **`DB`** (دقیقاً همین، حروف بزرگ)
- D1 database: `mamax-db`

این کار را برای **Production** انجام دهید (و برای Preview هم اگر خواستید).

### STEP 10/11 — KV
**لازم نیست.** رد شوید.

### STEP 12 — Compatibility date و Environment Variables
- **Settings → Runtime → Compatibility date** را روی `2024-09-23` یا جدیدتر بگذارید (Production).
- متغیرها همه اختیاری‌اند (فهرست در `.env.example`). برای شروع هیچ‌کدام لازم نیست.

### STEP 13 — Deploy
**Deployments** ← روی آخرین Deployment **Retry deployment** (یا یک Commit جدید بزنید) تا Bindingها اعمال شوند.

### STEP 14 — باز کردن پنل
آدرس `https://NAME.pages.dev` را باز کنید. صفحه‌ی ورود MAMAX نمایش داده می‌شود.
اگر پیام «اتصال دیتابیس تنظیم نشده» دیدید، STEP 9 و 13 را بررسی کنید.

### STEP 15 — ورود
Username: `admin` — Password: `admin`

### STEP 16 — تغییر رمز عبور
**Settings → Security**: رمز فعلی (`admin`) + نام کاربری/رمز جدید (حداقل ۸ کاراکتر). تا تغییر ندهید هشدار «برای امنیت بیشتر رمز عبور پیش‌فرض را تغییر دهید.» نمایش داده می‌شود.

### STEP 17 — ساخت اولین Config و User
1. **Configs → Add Config**: نام (مثل `MAMAX-01`)، پورت `443` و TLS روشن. Address/SNI/Host را خالی بگذارید تا از دامنه‌ی پنل استفاده شود.
2. **Add User**: نام، حجم، انقضا را انتخاب و Create بزنید.

### STEP 18 — Subscription
در **Subscriptions** (یا منوی Actions کاربر) لینک `https://دامنه/sub/TOKEN` را Copy یا QR بگیرید و در v2rayN / v2rayNG / Hiddify / Streisand / NekoBox به‌عنوان Subscription اضافه کنید. صفحه‌ی عمومی کاربر: `https://دامنه/user/TOKEN`.

### STEP 19 — دامنه‌ی اختصاصی
پروژه ← **Custom domains → Set up a custom domain** ← دامنه (باید در Cloudflare باشد). بعد از فعال‌شدن، **پنل را با همان دامنه باز کنید** تا لینک‌های Subscription با دامنه‌ی جدید ساخته شوند (یا `PUBLIC_URL` را تنظیم کنید).
دامنه‌ی `*.pages.dev` ممکن است در بعضی شبکه‌ها فیلتر باشد؛ برای پایداری دامنه‌ی اختصاصی بهتر است.

---

## نکات کیفیت و سرعت
- پورت **443 + TLS + WebSocket** پایدارترین حالت است. **Early Data (0-RTT)** به‌طور پیش‌فرض روشن است و اتصال اول را سریع‌تر می‌کند.
- Address را می‌توان روی یک **IP تمیز Cloudflare** گذاشت (SNI و Host روی دامنه‌ی خودتان بماند) تا مسیر اتصال کاربر بهتر شود؛ این بخش سمت شبکه‌ی کاربر است و به اپراتور بستگی دارد (مثلاً کانفیگ‌های جدا برای MTN / MCI / WIFI بسازید).
- Fingerprint = `chrome` و ALPN = `http/1.1` مناسب‌ترین پیش‌فرض WebSocket است.
- سقف سرعت را خود Cloudflare Workers و مسیر شبکه تعیین می‌کند؛ هیچ پنلی نمی‌تواند از آن بالاتر برود.
- اگر مقصدی (مثلاً سایت‌های پشت Cloudflare) مستقیم باز نشد، `PROXY_IP` را در Variables تنظیم کنید.

## امنیت
هش رمز PBKDF2-SHA256 · نشست تصادفی با کوکی `HttpOnly; Secure; SameSite=Strict` (+ پیشوند `__Host-`) · توکن CSRF و بررسی Origin · محدودیت تلاش ورود (۸ بار/۱۵ دقیقه) · توکن‌های Subscription تصادفی ۲۵۶بیتی (UUID هرگز در URL عمومی نیست) · Queryهای پارامتری D1 · Escape کامل HTML.

## عیب‌یابی سریع
| مشکل | راه‌حل |
|---|---|
| صفحه‌ی ورود پیام دیتابیس می‌دهد | STEP 9: Binding با نام `DB` + Retry deployment |
| خطای ۱۱۰۲ هنگام ورود (پلن رایگان) | متغیر `PBKDF2_ITERATIONS=20000` |
| اتصال کلاینت برقرار نمی‌شود | پورت/TLS را چک کنید؛ Mux خاموش؛ دامنه فعال و Orange-cloud باشد |
| Subscription دامنه‌ی اشتباه دارد | پنل را با دامنه‌ی درست باز کنید یا `PUBLIC_URL` بگذارید |
| QR نمایش داده نمی‌شود | کتابخانه‌ی QR از cdnjs بارگذاری می‌شود؛ اینترنت/فیلتر را بررسی کنید (لینک متنی همچنان کپی‌شدنی است) |

## ساختار پروژه
```
public/        رابط کاربری (HTML/CSS/JS) و صفحات 403/404/500
functions/api  API مدیریتی (/api/*)
functions/ws   پروکسی VLESS (/ws)
functions/sub  Subscription (/sub/TOKEN)
functions/user صفحه‌ی عمومی کاربر (/user/TOKEN)
functions/_lib اسکیمای D1، احراز هویت، پروتکل، حسابداری
migrations/    0001_initial.sql  (تولیدشده از functions/_lib/schema.js با npm run migration)
```
فایل `wrangler.toml` عمداً وجود ندارد: در Pages اگر چنین فایلی باشد، تنظیمات Binding داشبورد قفل می‌شود و دیگر نمی‌توانید بدون ویرایش کد تنظیم کنید.
