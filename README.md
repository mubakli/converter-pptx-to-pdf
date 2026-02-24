# 📄 PPTX → PDF Dönüştürücü

Node.js ve TypeScript ile geliştirilmiş, `girdiler` klasöründeki tüm PPT/PPTX dosyalarını yüksek kaliteli PDF'e dönüştüren otonom bir araç.

---

## 🔧 Gereksinimler

### 1. LibreOffice (Zorunlu)

Bu araç arka planda **LibreOffice Headless** kullandığından sisteminizde LibreOffice kurulu olmalıdır.

**macOS:**
```bash
brew install --cask libreoffice
```

**Ubuntu / Debian:**
```bash
sudo apt-get install libreoffice
```

**Windows:**  
[https://www.libreoffice.org/download/download/](https://www.libreoffice.org/download/download/) adresinden indirip kurun.

Kurulumu doğrulamak için:
```bash
soffice --version
```

### 2. Node.js (v18+)

```bash
node --version   # v18.x veya üzeri olmalı
```

---

## 📁 Proje Yapısı

```
converter-pptx-to-pdf/
├── src/
│   └── index.ts        # Ana dönüştürücü mantığı
├── girdiler/           # ← PPT/PPTX dosyalarınızı buraya koyun
├── ciktilar/           # ← PDF çıktıları buraya yazılır (otomatik oluşur)
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🚀 Kurulum ve Çalıştırma

### 1. Bağımlılıkları Kur

```bash
npm install
```

### 2. PPT/PPTX Dosyalarını Ekle

Dönüştürmek istediğiniz dosyaları `girdiler/` klasörüne koyun:

```
girdiler/
├── Ders 1.pptx
├── Ders 2.pptx
└── Ders 10.pptx
```

### 3. Dönüştürücüyü Çalıştır

```bash
npm start
```

**veya** TypeScript'i önce derleyip ardından çalıştırmak için:
```bash
npm run build:run
```

---

## ⚙️ Nasıl Çalışır?

1. `girdiler/` klasöründeki tüm `.ppt` ve `.pptx` dosyalarını tarar.
2. Dosyaları **doğal alfasayısal sıraya** göre sıralar (`localeCompare` + `numeric: true`) — örneğin "Ders 2" her zaman "Ders 10"dan önce gelir.
3. Her dosyayı **sırayla** (tek tek) dönüştürür — RAM tüketimini önlemek için paralel işleme yapılmaz.
4. Çıktı PDF'lerini `ciktilar/` klasörüne kaydeder.
5. Sayfa oranları (16:9, 4:3 vb.) ve kalite LibreOffice'in varsayılan kayıpsız PDF ihracatı sayesinde korunur.

---

## 📌 Notlar

- `girdiler/` ve `ciktilar/` klasörleri yoksa program başlangıçta otomatik oluşturur.
- Bir dosya dönüştürülemezse hata mesajıyla atlanır; diğer dosyalar işlenmeye devam eder.
- LibreOffice PATH'e eklenmemişse `libreoffice-convert` kütüphanesi onu otomatik bulmaya çalışır; bulamazsa hata alırsınız.
