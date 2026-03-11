# PairShare cho giao vien - Cloudflare Workers + GitHub + Backblaze B2

Ung dung nay cho phep giao vien:

- Tao 1 Pair ID de nhom tai lieu theo lop, mon hoc, hoac buoi hop
- Tai nhieu file cung luc len kho luu tru GitHub
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
  - ghi file vao repo theo duong dan `uploads/<PAIR_ID>/<timestamp>__<random>__<filename>`
  - doc danh sach file theo Pair ID
  - tai file ve qua endpoint raw content
- Worker dung Backblaze B2 cho file lon hon nguong GitHub (mac dinh 25MB)

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
MAX_FILE_MB = "20"
GITHUB_MAX_FILE_MB = "25"
B2_BUCKET_NAME = "your-b2-bucket-name"
B2_BUCKET_ID = "your-b2-bucket-id"
```

Them 2 secret cho Backblaze:

```bash
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
```

### 3. Tao secret cho production

```bash
npx wrangler secret put GITHUB_TOKEN
```

### 4. Tao file local de chay thu

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
Tai nhieu file len storage:

- file `<= GITHUB_MAX_FILE_MB` se luu tren GitHub
- file `> GITHUB_MAX_FILE_MB` se luu tren Backblaze B2

FormData:
- `pairId`
- `files` (co the nhieu gia tri)

### GET `/api/download?pairId=...&file=...`
Tai 1 file ve tu GitHub

## Luu y quan trong

- GitHub co gioi han de xuat khoang 25MB/file khi upload qua API o app nay
- File lon hon nguong do se duoc day sang Backblaze B2 neu da cau hinh
- Nen giu `MAX_FILE_MB` o muc hop ly, vi du 50 - 200 MB tuy nhu cau

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
