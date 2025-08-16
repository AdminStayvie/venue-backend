// migrate.js (For Restructuring to Separate Collections)
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'venueDB';

if (!mongoUri) {
    console.error("Error: MONGO_URI is not defined in .env file.");
    process.exit(1);
}

const client = new MongoClient(mongoUri);

async function migrate() {
    try {
        await client.connect();
        console.log("🔌 Connected to MongoDB...");
        const db = client.db(dbName);
        const oldReservationsCollection = db.collection('reservations');
        const newReservationsCollection = db.collection('reservations_new');
        const addonsCollection = db.collection('addons');
        const paymentsCollection = db.collection('payments');

        // Clear new collections to prevent duplicates on re-run
        await newReservationsCollection.deleteMany({});
        await addonsCollection.deleteMany({});
        await paymentsCollection.deleteMany({});
        console.log("🗑️  Cleaned up new collections.");

        const reservations = await oldReservationsCollection.find().toArray();
        console.log(`🚚 Found ${reservations.length} reservations to migrate.`);

        for (const res of reservations) {
            const reservationId = res._id; // Keep original ID

            // 1. Migrate Addons
            if (res.addons && res.addons.length > 0) {
                const addonsToInsert = res.addons.map(addon => ({
                    ...addon,
                    reservationId: reservationId, // Link to parent
                }));
                await addonsCollection.insertMany(addonsToInsert);
            }

            // 2. Migrate Payments
            if (res.pembayaran && res.pembayaran.length > 0) {
                const paymentsToInsert = res.pembayaran.map(payment => ({
                    ...payment,
                    reservationId: reservationId, // Link to parent
                }));
                await paymentsCollection.insertMany(paymentsToInsert);
            }

            // 3. Create new reservation document without embedded arrays
            const { addons, pembayaran, ...newReservationData } = res;
            await newReservationsCollection.insertOne(newReservationData);
        }

        console.log("✅ Migration complete!");
        console.log("👉 Now, you should manually perform these steps:");
        console.log("   1. Drop the old 'reservations' collection.");
        console.log("   2. Rename 'reservations_new' to 'reservations'.");

    } catch (e) {
        console.error("❌ Migration failed:", e);
    } finally {
        await client.close();
        console.log("🚪 MongoDB connection closed.");
    }
}

migrate();
