//? dependencies
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

//configuration
const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

// ! verify user by jwt

function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "UnAuthorized access" });
  }
  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: "Forbidden access" });
    }
    req.decoded = decoded;
    next();
  });
}
// ? -------------------- MONGODB -----------------------------

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@mlab.pkp1w.mongodb.net/myFirstDatabase?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});

async function run() {
  try {
    await client.connect();
    const servicesCollection = await client
      .db("doctors-portal")
      .collection("services");
    const bookingCollection = await client
      .db("doctors-portal")
      .collection("booking");
    const userCollection = await client.db("doctors-portal").collection("user");
    const doctorCollection = await client
      .db("doctors-portal")
      .collection("doctor");
    const paymentCollection = await client
      .db("doctors-portal")
      .collection("payment");

    // ? middleware function for verify admin
    const verifyAdmin = async (req, res, next) => {
      const requester = req.decoded.email;
      const requesterAccount = await userCollection.findOne({
        email: requester,
      });
      if (requesterAccount.role === "admin") {
        next();
      } else {
        res.status(403).send({ message: "forbidden" });
      }
    };

    // ? create payment process with stripe
    app.post('/create-payment-intent',async(req, res)=>{
      const {price} = req.body;
      const amount = price * 100
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency : 'usd',
        payment_method_types : ['card']
      })
      res.send({clientSecret : paymentIntent.client_secret})

    })

    //  ! send all service data to client
    app.get("/service", async (req, res) => {
      const service = await servicesCollection
        .find({})
        .project({ name: 1 })
        .toArray();
      res.send(service);
    });

    // ! get al admin data
    app.get("/admin/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email: email });
      const isAdmin = user.role === "admin";
      res.send({ admin: isAdmin });
    });

    // ! make an user to admin
    app.put("/user/admin/:email", verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;

      const filter = { email: email };
      const updateDoc = {
        $set: { role: "admin" },
      };
      const result = await userCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // ! -----------------

    // ! save user information in database
    app.put("/user/:email", async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const filter = { email: email };
      const options = { upsert: true };
      const updateDoc = {
        $set: user,
      };
      const result = await userCollection.updateOne(filter, updateDoc, options);

      const accessToken = jwt.sign({ email }, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1h",
      });

      res.send({ result, accessToken });
    });

    // ! get all user information ;
    app.get("/users", verifyJWT, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    // ! --------------------
    // get available services
    app.get("/available", async (req, res) => {
      const date = req.query.date;

      //! step 1 get all services
      const services = await servicesCollection.find().toArray();

      // ! get the booking of that day
      const bookings = await bookingCollection.find({ date: date }).toArray();

      services.forEach((service) => {
        const serviceBookings = bookings.filter(
          (b) => b.treatment === service.name
        );
        const bookedSlots = serviceBookings.map((book) => book.slots);
        service.slots = service.slots.filter(
          (slot) => !bookedSlots.includes(slot)
        );
      });

      res.send(services);
    });

    // get booking data by user email address .
    app.get("/booking", verifyJWT, async (req, res) => {
      const patient = req.query.patient;
      const decodedEmail = req.decoded.email;

      if (patient === decodedEmail) {
        const result = await bookingCollection.find({ patient }).toArray();
        return res.send(result);
      }

      return res.status(403).send({ message: "Forbidden Access" });
    });

    // ! get a single booking data for make payment .
    app.get('/booking/:id', verifyJWT, async(req,res)=>{
      const id = req.params.id ;
      const result = await bookingCollection.findOne({_id: ObjectId(id)})
      res.send(result)
    })

    // post booking data
    app.post("/booking", async (req, res) => {
      const booking = req.body;
      const query = {
        treatment: booking.treatment,
        date: booking.date,
        patient: booking.patient,
      };
      const exists = await bookingCollection.findOne(query);
      if (exists) {
        return res.send({ success: false, booking: exists });
      } else {
        const result = await bookingCollection.insertOne(booking);
        res.send({ success: true, result });
      }
    });

    // store payment data in the server

    app.patch('/booking/:id',async (req, res) => {
      const {id} = req.params ;
      const payment = req.body
      const filter = {_id : ObjectId(id)}
      const updateDoc = {
        $set : {
          paid : true ,
          transactionId : payment.transactionId
        }
       }

       const updatedBooking = await bookingCollection.updateOne(filter,updateDoc)
       const result = await paymentCollection.insertOne(payment)
        res.send(updatedBooking)
    })

    //  ? get all doctors
    app.get("/doctor", verifyJWT, verifyAdmin, async (req, res) => {
      const doctors = await doctorCollection.find().toArray();
      res.send(doctors);
    });

    // ! add doctor information in database .
    app.post("/doctor", verifyJWT, verifyAdmin, async (req, res) => {
      const doctor = req.body;
      const result = await doctorCollection.insertOne(doctor);
      res.send(result);
    });

    // ! delete a single doctor information
    app.delete("/doctor/:email", verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const filter = { email: email };
      const result = await doctorCollection.deleteOne(filter);
      res.send(result);
    });
  } finally {
  }
}

run().catch(console.dir);
// ? -------------------- MONGODB -----------------------------
app.get("/", (req, res) => {
  res.send("Server Is Running");
});
app.listen(port, () => {
  console.log(`Server is Running On Port : ${port}`);
});
