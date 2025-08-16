// index.js (Dengan Logika Invoice yang Diperbaiki)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

const app = express();
const port = process.env.PORT || 3001;
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'venueDB';

// Konfigurasi Multer untuk menyimpan file
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, 'uploads');
        // Buat folder jika belum ada
        fs.mkdirSync(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        // Buat nama file unik untuk menghindari tumpang tindih
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // Serve file statis

if (!mongoUri) {
    console.error("Error: MONGO_URI tidak ditemukan di file .env");
    process.exit(1);
}

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
        process.exit(1);
    }
}

// === API Endpoints ===

// GET: Mengambil data reservasi
app.get('/api/reservations', async (req, res) => {
    try {
        const { search = '', searchBy = 'namaClient', page = 1, limit = 10, sort = 'tanggalEvent', order = 'desc' } = req.query;
        
        let query = {};
        if (search) {
            if (searchBy === 'tanggalEvent') {
                const searchDate = new Date(search);
                if (!isNaN(searchDate.getTime())) {
                    const startOfDay = new Date(searchDate);
                    startOfDay.setUTCHours(0, 0, 0, 0);
                    const endOfDay = new Date(searchDate);
                    endOfDay.setUTCHours(23, 59, 59, 999);
                    query[searchBy] = { $gte: startOfDay, $lte: endOfDay };
                }
            } else {
                query[searchBy] = { $regex: search, $options: 'i' };
            }
        }
        
        const sortOrder = order === 'asc' ? 1 : -1;
        
        const reservations = await reservationsCollection
            .find(query)
            .sort({ [sort]: sortOrder })
            .skip((page - 1) * limit)
            .limit(parseInt(limit))
            .toArray();

        const total = await reservationsCollection.countDocuments(query);

        res.json({
            data: reservations,
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(total / limit)
        });
    } catch (e) {
        res.status(500).json({ message: "Gagal mengambil data reservasi", error: e.message });
    }
});

// GET: Mengambil satu data reservasi
app.get('/api/reservations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "ID tidak valid" });
        }
        const reservation = await reservationsCollection.findOne({ _id: new ObjectId(id) });
        if (!reservation) {
            return res.status(404).json({ message: "Reservasi tidak ditemukan" });
        }
        res.json(reservation);
    } catch (e) {
        res.status(500).json({ message: "Gagal mengambil data", error: e.message });
    }
});

// POST: Membuat reservasi baru
app.post('/api/reservations', async (req, res) => {
    try {
        const newData = req.body;
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');

        // --- LOGIKA BARU UNTUK NOMOR INVOICE ---
        // 1. Cari invoice terakhir di bulan dan tahun yang sama
        const lastInvoice = await reservationsCollection.findOne(
            { nomorInvoice: { $regex: `^INV/${year}/${month}-VE-` } },
            { sort: { nomorInvoice: -1 } }
        );

        let nextIdNumber = 1;
        if (lastInvoice) {
            // 2. Ambil nomor urut dari invoice terakhir dan tambah 1
            const lastId = parseInt(lastInvoice.nomorInvoice.split('-').pop());
            nextIdNumber = lastId + 1;
        }
        
        // 3. Format nomor urut menjadi 4 digit (e.g., 0001, 0014)
        const nextId = String(nextIdNumber).padStart(4, '0');
        const nomorInvoice = `INV/${year}/${month}-VE-${nextId}`;
        // --- AKHIR LOGIKA BARU ---

        const reservation = {
            _id: new ObjectId(),
            nomorInvoice,
            ...newData,
            tanggalReservasi: new Date(newData.tanggalReservasi),
            tanggalEvent: new Date(newData.tanggalEvent),
            pax: parseInt(newData.pax),
            hargaPerPax: parseFloat(newData.hargaPerPax),
            subTotal: parseFloat(newData.subTotal),
            dp: parseFloat(newData.dp),
            dibatalkan: false,
            pembayaran: [],
            addons: [],
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const result = await reservationsCollection.insertOne(reservation);
        res.status(201).json({ message: "Reservasi berhasil dibuat", data: result });
    } catch (e) {
        res.status(500).json({ message: "Gagal membuat reservasi", error: e.message });
    }
});


// PUT: Mengupdate reservasi
app.put('/api/reservations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "ID tidak valid" });
        }
        const { _id, nomorInvoice, ...updateData } = req.body;
        
        updateData.tanggalReservasi = new Date(updateData.tanggalReservasi);
        updateData.tanggalEvent = new Date(updateData.tanggalEvent);
        updateData.pax = parseInt(updateData.pax);
        updateData.hargaPerPax = parseFloat(updateData.hargaPerPax);
        updateData.subTotal = parseFloat(updateData.subTotal);
        updateData.dp = parseFloat(updateData.dp);
        updateData.updatedAt = new Date();

        const result = await reservationsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Reservasi tidak ditemukan" });
        }
        res.json({ message: "Reservasi berhasil diperbarui" });
    } catch (e) {
        res.status(500).json({ message: "Gagal memperbarui reservasi", error: e.message });
    }
});

// DELETE: Menghapus reservasi
app.delete('/api/reservations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "ID tidak valid" });
        }
        const result = await reservationsCollection.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Reservasi tidak ditemukan" });
        }
        res.json({ message: "Reservasi berhasil dihapus" });
    } catch (e) {
        res.status(500).json({ message: "Gagal menghapus reservasi", error: e.message });
    }
});

// POST: Menambah item add-on
app.post('/api/reservations/:id/addons', async (req, res) => {
    const { id } = req.params;
    const { item, pax, hargaPerPax, subTotal, catatan } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ message: "ID tidak valid" });
    if (!item || pax === undefined || hargaPerPax === undefined || subTotal === undefined) {
        return res.status(400).json({ message: "Data add-on tidak lengkap." });
    }
    const newAddon = {
        _id: new ObjectId(), item, pax: parseInt(pax), hargaPerPax: parseFloat(hargaPerPax),
        subTotal: parseFloat(subTotal), catatan: catatan || "", createdAt: new Date()
    };
    try {
        const result = await reservationsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $push: { addons: newAddon }, $set: { updatedAt: new Date() } }
        );
        if (result.matchedCount === 0) return res.status(404).json({ message: `Reservasi tidak ditemukan.` });
        res.status(201).json({ message: "Add-on berhasil ditambahkan", data: newAddon });
    } catch (e) { res.status(500).json({ message: "Gagal menambah add-on", error: e.message }); }
});

// POST: Menambah pembayaran baru
app.post('/api/reservations/:id/pembayaran', upload.single('bukti'), async (req, res) => {
    const { id } = req.params;
    const { jumlah, tanggal, nomorKwitansi } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ message: "ID tidak valid" });
    if (!jumlah || !tanggal) return res.status(400).json({ message: "Jumlah dan tanggal pembayaran harus diisi." });
    
    const newPayment = {
        _id: new ObjectId(),
        nomorKwitansi,
        jumlah: parseFloat(jumlah),
        tanggal: new Date(tanggal),
        buktiUrl: req.file ? `/uploads/${req.file.filename}` : '',
        createdAt: new Date()
    };
    try {
        const result = await reservationsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $push: { pembayaran: newPayment }, $set: { updatedAt: new Date() } }
        );
        if (result.matchedCount === 0) return res.status(404).json({ message: `Reservasi tidak ditemukan.` });
        res.status(201).json({ message: "Pembayaran berhasil ditambahkan", data: newPayment });
    } catch (e) { res.status(500).json({ message: "Gagal menambah pembayaran", error: e.message }); }
});


app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
    connectDB();
});
