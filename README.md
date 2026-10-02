# Rekap Durasi Kerja

Web sederhana untuk mencatat durasi kerja per orang pada dua proses produksi:

1. **Proses 1** - Draft PO sampai selesai migrasi
2. **Proses 2** - Proses PO reserved CO dan selesai picklist

Setiap entri berisi nama, jumlah line, tanggal (otomatis terisi hari ini), dan jam mulai serta jam selesai tiap proses. Durasi dihitung otomatis dari selisih jam. Semua entri langsung tampil di tabel bawah, bisa difilter per tanggal dan per nama, lalu diunduh sebagai Excel.

## Isi folder

```
index.html            Halaman utama
styles.css            Tampilan
app.js                Logika aplikasi
config.js             Tempat menempelkan URL backend (lihat di bawah)
apps-script/Code.gs   Backend Google Sheets (opsional)
.nojekyll             Agar GitHub Pages tidak memproses file dengan benar
```

## Dua mode penyimpanan

**Mode lokal (default).** Kalau `config.js` dibiarkan kosong, data disimpan di browser masing-masing pengguna (localStorage). Cocok untuk uji coba dan pemakaian satu orang. Data tidak terbagi antar pengguna.

**Mode Google Sheets.** Kalau beberapa orang harus mengisi satu data yang sama, sambungkan ke Google Sheets lewat Apps Script. Data tersimpan di spreadsheet, semua orang melihat isi yang sama, dan hasilnya juga tetap bisa diunduh sebagai Excel.

## Menyiapkan backend Google Sheets

1. Buat satu Google Spreadsheet baru. Nama file bebas, sheet penampung akan dibuat otomatis.
2. Buka **Extensions - Apps Script**.
3. Hapus isi `Code.gs`, lalu tempel seluruh isi dari `apps-script/Code.gs` di repo ini, lalu simpan.
4. Klik **Deploy - New deployment**.
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Klik **Deploy**, izinkan akses saat diminta, lalu salin **Web app URL** (diakhiri `/exec`).
6. Buat token akses: buka **Project Settings (ikon gerigi) - Script properties**, tambahkan
   property baru: Name `RDK_TOKEN`, Value bebas (disarankan 32 karakter acak, misalnya
   hasil `openssl rand -hex 16`), lalu **Save property**.
7. Buka `config.js`, tempel URL tadi dan **token yang sama persis**, lalu simpan:

   ```js
   window.APP_CONFIG = {
     API_URL: "https://script.google.com/macros/s/XXXXXXXX/exec",
     TOKEN: "32-karakter-acak-sama-dengan-rdk_token"
   };
   ```

   Tanpa token yang sama, backend menolak semua request dengan pesan
   *Token backend belum diatur* atau *Token tidak valid*.

8. Setiap kali `Code.gs` diubah, lakukan **Deploy - Manage deployments - Edit - Version: New version - Deploy** supaya perubahan ikut aktif.

Di halaman akan tampil status **Tersambung Google Sheets** kalau URL sudah benar.

## Menjalankan lokal

Buka `index.html` langsung di browser, atau jalankan server statis:

```
python -m http.server 8000
```

lalu buka `http://localhost:8000`.

## Upload ke GitHub Pages

1. Buat repository baru di GitHub.
2. Push semua file di folder ini ke repository tersebut:

   ```
   git init
   git add .
   git commit -m "Rekap durasi kerja"
   git branch -M main
   git remote add origin https://github.com/USERNAME/NAMA-REPO.git
   git push -u origin main
   ```

3. Di GitHub, buka **Settings - Pages**.
4. Bagian **Build and deployment**, Source: **Deploy from a branch**, Branch: **main**, folder **/ (root)**, lalu **Save**.
5. Tunggu sebentar, situs aktif di `https://USERNAME.github.io/NAMA-REPO/`.

## Catatan

- Jam yang melewati tengah malam (misal 22:00 sampai 01:00) dihitung sebagai 3 jam.
- Total durasi per proses dan total keseluruhan muncul di baris bawah tabel, dan ikut terbawa saat data diunduh.
- Tema terang dan gelap bisa diganti lewat tombol di kanan atas.
- Tombol **Unduh Excel** mengikuti filter yang sedang aktif. Kalau ingin merekap semua data, reset filter dulu.
