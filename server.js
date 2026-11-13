const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/booking");
});

app.get("/booking", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "booking.html"));
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "CMC Thailand Booking"
  });
});
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "CMC Thailand Booking"
  });
});


// วางฟังก์ชันสร้างการ์ดตรงนี้


app.post("/webhook", (req, res) => {
  console.log("LINE webhook received");
  res.sendStatus(200);
});
app.post("/webhook", (req, res) => {
  console.log("LINE webhook received");
  res.sendStatus(200);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
