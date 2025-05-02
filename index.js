require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const morgan = require("morgan");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');
const portArg = process.argv.find(arg => arg.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1]) : process.env.PORT || 3000;
const app = express();

// middleware
const corsOptions = {
  origin: ["http://localhost:5173", "http://localhost:5174", "https://theroyal-palace.web.app"],
  credentials: true,
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.kbbnu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Database connection verification route
app.get('/db-connection-status', (req, res) => {
  res.json({
    connected: client.topology?.isConnected() || false,
    dbName: 'building_management',
    collections: ['users', 'apartments', 'agreements', 'announcements', 'coupons']
  });
});

async function run() {
  try {
    // Log database and collections
    const db = client.db('building_management');
    const collections = ['users', 'apartments', 'agreements', 'announcements', 'coupons'];

    // console.log("📊 Database: building_management");
    // console.log("📋 Collections:");

    for (const collName of collections) {
      const count = await db.collection(collName).countDocuments();
      // console.log(`   - ${collName}: ${count} documents`);
    }

    const usersCollection = db.collection('users');
    const apartmentsCollection = db.collection('apartments');
    const agreementsCollection = db.collection('agreements');
    const announcementsCollection = db.collection('announcements');
    const couponsCollection = db.collection('coupons');

    // Middleware to check if the user is an admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.user.email;
      const user = await client.db('building_management').collection('users').findOne({ email });
      if (user.role !== 'admin') {
        return res.status(403).send('Access Denied');
      }
      next();
    };

    // Verifying JWT token
    const verifyToken = async (req, res, next) => {
      const token = req.cookies?.token;

      if (!token) {
        return res.status(401).send({ message: 'unauthorized access' });
      }
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          return res.status(401).send({ message: 'unauthorized access' });
        }
        req.user = decoded;
        next();
      });
    };

    // Generating JWT token
    app.post('/jwt', async (req, res) => {
      const { email } = req.body; // Destructure email from the request body
      if (!email) {
        return res.status(400).send({ message: 'Email is required' });
      }
      const token = jwt.sign({ email }, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: '365d',
      });
      res
        .cookie('token', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
        })
        .send({ success: true, token }); // Send the token in the response
    });

    // Endpoint to login
    app.get('/logout', async (req, res) => {
      try {
        res
          .clearCookie('token', {
            maxAge: 0,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
          })
          .send({ success: true });
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // save or update user in the database
    app.post("/users/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = req.body;
      const isExist = await usersCollection.findOne(query);
      if (isExist) {
        return res.status(400).json({ message: 'User already exists.' });
      }
      const result = await usersCollection.insertOne({ ...user, timestamp: Date.now(), role: 'user' });
      res.send(result);
    });

    // get all users
    app.get('/users', async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.status(200).json(users);
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // Get apartments with pagination and filtering
    app.get('/apartments', async (req, res) => {
      const { page = 1, limit = 6, minRent, maxRent } = req.query;
      const query = {};
      if (minRent && maxRent) {
        query.rent = { $gte: parseInt(minRent), $lte: parseInt(maxRent) };
      }
      const apartments = await apartmentsCollection.find(query)
        .limit(limit * 1)
        .skip((page - 1) * limit)
        .toArray();
      const count = await apartmentsCollection.countDocuments(query);
      res.json({
        apartments,
        totalPages: Math.ceil(count / limit),
        currentPage: page,
      });
    });

    // Endpoint to create a new agreement
    app.post('/apartments/agreement', async (req, res) => {
      const { userName, userEmail, floorNo, blockName, apartmentNo, rent, requestDate } = req.body;
      const existingAgreement = await agreementsCollection.findOne({ userEmail, apartmentNo });
      if (existingAgreement) {
        return res.status(400).json({ message: 'You have already applied for this apartment.' });
      }
      const agreement = {
        userName,
        userEmail,
        floorNo,
        blockName,
        apartmentNo,
        rent,
        status: 'pending',
        requestDate,
      };
      await agreementsCollection.insertOne(agreement);
      res.status(201).json({ message: 'Agreement successful.' });
    });

    // Endpoint to fetch agreements
    app.get('/agreements', async (req, res) => {
      try {
        const agreements = await agreementsCollection.find().toArray();
        res.send(agreements);
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // Endpoint to accept an agreement
    app.post('/agreements/:id/accept', async (req, res) => {
      const agreementId = req.params.id;
      try {
        const agreement = await agreementsCollection.findOne({ _id: new ObjectId(agreementId) });
        if (!agreement) {
          return res.status(404).json({ message: 'Agreement not found.' });
        }
        await agreementsCollection.updateOne(
          { _id: new ObjectId(agreementId) },
          { $set: { status: 'accepted' } }
        );
        await usersCollection.updateOne(
          { email: agreement.userEmail },
          { $set: { role: 'member' } }
        );
        res.status(200).json({ message: 'Agreement accepted successfully.' });
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // Endpoint to reject an agreement
    app.post('/agreements/:id/reject', async (req, res) => {
      const agreementId = req.params.id;
      try {
        const agreement = await agreementsCollection.findOne({ _id: new ObjectId(agreementId) });
        if (!agreement) {
          return res.status(404).json({ message: 'Agreement not found.' });
        }
        await agreementsCollection.updateOne(
          { _id: new ObjectId(agreementId) },
          { $set: { status: 'rejected' } }
        );
        res.status(200).json({ message: 'Agreement rejected successfully.' });
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // Endpoint to post an announcement
    app.post('/announcements', async (req, res) => {
      const { title, description } = req.body;

      const announcement = {
        title,
        description,
        timestamp: new Date(),
      };

      try {
        await announcementsCollection.insertOne(announcement);
        res.status(201).json({ message: 'Announcement made successfully' });
      } catch (error) {
        res.status(500).json({ message: 'Failed to make announcement' });
      }
    });

    // Endpoint to fetch announcements
    app.get('/announcements', async (req, res) => {
      try {
        const announcements = await announcementsCollection.find().toArray();
        res.status(200).json(announcements);
      } catch (error) {
        res.status(500).json({ message: 'Failed to fetch announcements' });
      }
    });

    app.get('/users/:email', async (req, res) => {
      const email = req.params.email;
      try {
        const user = await usersCollection.findOne({ email });
        if (!user) {
          return res.status(200).json(null);
        }
        res.status(200).json(user);
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // Endpoint to fetch users with accepted agreements
    app.get('/accepted-agreements-users', async (req, res) => {
      try {
        const acceptedAgreements = await agreementsCollection.find({ status: 'accepted' }).toArray();
        const userEmails = acceptedAgreements.map(agreement => agreement.userEmail);
        const users = await usersCollection.find({ email: { $in: userEmails } }).toArray();
        res.status(200).json(users);
      } catch (err) {
        console.error('Error fetching accepted agreements users:', err);
        res.status(500).send(err);
      }
    });

    // Endpoint to set agreement status to pending
    app.post('/agreements/:id/pending', async (req, res) => {
      const agreementId = req.params.id;
      try {
        const agreement = await agreementsCollection.findOne({ _id: new ObjectId(agreementId) });
        if (!agreement) {
          return res.status(404).json({ message: 'Agreement not found.' });
        }
        await agreementsCollection.updateOne(
          { _id: new ObjectId(agreementId) },
          { $set: { status: 'pending' } }
        );
        res.status(200).json({ message: 'Agreement status set to pending successfully.' });
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // Endpoint to delete an agreement
    app.delete('/agreements/:id', async (req, res) => {
      const agreementId = req.params.id;
      try {
        const result = await agreementsCollection.deleteOne({ _id: new ObjectId(agreementId) });
        if (result.deletedCount === 0) {
          return res.status(404).json({ message: 'Agreement not found.' });
        }
        res.status(200).json({ message: 'Agreement deleted successfully.' });
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // Endpoint to fetch pending agreements with user details
    app.get('/pending-agreements', async (req, res) => {
      try {
        // Find all pending agreements
        const pendingAgreements = await agreementsCollection.find({ status: 'pending' }).toArray();

        // Get all the user emails from agreements
        const userEmails = [...new Set(pendingAgreements.map(agreement => agreement.userEmail))];

        // Fetch user details for these emails
        const users = await usersCollection.find({ email: { $in: userEmails } }).toArray();

        // Create a map of email to user details for faster lookup
        const userMap = {};
        users.forEach(user => {
          userMap[user.email] = user;
        });

        // Enhance agreement data with user details
        const enhancedAgreements = pendingAgreements.map(agreement => {
          const user = userMap[agreement.userEmail] || {};
          return {
            ...agreement,
            userDetails: {
              name: user.name || agreement.userName || "Unknown User",
              photoURL: user.photoURL || null,
              timestamp: user.timestamp || Date.now()
            }
          };
        });

        res.status(200).json(enhancedAgreements);
      } catch (err) {
        console.error('Error fetching pending agreements:', err);
        res.status(500).json({ message: 'Failed to fetch pending agreements' });
      }
    });

    // Endpoint to create a new coupon
    app.post('/coupons', async (req, res) => {
      const { title, description, code, discountPercentage } = req.body;
      const coupon = {
        title,
        description,
        code,
        discountPercentage,
      };
      try {
        await couponsCollection.insertOne(coupon);
        res.status(201).json({ message: 'Coupon created successfully' });
      } catch (error) {
        res.status(500).json({ message: 'Failed to create coupon' });
      }
    });

    // Endpoint to fetch all coupons
    app.get('/coupons', async (req, res) => {
      try {
        const coupons = await couponsCollection.find().toArray();
        res.status(200).json(coupons);
      } catch (error) {
        res.status(500).json({ message: 'Failed to fetch coupons' });
      }
    });

    // Endpoint to delete a coupon
    app.delete('/coupons/:id', async (req, res) => {
      const couponId = req.params.id;
      try {
        const result = await couponsCollection.deleteOne({ _id: new ObjectId(couponId) });
        if (result.deletedCount === 0) {
          return res.status(404).json({ message: 'Coupon not found.' });
        }
        res.status(200).json({ message: 'Coupon deleted successfully.' });
      } catch (err) {
        console.error('Error deleting coupon:', err);
        res.status(500).send(err);
      }
    });

    app.get('/agreements/user/:email', async (req, res) => {
      const email = req.params.email;
      try {
        const agreements = await agreementsCollection.find({ userEmail: email }).toArray();
        res.status(200).json(agreements);
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // Endpoint to get database statistics
    app.get('/database-stats', async (req, res) => {
      try {
        const totalRooms = await apartmentsCollection.countDocuments();
        const availableRooms = await apartmentsCollection.countDocuments({ status: 'available' });
        const unavailableRooms = await apartmentsCollection.countDocuments({ status: { $ne: 'available' } });
        const totalUsers = await usersCollection.countDocuments();
        const totalMembers = await usersCollection.countDocuments({ role: 'member' });

        const availableRoomsPercentage = (availableRooms / totalRooms) * 100;
        const unavailableRoomsPercentage = (unavailableRooms / totalRooms) * 100;

        res.status(200).json({
          totalRooms,
          availableRoomsPercentage,
          unavailableRoomsPercentage,
          totalUsers,
          totalMembers,
        });
      } catch (err) {
        res.status(500).send(err);
      }
    });


    // Endpoint for stripe payment
    app.post('/create-checkout-session', async (req, res) => {
      const { priceId } = req.body;

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: `${process.env.CLIENT_URL}/success.html`,
        cancel_url: `${process.env.CLIENT_URL}/cancel.html`,
      });

      res.json({ id: session.id });
    });
  } finally {
  }
}
// run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("The Royal Palace is running");
});

app.listen(port, () => {
  // console.log(`The Royal Palace is running on port ${port}`);
});