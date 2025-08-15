// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 3001;
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'venueDB';

// Middleware
app.use(cors());
app.use(express.json());

// Validasi variabel lingkungan
if (!mongoUri) {
    console.error("Error: MONGO_URI tidak ditemukan di file .env");
    process.exit(1);
}

// Koneksi ke MongoDB
const client = new MongoClient(mongoUri);
let reservationsCollection;

async function connectDB() {
    try {
        await client.connect();
        const database = client.db(dbName);
        reservationsCollection = database.collection('reservations');
        console.log(`Terhubung ke MongoDB, database: ${dbName}`);
    } catch (e) {
        console.error("Gagal terhubung ke MongoDB", e);
        process.exit(1); // Keluar dari aplikasi jika koneksi DB gagal
    }
}

// === API Endpoints ===

// Health Check
app.get('/api', (req, res) => {
    res.json({ status: 'API is running', timestamp: new Date() });
});

// GET: Mengambil semua data reservasi
app.get('/api/reservations', async (req, res) => {
    try {
        // Hanya kirim field yang dibutuhkan oleh kalender untuk efisiensi
        const projection = { 
            nomorInvoice: 1, 
            tanggalEvent: 1, 
            namaClient: 1, 
            venue: 1, 
            kategoriEvent: 1,
            waktuEvent: 1,
            namaSales: 1,
            pax: 1,
            subTotal: 1,
            pembayaran: 1,
            addons: 1,
            dibatalkan: 1
        };
        const reservations = await reservationsCollection.find({}).project(projection).toArray();
        res.json(reservations);
    } catch (e) {
        res.status(500).json({ message: "Gagal mengambil data reservasi", error: e.message });
    }
});

// POST: Menambah item add-on baru
app.post('/api/reservations/:invoice/addons', async (req, res) => {
    const { invoice } = req.params;
    const { item, pax, hargaPerPax, subTotal, catatan } = req.body;

    if (!item || !pax || !hargaPerPax || !subTotal) {
        return res.status(400).json({ message: "Data add-on tidak lengkap." });
    }

    const newAddon = {
        _id: new ObjectId(), // ID unik baru
        item,
        pax,
        hargaPerPax,
        subTotal,
        catatan: catatan || "",
        createdAt: new Date()
    };
    
    try {
        const result = await reservationsCollection.updateOne(
            { nomorInvoice: invoice },
            { 
                $push: { addons: newAddon },
                $set: { updatedAt: new Date() }
            }
        );
        if (result.matchedCount === 0) {
            return res.status(404).json({ message: `Invoice ${invoice} tidak ditemukan.` });
        }
        res.status(201).json({ message: "Add-on berhasil ditambahkan", data: newAddon });
    } catch (e) {
        res.status(500).json({ message: "Gagal menambah add-on", error: e.message });
    }
});

// POST: Menambah pembayaran baru
app.post('/api/reservations/:invoice/pembayaran', async (req, res) => {
    const { invoice } = req.params;
    const { jumlah, tanggal } = req.body;

    if (!jumlah || !tanggal) {
        return res.status(400).json({ message: "Jumlah dan tanggal pembayaran harus diisi." });
    }

    const newPayment = {
        _id: new ObjectId(),
        jumlah: parseFloat(jumlah),
        tanggal: new Date(tanggal),
        createdAt: new Date()
    };

    try {
        const result = await reservationsCollection.updateOne(
            { nomorInvoice: invoice },
            { 
                $push: { pembayaran: newPayment },
                $set: { updatedAt: new Date() }
            }
        );
        if (result.matchedCount === 0) {
            return res.status(404).json({ message: `Invoice ${invoice} tidak ditemukan.` });
        }
        res.status(201).json({ message: "Pembayaran berhasil ditambahkan", data: newPayment });
    } catch (e) {
        res.status(500).json({ message: "Gagal menambah pembayaran", error: e.message });
    }
});


app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
    connectDB();
});
