const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;

/*
  เก็บ raw body ไว้ตรวจลายเซ็นจาก LINE
*/
app.use(
  express.json({
    verify: (req, res, buffer) => {
      req.rawBody = buffer;
    },
  })
);

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
    service: "CMC Thailand Booking",
  });
});

/*
  ตรวจว่าข้อมูลถูกส่งมาจาก LINE จริง
*/
function verifyLineSignature(req) {
  if (!LINE_SECRET || !req.rawBody) {
    return false;
  }

  const signature = req.get("x-line-signature");

  if (!signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", LINE_SECRET)
    .update(req.rawBody)
    .digest("base64");

  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

/*
  ส่งข้อความกลับ LINE
*/
async function replyLine(replyToken, messages) {
  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken,
        messages,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LINE API error ${response.status}: ${errorText}`);
  }
}

/*
  จัดรูปแบบจำนวนเงิน
*/
function formatMoney(amount) {
  return new Intl.NumberFormat("th-TH").format(amount);
}

/*
  สร้างแถวรายละเอียดในการ์ด
*/
function createBookingRow(icon, label, value) {
  return {
    type: "box",
    layout: "horizontal",
    margin: "lg",
    alignItems: "center",
    contents: [
      {
        type: "text",
        text: icon,
        size: "lg",
        flex: 0,
        gravity: "center",
      },
      {
        type: "box",
        layout: "vertical",
        margin: "md",
        flex: 1,
        contents: [
          {
            type: "text",
            text: label,
            size: "xs",
            color: "#94A3B8",
          },
          {
            type: "text",
            text: value,
            size: "sm",
            color: "#0F172A",
            weight: "bold",
            wrap: true,
            margin: "xs",
          },
        ],
      },
    ],
  };
}

/*
  สร้างการ์ดยืนยันการจอง
*/
function createBookingCard({
  bookingId,
  thaiDate,
  fieldName,
  startTime,
  endTime,
  duration,
  totalPrice,
}) {
  return {
    type: "flex",
    altText: `จอง ${fieldName} สำเร็จ ยอด ${formatMoney(totalPrice)} บาท`,
    contents: {
      type: "bubble",
      size: "mega",

      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#15803D",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text: "จองสำเร็จ",
            color: "#FFFFFF",
            size: "xl",
            weight: "bold",
          },
          {
            type: "text",
            text: "การจองสนามของคุณได้รับการยืนยันแล้ว",
            color: "#DCFCE7",
            size: "sm",
            margin: "sm",
            wrap: true,
          },
        ],
      },

      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text: `เลขที่การจอง #${bookingId}`,
            size: "xs",
            color: "#94A3B8",
          },
          {
            type: "separator",
            margin: "lg",
            color: "#E2E8F0",
          },

          createBookingRow("📅", "วันที่", thaiDate),
          createBookingRow("⚽", "สนาม", fieldName),
          createBookingRow(
            "🕐",
            "เวลา",
            `${startTime} - ${endTime} น.`
          ),
          createBookingRow(
            "⏱",
            "ระยะเวลา",
            `${duration} ชั่วโมง`
          ),

          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#F0FDF4",
            cornerRadius: "14px",
            paddingAll: "16px",
            margin: "xl",
            contents: [
              {
                type: "text",
                text: "ยอดชำระหน้าสนาม",
                size: "sm",
                color: "#64748B",
              },
              {
                type: "text",
                text: `${formatMoney(totalPrice)} บาท`,
                size: "xxl",
                weight: "bold",
                color: "#15803D",
                margin: "sm",
              },
            ],
          },

          {
            type: "text",
            text: "กรุณามาถึงก่อนเวลาอย่างน้อย 10 นาที",
            size: "xs",
            color: "#64748B",
            wrap: true,
            margin: "lg",
          },
        ],
      },

      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#15803D",
            action: {
              type: "message",
              label: "จองสนามเพิ่ม",
              text: "จองสนาม",
            },
          },
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: {
              type: "message",
              label: "ติดต่อแอดมิน",
              text: "ติดต่อแอดมิน",
            },
          },
        ],
      },
    },
  };
}

/*
  รับข้อมูลจาก LINE
*/
app.post("/webhook", async (req, res) => {
  if (!verifyLineSignature(req)) {
    console.error("Invalid LINE signature");
    return res.sendStatus(401);
  }

  /*
    ตอบ 200 ให้ LINE ก่อน เพื่อไม่ให้รอนาน
  */
  res.sendStatus(200);

  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (
        event.type !== "message" ||
        event.message?.type !== "text"
      ) {
        continue;
      }

      const userMessage = event.message.text.trim();

      /*
        พิมพ์ "ทดสอบการ์ด" ใน LINE เพื่อทดสอบ
      */
      if (userMessage === "ทดสอบการ์ด") {
        const bookingCard = createBookingCard({
          bookingId: "CMC-0001",
          thaiDate: "วันอาทิตย์ที่ 22 พ.ย. 2569",
          fieldName: "สนามใหญ่ 2",
          startTime: "18:00",
          endTime: "20:00",
          duration: 2,
          totalPrice: 1400,
        });

        await replyLine(event.replyToken, [bookingCard]);
      }
    }
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
