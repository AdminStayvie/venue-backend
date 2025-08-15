// migrate.js
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'venueDB';

if (!mongoUri) {
    console.error("Error: MONGO_URI tidak ditemukan di file .env. Pastikan file .env sudah benar.");
    process.exit(1);
}

const client = new MongoClient(mongoUri);

// Fungsi untuk membaca file CSV dan mengembalikan data sebagai Promise
function readCsv(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        if (!fs.existsSync(filePath)) {
            return reject(new Error(`File tidak ditemukan: ${filePath}`));
        }
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', (error) => reject(error));
    });
}

// Fungsi untuk membersihkan format mata uang (misal: "Rp 1.500.000") menjadi angka
function parseCurrency(value) {
    if (typeof value !== 'string' || !value) return 0;
    // Menghapus semua karakter kecuali angka dan koma, lalu mengganti koma dengan titik
    return parseFloat(value.replace(/[^0-9,]+/g, "").replace(",", ".")) || 0;
}

// Fungsi untuk mengubah berbagai format tanggal menjadi objek Date yang valid
function parseDate(dateStr) {
    if (!dateStr) return null;
    // Coba beberapa format umum, misal: 'DD-Mon-YYYY' (15-Jun-2025) atau 'YYYY-MM-DD'
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
        return date;
    }
    console.warn(`Format tanggal tidak dikenali: "${dateStr}". Menggunakan tanggal hari ini.`);
    return new Date();
}

async function migrate() {
    try {
        console.log("🚀 Memulai proses migrasi data...");

        // 1. Membaca semua data dari file CSV
        const [reservationsData, addonsData, paymentsData] = await Promise.all([
            readCsv(path.join(__dirname, 'reservations.csv')),
            readCsv(path.join(__dirname, 'addons.csv')),
            readCsv(path.join(__dirname, 'payments.csv'))
        ]);
        console.log(`✅ Data CSV berhasil dibaca:`);
        console.log(`   - ${reservationsData.length} data reservasi`);
        console.log(`   - ${addonsData.length} data add-ons`);
        console.log(`   - ${paymentsData.length} data pembayaran`);

        // 2. Menggabungkan data menjadi satu struktur dokumen
        const reservationsMap = new Map();

        // Proses data reservasi utama
        for (const row of reservationsData) {
            const inv = row['Nomor Invoice'];
            if (inv) {
                reservationsMap.set(inv, {
                    _id: new ObjectId(),
                    nomorInvoice: inv,
                    tanggalReservasi: parseDate(row['Tanggal Reservasi']),
                    venue: row['Venue'],
                    kategoriEvent: row['Kategori Event'],
                    namaSales: row['Nama Sales'],
                    namaClient: row['Nama Client'],
                    vendorOrganisasi: row['Vendor / Organisasi'] || '',
                    noWhatsapp: row['No Whatsapp'],
                    tanggalEvent: parseDate(row['Tanggal Event']),
                    waktuEvent: row['Waktu Event'],
                    item: row['Item'] || '',
                    pax: parseInt(row['Pax']) || 0,
                    hargaPerPax: parseCurrency(row['Harga/Pax']),
                    subTotal: parseCurrency(row['Sub Total']),
                    dp: parseCurrency(row['DP']),
                    buktiDpUrl: row['Bukti DP'] || '',
                    catatan: row['Catatan'] || '',
                    dibatalkan: row['Batal'] === 'TRUE' || row['Batal'] === true,
                    pembayaran: [],
                    addons: [],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
            }
        }

        // Proses dan sematkan data add-ons
        for (const row of addonsData) {
            const inv = row['No INV']; // Sesuaikan dengan nama kolom di CSV Anda
            if (reservationsMap.has(inv)) {
                const pax = parseInt(row['#Jumlah PAX']) || 0;
                const harga = parseCurrency(row['#Harga/Pax']);
                reservationsMap.get(inv).addons.push({
                    _id: new ObjectId(),
                    item: row['Item'],
                    pax: pax,
                    hargaPerPax: harga,
                    subTotal: parseCurrency(row['# Sub Total']) || (pax * harga),
                    catatan: row['Catatan Tambahan'] || '',
                    createdAt: new Date()
                });
            }
        }

        // Proses dan sematkan data pembayaran
        for (const row of paymentsData) {
            const inv = row['INV']; // Sesuaikan dengan nama kolom di CSV Anda
            if (reservationsMap.has(inv)) {
                reservationsMap.get(inv).pembayaran.push({
                    _id: new ObjectId(),
                    jumlah: parseCurrency(row['# Pembayaran']),
                    tanggal: parseDate(row['Tanggal']),
                    buktiUrl: row['Bukti'] || '',
                    createdAt: new Date()
                });
            }
        }

        // 3. Memasukkan data ke MongoDB
        await client.connect();
        console.log("🔗 Terhubung ke MongoDB...");
        const database = client.db(dbName);
        const collection = database.collection('reservations');
        
        // Opsi: Hapus semua data lama sebelum memasukkan yang baru
        // Hati-hati menggunakan ini! Hanya aktifkan jika Anda yakin ingin memulai dari awal.
        // await collection.deleteMany({});
        // console.log("🗑️  Collection 'reservations' lama telah dibersihkan.");

        const finalData = Array.from(reservationsMap.values());
        if (finalData.length > 0) {
            const result = await collection.insertMany(finalData);
            console.log(`🎉 Migrasi SUKSES! ${result.insertedCount} dokumen berhasil dimasukkan.`);
        } else {
            console.log("🤔 Tidak ada data valid untuk dimigrasi.");
        }

    } catch (e) {
        console.error("❌ Terjadi kesalahan saat migrasi:", e);
    } finally {
        await client.close();
        console.log("🔌 Koneksi MongoDB ditutup.");
    }
}

// Jalankan fungsi migrasi
migrate();
