const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors());

// IMPORTANT: We use a custom verify function to save the exact raw string of the body.
// Razorpay webhook signatures will ONLY match if the raw string is absolutely untouched.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// ==========================================
// FIREBASE CONFIGURATION
// ==========================================
// For Render deployment, you will paste your Firebase Service Account JSON 
// entirely into an environment variable named FIREBASE_SERVICE_ACCOUNT
const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT;
if (serviceAccountKey) {
  try {
    const serviceAccount = JSON.parse(serviceAccountKey);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin Initialized Successfully!");
  } catch (error) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT JSON string.", error);
  }
} else {
  console.log("WARNING: FIREBASE_SERVICE_ACCOUNT environment variable is missing.");
}

const db = admin.firestore();

// ==========================================
// CONSTANTS
// ==========================================
// Your secret webhook string from the Razorpay Dashboard (Settings -> Webhooks)
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'your_secret_here';

// ==========================================
// ROUTES
// ==========================================

// Health check route just to see if the server is awake
app.get('/', (req, res) => {
  res.send('Followers Hub Backend is online and running!');
});

// Razorpay Webhook Route
app.post('/webhook', async (req, res) => {
  console.log("Razorpay Webhook Hit!");

  // Step 1: Verify the Signature
  const signature = req.headers['x-razorpay-signature'];
  
  if (!signature) {
    return res.status(400).send("No signature provided");
  }

  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.error("Invalid Webhook Signature.");
    return res.status(400).send('Invalid signature');
  }

  // Step 2: Handle the specific Webhook Event
  const event = req.body.event;
  
  // We only look for successful payment captures
  if (event === 'payment.captured' || event === 'order.paid') {
    try {
      const paymentEntity = req.body.payload.payment.entity;
      
      // Razorpay deals in paise (multiply by 100). ₹500 is logged as 50000.
      // We divide by 100 to convert back to flat Indian Rupees.
      const amountInRupees = paymentEntity.amount / 100;
      
      // The user's email usually lies inside the payment root or custom notes JSON
      const userEmail = paymentEntity.email || (paymentEntity.notes && paymentEntity.notes.email);

      if (!userEmail) {
        console.error("Payment verified, but no Email was attached!");
        return res.status(400).send("No user email found in payment");
      }

      console.log(`Processing addition of ₹${amountInRupees} to ${userEmail}...`);

      // Step 3: Find User in Firestore and Increase Wallet Balance
      const usersRef = db.collection('users');
      const snapshot = await usersRef.where('email', '==', userEmail).get();

      if (snapshot.empty) {
        console.error(`User with email ${userEmail} does not exist in Firestore!`);
        return res.status(404).send("User not found");
      }

      const userDoc = snapshot.docs[0];
      
      // We use 'increment' to safely add the value to their existing balance
      await userDoc.ref.update({
        balance: admin.firestore.FieldValue.increment(amountInRupees)
      });

      console.log(`SUCCESS! Inserted ₹${amountInRupees} into ${userEmail}'s wallet.`);
      
    } catch (error) {
      console.error("Critical Runtime Error updating Firestore:", error);
      return res.status(500).send("Internal Server Error processing database");
    }
  }

  // Step 4: Finalize Webhook (Always return status 200 so Razorpay knows to stop retrying)
  res.status(200).send('Webhook Processed Successfully');
});

// Start the Express Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running heavily on port ${PORT}`);
});
