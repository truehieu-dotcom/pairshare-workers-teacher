# PairShare cho giao vien - Cloudflare Workers + GitHub Storage

Ung dung nay cho phep giao vien:

- Tao 1 Pair ID de nhom tai lieu theo lop, mon hoc, hoac buoi hop
- Tu dong luu file <= 25MB len GitHub va > 25MB len Cloudflare R2
- Mo tren may khac bang cung Pair ID hoac link chia se
- Tai xuong file nhanh ngay tren giao dien web

## Diem moi so voi ban cu

- Chay tren **Cloudflare Workers**
- Frontend tinh duoc phuc vu cung Worker qua **static assets**
- Giao dien duoc remake theo huong de dung cho giao vien:
  - nut to, de bam
  - huong dan 3 buoc ro rang
  - khu keo tha file lon
  - cac mau Pair ID san co
  - danh sach file gon, de doc

## Cau truc du an

```text
pairshare-workers-teacher/
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  ├─ app.js
│  └─ favicon.svg
├─ src/
│  └─ index.js
├─ .dev.vars.example
├─ .gitignore
├─ package.json
├─ README.md
└─ wrangler.toml
```

## Cach hoat dong

- Frontend goi API noi bo cua Worker
- Worker dung GitHub REST API de:
  - ghi file <= 25MB vao GitHub theo duong dan `uploads/<PAIR_ID>/<timestamp>__<random>__<filename>`
  - ghi file > 25MB vao R2 theo key `uploads-r2/<PAIR_ID>/<timestamp>__<random>__<filename>`
  - doc hop nhat danh sach file tu GitHub + R2
  - tu dong don file R2 qua Cron sau 24h de tiet kiem storage

## Chuan bi GitHub

1. Tao 1 repository rieng, vi du `pairshare-storage`
2. Tao **Fine-grained Personal Access Token**
3. Cap quyen cho repo do:
   - `Contents: Read and write`
4. Luu token lai de nap vao Cloudflare secret

## Chuan bi Cloudflare Workers

### 1. Cai thu vien

```bash
npm install
```

### 2. Sua `wrangler.toml`

Thay cac gia tri sau:

```toml
[vars]
APP_NAME = "PairShare cho giao vien"
GITHUB_OWNER = "your-github-username-or-org"
GITHUB_REPO = "pairshare-storage"
GITHUB_BRANCH = "main"
MAX_FILE_MB = "50"
LARGE_FILE_THRESHOLD_MB = "25"
R2_RETENTION_HOURS = "24"
```

### 3. Tao bucket R2 + binding

Tao bucket R2 (vi du: `pairshare-temp-uploads`) va cap binding `R2_UPLOADS` trong `wrangler.toml`.

### 4. Tao secret cho production

```bash
npx wrangler secret put GITHUB_TOKEN
```

### 5. Tao file local de chay thu

```bash
cp .dev.vars.example .dev.vars
```

Sau do mo `.dev.vars` va thay bang token that.

## Chay local

```bash
npm run dev
```

## Deploy

```bash
npm run deploy
```

## Cac API chinh

### GET `/api/config`
Lay cau hinh giao dien

### GET `/api/files/:pairId`
Lay danh sach file cua Pair ID

### POST `/api/upload`
Tai nhieu file len storage tu dong (GitHub hoac R2 theo kich thuoc)

FormData:
- `pairId`
- `files` (co the nhieu gia tri)

### GET `/api/download?pairId=...&file=...&source=github|r2`
Tai 1 file ve tu GitHub hoac R2

## Luu y quan trong

- File `<= LARGE_FILE_THRESHOLD_MB` se duoc luu tren GitHub
- File `> LARGE_FILE_THRESHOLD_MB` se duoc luu tren Cloudflare R2
- Cac file lon tren R2 se duoc xoa tu dong sau `R2_RETENTION_HOURS` (mac dinh 24h) qua Cron trigger
- Dat `MAX_FILE_MB` lon hon nguong 25MB (vi du 50MB) de cho phep upload file lon

## Goi y Pair ID cho giao vien

- `TOAN-9A`
- `VAN-12B`
- `HOP-GV`
- `KHTN-8C`
- `CHUYENDE-ANH`

## Nang cap tiep theo

- Them mat khau cho tung Pair ID
- Them nut xoa file
- Them ghi chu cho moi tai lieu
- Them han su dung file
- Chuyen storage sang R2 de hoi file lon hon va chi phi hop ly hon
