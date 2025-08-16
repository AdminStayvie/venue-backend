// migrate.js (Lengkap dengan import Addons & Payments)
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'venueDB';

if (!mongoUri) {
    console.error("Error: MONGO_URI tidak ditemukan di file .env.");
    process.exit(1);
}

const client = new MongoClient(mongoUri);

// Fungsi untuk membaca file CSV
function readCsv(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csv({ mapHeaders: ({ header }) => header.trim() })) // Menghapus spasi ekstra dari header
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', (error) => reject(error));
    });
}

// Fungsi untuk mengubah format Rupiah (Rp1.000.000) menjadi angka (1000000)
function parseCurrency(value) {
    if (typeof value !== 'string' || !value) return 0;
    return parseFloat(value.replace(/[^0-9,]+/g, "").replace(",", ".")) || 0;
}

// Fungsi untuk mengubah format tanggal (contoh: 21-Des-2024) menjadi objek Date
function parseDate(dateStr) {
    if (!dateStr || dateStr.trim() === '') return null;
    const months = {
        'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'mei': 4, 'jun': 5, 
        'jul': 6, 'agu': 7, 'sep': 8, 'okt': 9, 'nov': 10, 'des': 11
    };
    try {
        const parts = dateStr.toLowerCase().split('-');
        if (parts.length === 3) {
            const day = parseInt(parts[0]);
            const month = months[parts[1].substring(0, 3)];
            const year = parseInt(parts[2]);
            if (!isNaN(day) && month !== undefined && !isNaN(year)) {
                return new Date(year, month, day);
            }
        }
    } catch (e) { /* Lanjut ke parser berikutnya */ }
    
    // Fallback jika format berbeda
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? new Date() : date;
}


async function migrate() {
    try {
        console.log("🚀 Memulai proses migrasi data...");

        // 1. Baca semua file CSV secara bersamaan
        const [reservationsData, addonsData, paymentsData] = await Promise.all([
            readCsv(path.join(__dirname, 'reservations.csv')),
            readCsv(path.join(__dirname, 'addons.csv')),
            readCsv(path.join(__dirname, 'payments.csv'))
        ]);
        
        console.log(`📊 Data CSV berhasil dibaca:`);
        console.log(`   - ${reservationsData.length} data reservasi`);
        console.log(`   - ${addonsData.length} data add-ons`);
        console.log(`   - ${paymentsData.length} data pembayaran`);

        // 2. Proses data reservasi utama dan simpan dalam Map untuk akses cepat
        const reservationsMap = new Map();
        for (const row of reservationsData) {
            const inv = row['Nomor Invoice'];
            if (inv && inv.trim() !== '') {
                reservationsMap.set(inv.trim(), {
                    _id: new ObjectId(),
                    nomorInvoice: inv.trim(),
                    tanggalReservasi: parseDate(row['Tanggal Reservasi']),
                    venue: row['Venue'],
                    kategoriEvent: row['Kategori Event'],
                    namaSales: row['Nama Sales'],
                    namaClient: row['Nama Client'],
                    noWhatsapp: row['No Whatsapp'],
                    tanggalEvent: parseDate(row['Tanggal Event']),
                    waktuEvent: row['Waktu Event'],
                    pax: parseInt(row['Pax']) || 0,
                    hargaPerPax: parseCurrency(row['Harga/Pax']),
                    subTotal: parseCurrency(row['Sub Total']),
                    dp: parseCurrency(row['DP']),
                    catatan: (row['Catatan'] || '').trim(),
                    // Inisialisasi array kosong untuk addons dan pembayaran
                    pembayaran: [],
                    addons: [],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
            }
        }

        // 3. Hubungkan data Addons ke reservasi yang sesuai
        let addonsMatched = 0;
        for (const row of addonsData) {
            const inv = row['No INV'] ? row['No INV'].trim() : null;
            if (inv && reservationsMap.has(inv)) {
                reservationsMap.get(inv).addons.push({
                    _id: new ObjectId(),
                    item: row['Item'],
                    pax: parseInt(row['Jumlah PAX']) || 0,
                    hargaPerPax: parseCurrency(row['Harga/Pax']),
                    subTotal: parseCurrency(row['Sub Total']),
                    catatan: row['Catatan Tambahan'] || '',
                    createdAt: new Date()
                });
                addonsMatched++;
            }
        }

        // 4. Hubungkan data Pembayaran ke reservasi yang sesuai
        let paymentsMatched = 0;
        for (const row of paymentsData) {
            const inv = row['INV'] ? row['INV'].trim() : null;
            if (inv && reservationsMap.has(inv)) {
                reservationsMap.get(inv).pembayaran.push({
                    _id: new ObjectId(),
                    nomorKwitansi: row['No Kwitansi'],
                    jumlah: parseCurrency(row['# Pembayaran']),
                    tanggal: parseDate(row['Tanggal']),
                    buktiUrl: row['Bukti'] || '',
                    createdAt: new Date()
                });
                paymentsMatched++;
            }
        }
        
        console.log(`🔗 Proses penggabungan data selesai:`);
        console.log(`   - ${addonsMatched} dari ${addonsData.length} data add-ons berhasil dicocokkan.`);
        console.log(`   - ${paymentsMatched} dari ${paymentsData.length} data pembayaran berhasil dicocokkan.`);

        // 5. Masukkan data yang sudah digabung ke MongoDB
        await client.connect();
        console.log("🔌 Terhubung ke MongoDB...");
        const database = client.db(dbName);
        const collection = database.collection('reservations');
        
        const finalData = Array.from(reservationsMap.values());
        if (finalData.length > 0) {
            await collection.deleteMany({}); // Hapus data lama sebelum import
            console.log("🗑️  Collection 'reservations' lama telah dibersihkan.");
            
            const result = await collection.insertMany(finalData);
            console.log(`🎉 Migrasi SUKSES! ${result.insertedCount} dokumen berhasil dimasukkan.`);
        } else {
            console.log("🤔 Tidak ada data valid untuk dimigrasi.");
        }

    } catch (e) {
        console.error("❌ Terjadi kesalahan saat migrasi:", e);
    } finally {
        await client.close();
        console.log("🚪 Koneksi MongoDB ditutup.");
    }
}

migrate();
