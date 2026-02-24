import * as fs from "fs";
import * as path from "path";
import os from "os";

const libre = require("libreoffice-convert");

// MacOS için varsayılan LibreOffice yolu (Eğer brew veya DMG ile kurulduysa ve PATH'te yoksa)
if (os.platform() === 'darwin' && !process.env.SOFFICE) {
  const macPath = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  if (fs.existsSync(macPath)) {
    process.env.SOFFICE = macPath;
  }
}

// Deprecation uyarılarını önlemek için convert fonksiyonunu kendimiz Promise'a çeviriyoruz
const libreConvertAsync = (input: Buffer, format: string, filter: any): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    libre.convert(input, format, filter, (err: Error, done: Buffer) => {
      if (err) reject(err);
      else resolve(done);
    });
  });
};

// -----------------------------------------------------------
// YAPILANDIRMA
// -----------------------------------------------------------

/** DEBUG=true olduğunda ayrıntılı console.log çıktıları aktif olur */
const DEBUG = process.env.DEBUG === "true";

/** Girdi klasörü — dönüştürülecek dosyalar buradan okunur */
const INPUT_DIR = path.resolve(process.cwd(), "girdiler");

/** Çıktı klasörü — PDF dosyaları buraya kaydedilir */
const OUTPUT_DIR = path.resolve(process.cwd(), "ciktilar");

/** Desteklenen uzantılar */
const SUPPORTED_EXTENSIONS = [".ppt", ".pptx"];

/** LibreOffice çıktı formatı */
const OUTPUT_FORMAT = ".pdf";

/**
 * Kaç dosyanın aynı anda (paralel) işleneceği.
 * Örnek: BATCH_SIZE=3 → her turda 3 dosya eş zamanlı dönüştürülür,
 * sonraki tur bir önceki bitmeden başlamaz (RAM dengesi).
 * Ortam değişkeniyle geçersiz kılınabilir: BATCH_SIZE=5 npm start
 */
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? "3", 10);

// -----------------------------------------------------------
// LOGGER
// -----------------------------------------------------------

// noop: DEBUG=false olduğunda log.info buraya bağlanır.
// JS motoru boş bir fonksiyon referansını tamamen ortadan kaldırabilir;
// böylece şablon dizesi (template literal) hiç oluşturulmaz → sıfır I/O maliyeti.
const noop = (_msg: string): void => {};

const log = {
  /** Sadece DEBUG=true iken çalışır; aksi hâlde tam no-op (sıfır maliyet) */
  info:   DEBUG ? (msg: string): void => console.log(msg) : noop,
  /** Her zaman çalışır */
  warn:   (msg: string): void => console.warn(msg),
  /** Her zaman çalışır */
  error:  (msg: string): void => console.error(msg),
  /** Her zaman çalışır — ilerleme/özet satırları için */
  always: (msg: string): void => console.log(msg),
};

// -----------------------------------------------------------
// YARDIMCI FONKSİYONLAR
// -----------------------------------------------------------

/** Klasör yoksa oluşturur */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    log.always(`📁 Klasör oluşturuldu: ${dirPath}`);
  }
}

/**
 * Klasördeki PPT/PPTX dosyalarını doğal alfasayısal sıraya göre döndürür.
 * "Ders 2" → "Ders 10" gibi sayısal sıralama doğru çalışır.
 */
function getSortedPPTFiles(dirPath: string): string[] {
  return fs
    .readdirSync(dirPath)
    .filter((f) => SUPPORTED_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * Bir diziyi belirli boyutlarda alt dizilere (chunk) böler.
 * ["a","b","c","d"], 2  →  [["a","b"], ["c","d"]]
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Tek bir PPT/PPTX dosyasını PDF'e dönüştürür ve kaydeder */
async function convertFile(fileName: string): Promise<void> {
  const inputPath  = path.join(INPUT_DIR, fileName);
  const baseName   = path.basename(fileName, path.extname(fileName));
  const outputPath = path.join(OUTPUT_DIR, `${baseName}${OUTPUT_FORMAT}`);

  log.info(`   🔄 Başladı : ${fileName}`);

  const inputBuffer   = fs.readFileSync(inputPath);
  const outputBuffer: Buffer = await libreConvertAsync(inputBuffer, OUTPUT_FORMAT, undefined);
  fs.writeFileSync(outputPath, outputBuffer);

  log.info(`   ✅ Bitti   : ${path.basename(outputPath)}`);
}

/** Yeni Web Yükleme servisi için isteğe bağlı (arbitrary) konumlardan dönüştürme yapar */
export async function convertFileDirect(inputPath: string, outputPath: string): Promise<boolean> {
  const fileName = path.basename(inputPath);
  log.info(`   🔄 Başladı : ${fileName}`);
  try {
    const inputBuffer = fs.readFileSync(inputPath);
    const outputBuffer: Buffer = await libreConvertAsync(inputBuffer, OUTPUT_FORMAT, undefined);
    fs.writeFileSync(outputPath, outputBuffer);
    log.info(`   ✅ Bitti   : ${fileName}`);
    return true;
  } catch (err) {
    log.error(`   ❌ Hata [${fileName}]: ${err}`);
    return false;
  }
}

// -----------------------------------------------------------
// ANA FONKSİYON
// -----------------------------------------------------------

export async function getFilesStatus(): Promise<{
  inputFiles: string[];
  outputFiles: string[];
}> {
  ensureDir(INPUT_DIR);
  ensureDir(OUTPUT_DIR);

  const inputFiles = getSortedPPTFiles(INPUT_DIR);
  const outputFiles = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => path.extname(f).toLowerCase() === OUTPUT_FORMAT);

  return { inputFiles, outputFiles };
}

export async function runConversion(batchSize: number = BATCH_SIZE): Promise<{
  success: number;
  failed: number;
  total: number;
}> {
  ensureDir(INPUT_DIR);
  ensureDir(OUTPUT_DIR);

  const files = getSortedPPTFiles(INPUT_DIR);

  if (files.length === 0) {
    return { success: 0, failed: 0, total: 0 };
  }

  const batches = chunk(files, batchSize);

  let successCount = 0;
  let failCount = 0;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    const results = await Promise.allSettled(
      batch.map((file) => convertFile(file))
    );

    results.forEach((result, idx) => {
      if (result.status === "fulfilled") {
        successCount++;
      } else {
        failCount++;
        log.error(`   ❌ Hata [${batch[idx]}]: ${result.reason}`);
      }
    });
  }

  return {
    success: successCount,
    failed: failCount,
    total: files.length,
  };
}
