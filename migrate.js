// migrate.js (Versi Final - Paling Tangguh)
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

// Fungsi untuk membaca CSV biasa (untuk addons dan payments)
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

// Fungsi KHUSUS untuk membaca reservations.csv yang formatnya tidak standar
function readReservationsCsvSmart(filePath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            return reject(new Error(`File tidak ditemukan: ${filePath}`));
        }
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const lines = fileContent.split('\n');
        const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
        const data = [];
        let currentRecord = null;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const invoiceRegex = /^"INV\/\d{4}\/\d{2}-VE-\d{4}/;

            if (invoiceRegex.test(line)) {
                if (currentRecord) {
                    data.push(currentRecord);
                }
                const values = line.split(',');
                currentRecord = {};
                headers.forEach((header, index) => {
                    currentRecord[header] = (values[index] || '').replace(/"/g, '');
                });
            } else if (currentRecord) {
                currentRecord['Catatan'] = (currentRecord['Catatan'] || '') + ' ' + line.replace(/"/g, '');
            }
        }
        if (currentRecord) {
            data.push(currentRecord);
        }
        resolve(data);
    });
}


// Fungsi utilitas lainnya (parseCurrency, parseDate)
function parseCurrency(value) {
    if (typeof value !== 'string' || !value) return 0;
    return parseFloat(value.replace(/[^0-9,]+/g, "").replace(",", ".")) || 0;
}

function parseDate(dateStr) {
    if (!dateStr || dateStr.trim() === '') return null;
    try {
        const months = { 'januari': 0, 'februari': 1, 'maret': 2, 'april': 3, 'mei': 4, 'juni': 5, 'juli': 6, 'agustus': 7, 'september': 8, 'oktober': 9, 'november': 10, 'desember': 11 };
        const parts = dateStr.toLowerCase().split(' ');
        if (parts.length === 3 && months[parts[1]] !== undefined) {
            return new Date(parts[2], months[parts[1]], parts[0]);
        }
    } catch (e) { /* Lanjut ke parser berikutnya */ }

    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
        return date;
    }
    console.warn(`Format tanggal tidak dikenali: "${dateStr}". Menggunakan tanggal hari ini.`);
    return new Date();
}


async function migrate() {
    try {
        console.log("🚀 Memulai proses migrasi data (versi final)...");

        const [reservationsData, addonsData, paymentsData] = await Promise.all([
            readReservationsCsvSmart(path.join(__dirname, 'reservations.csv')),
            readCsv(path.join(__dirname, 'addons.csv')),
            readCsv(path.join(__dirname, 'payments.csv'))
        ]);
        
        console.log(`📊 Data CSV berhasil dibaca:`);
        console.log(`   - ${reservationsData.length} data reservasi (setelah digabungkan)`);
        console.log(`   - ${addonsData.length} data add-ons`);
        console.log(`   - ${paymentsData.length} data pembayaran`);

        const reservationsMap = new Map();

        for (const row of reservationsData) {
            const inv = row['Nomor Invoice'];
            if (inv && inv.trim() !== '') {
                const cleanInv = inv.trim().replace(/"/g, '');
                reservationsMap.set(cleanInv, {
                    _id: new ObjectId(),
                    nomorInvoice: cleanInv,
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
                    catatan: (row['Catatan'] || '').trim(),
                    dibatalkan: row['Batal'] === 'TRUE' || row['Batal'] === true,
                    pembayaran: [],
                    addons: [],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
            }
        }

        let addonsMatched = 0;
        for (const row of addonsData) {
            const invKey = Object.keys(row).find(k => k.toUpperCase().includes('INV'));
            if (!invKey) continue;
            
            const inv = row[invKey] ? row[invKey].trim().replace(/"/g, '') : null;
            if (inv && reservationsMap.has(inv)) {
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
                addonsMatched++;
            }
        }

        let paymentsMatched = 0;
        for (const row of paymentsData) {
            const invKey = Object.keys(row).find(k => k.toUpperCase().includes('INV'));
            if (!invKey) continue;

            const inv = row[invKey] ? row[invKey].trim().replace(/"/g, '') : null;
            if (inv && reservationsMap.has(inv)) {
                reservationsMap.get(inv).pembayaran.push({
                    _id: new ObjectId(),
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

        await client.connect();
        console.log("🔌 Terhubung ke MongoDB...");
        const database = client.db(dbName);
        const collection = database.collection('reservations');
        
        const finalData = Array.from(reservationsMap.values());
        if (finalData.length > 0) {
            await collection.deleteMany({});
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
