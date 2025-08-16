// migrate-from-csv.js
// Skrip ini dirancang untuk membaca data dari file CSV dan memasukkannya ke MongoDB dengan struktur yang benar.
// Pastikan file reservations.csv, addons.csv, dan payments.csv ada di direktori yang sama dengan skrip ini.

require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const csv = require('csv-parser');

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'venueDB';

if (!mongoUri) {
    console.error("Error: MONGO_URI tidak didefinisikan di file .env.");
    process.exit(1);
}

const client = new MongoClient(mongoUri);

// Fungsi untuk mengubah string tanggal Indonesia ke format ISO Date
function parseDate(dateString) {
    if (!dateString) return null;
    const parts = dateString.split(' ');
    if (parts.length < 3) return new Date(dateString); // Coba parse langsung jika format tidak terduga

    const day = parseInt(parts[0], 10);
    const monthName = parts[1].toLowerCase();
    const year = parseInt(parts[2], 10);

    const months = {
        'januari': 0, 'februari': 1, 'maret': 2, 'april': 3, 'mei': 4, 'juni': 5,
        'juli': 6, 'agustus': 7, 'september': 8, 'oktober': 9, 'november': 10, 'desember': 11
    };

    const month = months[monthName];

    if (isNaN(day) || isNaN(year) || month === undefined) {
        return new Date(); // Return tanggal hari ini jika parsing gagal
    }

    return new Date(Date.UTC(year, month, day));
}


async function migrate() {
    try {
        await client.connect();
        console.log("🔌 Terhubung ke MongoDB...");
        const db = client.db(dbName);
        
        const reservationsCollection = db.collection('reservations');
        const addonsCollection = db.collection('addons');
        const paymentsCollection = db.collection('payments');

        // HAPUS SEMUA DATA LAMA untuk memulai dari awal yang bersih
        console.log("🗑️  Membersihkan koleksi lama...");
        await reservationsCollection.deleteMany({});
        await addonsCollection.deleteMany({});
        await paymentsCollection.deleteMany({});
        console.log("✅ Koleksi berhasil dibersihkan.");

        // --- PROSES FILE RESERVATIONS.CSV ---
        console.log("\n🚚 Memulai migrasi 'reservations.csv'...");
        const reservations = [];
        const reservationStream = fs.createReadStream('reservations.csv').pipe(csv());

        for await (const row of reservationStream) {
            // Mengambil key pertama dari row, karena data CSV yang rusak menjadikannya sebagai key
            const key = Object.keys(row)[0];
            const values = key.split(',');

            // Memetakan data dari CSV ke struktur yang benar
            const reservationData = {
                _id: new ObjectId(),
                nomorInvoice: values[0] || `INV-MIGRASI-${Date.now()}`,
                tanggalEvent: parseDate(values[1]),
                venue: values[2] || 'N/A',
                kategoriEvent: values[3] || 'Others',
                namaSales: values[4] || 'N/A',
                namaClient: values[5] || 'N/A',
                noWhatsapp: values[6] || 'N/A',
                waktuEvent: values[7] || 'N/A',
                pax: parseInt(values[8], 10) || 0,
                hargaPerPax: parseFloat(values[9]) || 0,
                subTotal: (parseInt(values[8], 10) || 0) * (parseFloat(values[9]) || 0),
                dp: parseFloat(values[10]) || 0,
                catatan: values[12] || '',
                tanggalReservasi: new Date(), // Set tanggal reservasi ke hari ini
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            reservations.push(reservationData);
        }

        if (reservations.length > 0) {
            await reservationsCollection.insertMany(reservations);
            console.log(`👍 ${reservations.length} data reservasi berhasil dimasukkan.`);
        } else {
            console.log("🟡 Tidak ada data reservasi untuk dimigrasi.");
        }

        // --- PROSES FILE ADDONS.CSV & PAYMENTS.CSV (OPSIONAL) ---
        // Anda bisa menambahkan logika serupa untuk file addons.csv dan payments.csv di sini
        // Anda perlu mencocokkan 'nomorInvoice' untuk mendapatkan '_id' reservasi yang benar
        // Contoh:
        // 1. Baca addons.csv
        // 2. Untuk setiap baris addon, cari reservasi di 'reservationsCollection' berdasarkan 'nomorInvoice'
        // 3. Jika ketemu, ambil '_id' reservasi tersebut dan masukkan sebagai 'reservationId' untuk addon
        
        console.log("\n✨ Migrasi selesai!");
        console.log("👉 Pastikan untuk memeriksa data di database Anda.");

    } catch (e) {
        console.error("❌ Migrasi gagal:", e);
    } finally {
        await client.close();
        console.log("🚪 Koneksi MongoDB ditutup.");
    }
}

migrate();
