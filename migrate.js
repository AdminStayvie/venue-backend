// migrate.js (Import from CSVs directly to Restructured Collections)
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'venueDB';

if (!mongoUri) {
    console.error("Error: MONGO_URI is not defined in .env file.");
    process.exit(1);
}

const client = new MongoClient(mongoUri);

// Helper function to read CSV files
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

// Helper function to parse currency strings (e.g., "Rp1.500.000")
function parseCurrency(value) {
    if (typeof value !== 'string' || !value) return 0;
    return parseFloat(value.replace(/[^0-9,]+/g, "").replace(",", ".")) || 0;
}

// Helper function to parse various date formats
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
                return new Date(Date.UTC(year, month, day));
            }
        }
    } catch (e) { /* Continue */ }
    
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? new Date() : date;
}

async function migrate() {
    try {
        await client.connect();
        console.log("🔌 Connected to MongoDB...");
        const db = client.db(dbName);
        const reservationsCollection = db.collection('reservations');
        const addonsCollection = db.collection('addons');
        const paymentsCollection = db.collection('payments');

        // 1. Read all CSV files
        const [reservationsData, addonsData, paymentsData] = await Promise.all([
            readCsv(path.join(__dirname, 'reservations.csv')),
            readCsv(path.join(__dirname, 'addons.csv')),
            readCsv(path.join(__dirname, 'payments.csv'))
        ]);
        console.log(`📊 CSV data read successfully: ${reservationsData.length} reservations, ${addonsData.length} addons, ${paymentsData.length} payments.`);

        // 2. Process data in memory
        const reservationsMap = new Map();
        const allReservationsToInsert = [];
        const allAddonsToInsert = [];
        const allPaymentsToInsert = [];

        for (const row of reservationsData) {
            const inv = row['Nomor Invoice']?.trim();
            if (inv) {
                const reservationId = new ObjectId();
                const reservationDoc = {
                    _id: reservationId,
                    nomorInvoice: inv,
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
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };
                reservationsMap.set(inv, reservationId);
                allReservationsToInsert.push(reservationDoc);
            }
        }

        for (const row of addonsData) {
            const inv = row['No INV']?.trim();
            if (inv && reservationsMap.has(inv)) {
                allAddonsToInsert.push({
                    _id: new ObjectId(),
                    reservationId: reservationsMap.get(inv),
                    item: row['Item'],
                    pax: parseInt(row['Jumlah PAX']) || 0,
                    hargaPerPax: parseCurrency(row['Harga/Pax']),
                    subTotal: parseCurrency(row['Sub Total']),
                    catatan: row['Catatan Tambahan'] || '',
                    createdAt: new Date()
                });
            }
        }

        for (const row of paymentsData) {
            const inv = row['INV']?.trim();
            if (inv && reservationsMap.has(inv)) {
                allPaymentsToInsert.push({
                    _id: new ObjectId(),
                    reservationId: reservationsMap.get(inv),
                    nomorKwitansi: row['No Kwitansi'],
                    jumlah: parseCurrency(row['# Pembayaran']),
                    tanggal: parseDate(row['Tanggal']),
                    buktiUrl: row['Bukti'] || '',
                    createdAt: new Date()
                });
            }
        }
        
        console.log("🔗 Data linked successfully in memory.");

        // 3. Insert data into new, clean collections
        await reservationsCollection.deleteMany({});
        await addonsCollection.deleteMany({});
        await paymentsCollection.deleteMany({});
        console.log("🗑️  Cleaned up target collections.");

        if (allReservationsToInsert.length > 0) await reservationsCollection.insertMany(allReservationsToInsert);
        if (allAddonsToInsert.length > 0) await addonsCollection.insertMany(allAddonsToInsert);
        if (allPaymentsToInsert.length > 0) await paymentsCollection.insertMany(allPaymentsToInsert);

        console.log("✅ Migration complete!");
        console.log(`   - ${allReservationsToInsert.length} documents inserted into 'reservations'.`);
        console.log(`   - ${allAddonsToInsert.length} documents inserted into 'addons'.`);
        console.log(`   - ${allPaymentsToInsert.length} documents inserted into 'payments'.`);

    } catch (e) {
        console.error("❌ Migration failed:", e);
    } finally {
        await client.close();
        console.log("🚪 MongoDB connection closed.");
    }
}

migrate();
