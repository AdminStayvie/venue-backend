// index.js (Dengan Fitur Lengkap: CRUD, Sort, Search Lanjutan)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const multer = require('multer');
const ExcelJS = require('exceljs');

const app = express();
const port = process.env.PORT || 3001;
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'venueDB';

// Middleware
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

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

// GET: Mengambil data reservasi (dengan pencarian, sort, paginasi)
app.get('/api/reservations', async (req, res) => {
    try {
        const { search = '', searchBy = 'namaClient', page = 1, limit = 10, sort = 'tanggalEvent', order = 'desc' } = req.query;
        
        let query = {};
        if (search) {
            // Jika searchBy adalah tanggal, kita perlu query rentang
            if (searchBy === 'tanggalEvent') {
                const searchDate = new Date(search);
                if (!isNaN(searchDate.getTime())) {
                    const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0));
                    const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999));
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

// GET: Mengambil satu data reservasi berdasarkan ID
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
        const count = await reservationsCollection.countDocuments();
        const nextId = String(count + 1).padStart(4, '0');
        const nomorInvoice = `INV/${year}/${month}-VE-${nextId}`;

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

// PUT: Mengupdate reservasi berdasarkan ID
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

// DELETE: Menghapus reservasi berdasarkan ID
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

// POST: Menambah item add-on baru
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
app.post('/api/reservations/:id/pembayaran', async (req, res) => {
    const { id } = req.params;
    const { jumlah, tanggal } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ message: "ID tidak valid" });
    if (!jumlah || !tanggal) return res.status(400).json({ message: "Jumlah dan tanggal pembayaran harus diisi." });
    const newPayment = {
        _id: new ObjectId(), jumlah: parseFloat(jumlah), tanggal: new Date(tanggal), createdAt: new Date()
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

// GET: Export data reservasi ke Excel
app.get('/api/reservations/export', async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Reservations');
        
        worksheet.columns = [
            { header: 'Nomor Invoice', key: 'nomorInvoice', width: 25 },
            { header: 'Tanggal Reservasi', key: 'tanggalReservasi', width: 15 },
            { header: 'Tanggal Event', key: 'tanggalEvent', width: 15 },
            { header: 'Nama Client', key: 'namaClient', width: 20 },
            { header: 'Venue', key: 'venue', width: 15 },
            { header: 'Kategori Event', key: 'kategoriEvent', width: 15 },
            { header: 'Nama Sales', key: 'namaSales', width: 15 },
            { header: 'Pax', key: 'pax', width: 10 },
            { header: 'Sub Total', key: 'subTotal', width: 15, style: { numFmt: '"Rp"#,##0' } },
            { header: 'DP', key: 'dp', width: 15, style: { numFmt: '"Rp"#,##0' } },
            { header: 'Dibatalkan', key: 'dibatalkan', width: 12 },
        ];

        const reservations = await reservationsCollection.find({}).toArray();
        worksheet.addRows(reservations);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="reservations.xlsx"');

        const buffer = await workbook.xlsx.writeBuffer();
        res.send(buffer);

    } catch (e) {
        res.status(500).json({ message: "Gagal mengekspor data", error: e.message });
    }
});

// POST: Import data dari Excel
app.post('/api/reservations/import', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('Tidak ada file yang diunggah.');
    }

    try {
        const workbook = new ExcelJS.Workbook();
        const buffer = req.file.buffer;
        await workbook.xlsx.load(buffer);
        
        const worksheet = workbook.getWorksheet(1);
        const reservationsToInsert = [];
        
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header row

            reservationsToInsert.push({
                nomorInvoice: row.getCell('A').value,
                tanggalReservasi: new Date(row.getCell('B').value),
                tanggalEvent: new Date(row.getCell('C').value),
                namaClient: row.getCell('D').value,
                venue: row.getCell('E').value,
                kategoriEvent: row.getCell('F').value,
                namaSales: row.getCell('G').value,
                pax: parseInt(row.getCell('H').value),
                subTotal: parseFloat(row.getCell('I').value),
                dp: parseFloat(row.getCell('J').value),
                dibatalkan: row.getCell('K').value === 'TRUE' || row.getCell('K').value === true,
                pembayaran: [],
                addons: [],
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        });

        if (reservationsToInsert.length > 0) {
            await reservationsCollection.insertMany(reservationsToInsert, { ordered: false });
        }
        
        res.status(201).json({ message: `${reservationsToInsert.length} data berhasil diimpor.` });

    } catch (e) {
        res.status(500).json({ message: "Gagal mengimpor data", error: e.message });
    }
});


app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
    connectDB();
});
