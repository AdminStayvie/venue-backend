// index.js (Restructured for Separate Collections)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3001;
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'venueDB';

// Multer Config
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, 'uploads');
        fs.mkdirSync(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (!mongoUri) {
    console.error("Error: MONGO_URI is not defined in .env file");
    process.exit(1);
}

const client = new MongoClient(mongoUri);
let db;
let reservationsCollection, addonsCollection, paymentsCollection;

async function connectDB() {
    try {
        await client.connect();
        db = client.db(dbName);
        reservationsCollection = db.collection('reservations');
        addonsCollection = db.collection('addons');
        paymentsCollection = db.collection('payments');
        console.log(`Connected to MongoDB, database: ${dbName}`);
    } catch (e) {
        console.error("Failed to connect to MongoDB", e);
        process.exit(1);
    }
}

// === RESERVATIONS API ===

// GET all reservations with aggregated data
app.get('/api/reservations', async (req, res) => {
    try {
        const { search = '', searchBy = 'namaClient', page = 1, limit = 10, sort = 'tanggalEvent', order = 'desc' } = req.query;
        
        let matchStage = {};
        if (search) {
            if (searchBy === 'tanggalEvent') {
                // Pastikan tanggal diformat dengan benar untuk query
                const searchDate = new Date(`${search}T00:00:00.000Z`);
                if (!isNaN(searchDate.getTime())) {
                    const startOfDay = new Date(searchDate);
                    startOfDay.setUTCHours(0, 0, 0, 0);
                    const endOfDay = new Date(searchDate);
                    endOfDay.setUTCHours(23, 59, 59, 999);
                    matchStage[searchBy] = { $gte: startOfDay, $lte: endOfDay };
                }
            } else {
                matchStage[searchBy] = { $regex: search, $options: 'i' };
            }
        }
        
        const sortOrder = order === 'asc' ? 1 : -1;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const pipeline = [
            { $match: matchStage },
            { $sort: { [sort]: sortOrder } },
            { $skip: skip },
            { $limit: parseInt(limit) },
            {
                $lookup: {
                    from: 'addons',
                    localField: '_id',
                    foreignField: 'reservationId',
                    as: 'addons'
                }
            },
        ];

        const reservations = await reservationsCollection.aggregate(pipeline).toArray();
        const total = await reservationsCollection.countDocuments(matchStage);

        res.json({
            data: reservations,
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(total / parseInt(limit))
        });
    } catch (e) {
        res.status(500).json({ message: "Failed to get reservations", error: e.message });
    }
});

// GET single reservation with details
app.get('/api/reservations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });
        
        const reservationId = new ObjectId(id);
        const reservation = await reservationsCollection.findOne({ _id: reservationId });
        if (!reservation) return res.status(404).json({ message: "Reservation not found" });

        const addons = await addonsCollection.find({ reservationId: reservationId }).toArray();
        const payments = await paymentsCollection.find({ reservationId: reservationId }).toArray();

        res.json({ ...reservation, addons, pembayaran: payments });
    } catch (e) {
        res.status(500).json({ message: "Failed to get reservation details", error: e.message });
    }
});

// POST new reservation
app.post('/api/reservations', async (req, res) => {
    try {
        const newData = req.body;
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');

        const lastInvoice = await reservationsCollection.findOne({ nomorInvoice: { $regex: `^INV/${year}/${month}-VE-` } }, { sort: { nomorInvoice: -1 } });
        let nextIdNumber = lastInvoice ? parseInt(lastInvoice.nomorInvoice.split('-').pop()) + 1 : 1;
        const nextId = String(nextIdNumber).padStart(4, '0');
        const nomorInvoice = `INV/${year}/${month}-VE-${nextId}`;

        const reservationData = {
            ...newData,
            nomorInvoice,
            _id: new ObjectId(),
            // PERUBAHAN: Memastikan tanggal disimpan sebagai UTC-midnight
            tanggalReservasi: new Date(`${newData.tanggalReservasi}T00:00:00.000Z`),
            tanggalEvent: new Date(`${newData.tanggalEvent}T00:00:00.000Z`),
            pax: parseInt(newData.pax),
            hargaPerPax: parseFloat(newData.hargaPerPax),
            subTotal: parseFloat(newData.subTotal),
            dp: parseFloat(newData.dp) || 0,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        
        const result = await reservationsCollection.insertOne(reservationData);

        if (reservationData.dp > 0) {
            const dpPayment = {
                reservationId: reservationData._id,
                jumlah: reservationData.dp,
                tanggal: new Date(`${newData.tanggalReservasi}T00:00:00.000Z`), // Menggunakan tanggal reservasi
                buktiUrl: '',
                createdAt: new Date(),
            };
            await addPayment(dpPayment); // Use the new centralized function
        }

        res.status(201).json({ message: "Reservation created successfully", data: result });
    } catch (e) {
        res.status(500).json({ message: "Failed to create reservation", error: e.message });
    }
});

// DELETE reservation and its children
app.delete('/api/reservations/:id', async (req, res) => {
    const session = client.startSession();
    try {
        await session.withTransaction(async () => {
            const { id } = req.params;
            if (!ObjectId.isValid(id)) throw new Error("Invalid ID");
            const reservationId = new ObjectId(id);

            await addonsCollection.deleteMany({ reservationId: reservationId }, { session });
            await paymentsCollection.deleteMany({ reservationId: reservationId }, { session });
            const result = await reservationsCollection.deleteOne({ _id: reservationId }, { session });

            if (result.deletedCount === 0) {
                throw new Error("Reservation not found");
            }
        });
        res.json({ message: "Reservation and all related data deleted successfully" });
    } catch (e) {
        res.status(500).json({ message: "Failed to delete reservation", error: e.message });
    } finally {
        await session.endSession();
    }
});

// === ADDONS API ===

app.post('/api/addons', async (req, res) => {
    try {
        const { reservationId, item, pax, hargaPerPax, subTotal, catatan } = req.body;
        if (!ObjectId.isValid(reservationId)) return res.status(400).json({ message: "Invalid Reservation ID" });

        const newAddon = {
            _id: new ObjectId(),
            reservationId: new ObjectId(reservationId),
            item,
            pax: parseInt(pax),
            hargaPerPax: parseFloat(hargaPerPax),
            subTotal: parseFloat(subTotal),
            catatan: catatan || "",
            createdAt: new Date()
        };
        await addonsCollection.insertOne(newAddon);
        res.status(201).json({ message: "Addon added successfully", data: newAddon });
    } catch (e) {
        res.status(500).json({ message: "Failed to add addon", error: e.message });
    }
});

// === PAYMENTS API ===

// Central function to add payment and generate receipt number
async function addPayment(paymentData) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');

    const pipeline = [
        { $match: { "nomorKwitansi": { $regex: `^NOTA/${year}/${month}-SDP-` } } },
        { $sort: { "nomorKwitansi": -1 } },
        { $limit: 1 }
    ];
    const lastPaymentResult = await paymentsCollection.aggregate(pipeline).toArray();
    
    let nextKwitansiNum = 1;
    if (lastPaymentResult.length > 0) {
        const lastNum = parseInt(lastPaymentResult[0].nomorKwitansi.split('-').pop());
        nextKwitansiNum = lastNum + 1;
    }

    const kwitansiId = String(nextKwitansiNum).padStart(4, '0');
    paymentData.nomorKwitansi = `NOTA/${year}/${month}-SDP-${kwitansiId}`;
    paymentData._id = new ObjectId();

    return await paymentsCollection.insertOne(paymentData);
}

app.post('/api/payments', upload.single('bukti'), async (req, res) => {
    try {
        const { reservationId, jumlah, tanggal } = req.body;
        if (!ObjectId.isValid(reservationId)) return res.status(400).json({ message: "Invalid Reservation ID" });

        const newPayment = {
            reservationId: new ObjectId(reservationId),
            jumlah: parseFloat(jumlah),
            // PERUBAHAN: Memastikan tanggal disimpan sebagai UTC-midnight
            tanggal: new Date(`${tanggal}T00:00:00.000Z`),
            buktiUrl: req.file ? `/uploads/${req.file.filename}` : '',
            createdAt: new Date()
        };

        const result = await addPayment(newPayment);
        res.status(201).json({ message: "Payment added successfully", data: result });
    } catch (e) {
        res.status(500).json({ message: "Failed to add payment", error: e.message });
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    connectDB();
});
