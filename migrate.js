// migrate.js (Update-Only version for Addons & Payments)
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
            .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', (error) => reject(error));
    });
}

// Fungsi untuk mengubah format Rupiah
function parseCurrency(value) {
    if (typeof value !== 'string' || !value) return 0;
    return parseFloat(value.replace(/[^0-9,]+/g, "").replace(",", ".")) || 0;
}

// Fungsi untuk mengubah format tanggal
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
                return new Date(Date.UTC(year, month, day)); // Simpan sebagai UTC
            }
        }
    } catch (e) { /* Lanjut */ }
    
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? new Date() : date;
}

async function migrate() {
    try {
        await client.connect();
        console.log("🔌 Terhubung ke MongoDB...");
        const database = client.db(dbName);
        const collection = database.collection('reservations');

        console.log("🚀 Memulai proses migrasi data (Mode Update)...");

        // 1. Baca file addons dan payments
        const [addonsData, paymentsData] = await Promise.all([
            readCsv(path.join(__dirname, 'addons.csv')),
            readCsv(path.join(__dirname, 'payments.csv'))
        ]);
        
        console.log(`📊 Data CSV berhasil dibaca: ${addonsData.length} addons, ${paymentsData.length} payments.`);

        // 2. Kosongkan dulu array addons dan pembayaran yang ada di database
        console.log("🗑️ Mengosongkan data addons & pembayaran lama di database...");
        await collection.updateMany({}, { $set: { addons: [], pembayaran: [] } });

        // 3. Proses dan update Addons
        let addonsMatched = 0;
        let addonsNotFound = [];
        for (const row of addonsData) {
            const inv = row['No INV'] ? row['No INV'].trim() : null;
            if (inv) {
                const newAddon = {
                    _id: new ObjectId(),
                    item: row['Item'],
                    pax: parseInt(row['Jumlah PAX']) || 0,
                    hargaPerPax: parseCurrency(row['Harga/Pax']),
                    subTotal: parseCurrency(row['Sub Total']),
                    catatan: row['Catatan Tambahan'] || '',
                    createdAt: new Date()
                };
                
                const result = await collection.updateOne(
                    { nomorInvoice: inv },
                    { $push: { addons: newAddon } }
                );

                if (result.matchedCount > 0) {
                    addonsMatched++;
                } else {
                    addonsNotFound.push(inv);
                }
            }
        }
        console.log(`🔗 ${addonsMatched} dari ${addonsData.length} data add-ons berhasil diupdate.`);
        if (addonsNotFound.length > 0) {
            console.warn(`   - Addons tidak ditemukan untuk invoice: ${[...new Set(addonsNotFound)].join(', ')}`);
        }

        // 4. Proses dan update Pembayaran
        let paymentsMatched = 0;
        let paymentsNotFound = [];
        for (const row of paymentsData) {
            const inv = row['INV'] ? row['INV'].trim() : null;
            if (inv) {
                const newPayment = {
                    _id: new ObjectId(),
                    nomorKwitansi: row['No Kwitansi'],
                    jumlah: parseCurrency(row['# Pembayaran']),
                    tanggal: parseDate(row['Tanggal']),
                    buktiUrl: row['Bukti'] || '',
                    createdAt: new Date()
                };

                const result = await collection.updateOne(
                    { nomorInvoice: inv },
                    { $push: { pembayaran: newPayment } }
                );

                if (result.matchedCount > 0) {
                    paymentsMatched++;
                } else {
                    paymentsNotFound.push(inv);
                }
            }
        }
        console.log(`🔗 ${paymentsMatched} dari ${paymentsData.length} data pembayaran berhasil diupdate.`);
        if (paymentsNotFound.length > 0) {
            console.warn(`   - Pembayaran tidak ditemukan untuk invoice: ${[...new Set(paymentsNotFound)].join(', ')}`);
        }

        console.log("🎉 Migrasi SUKSES!");

    } catch (e) {
        console.error("❌ Terjadi kesalahan saat migrasi:", e);
    } finally {
        await client.close();
        console.log("🚪 Koneksi MongoDB ditutup.");
    }
}

migrate();
