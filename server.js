const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const LINE_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN;

const LINE_SECRET =
  process.env.LINE_CHANNEL_SECRET;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
  console.error(
    "Unexpected PostgreSQL error:",
    error
  );
});

/*
  ต้องอยู่ก่อน Route ทั้งหมด
  ใช้อ่าน JSON และเก็บ Raw Body สำหรับ LINE
*/
app.use(
  express.json({
    verify: (req, res, buffer) => {
      req.rawBody = buffer;
    }
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/*
  หน้าเว็บ
*/
app.get("/", (req, res) => {
  res.redirect("/booking");
});

app.get("/booking", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "booking.html"
    )
  );
});

/*
  ตรวจสอบว่าเซิร์ฟเวอร์ทำงาน
*/
app.get("/health", async (req, res) => {
  try {
    await pool.query("select 1");

    return res.status(200).json({
      status: "ok",
      service: "CMC Thailand Booking",
      database: "connected"
    });
  } catch (error) {
    console.error(
      "Database health check error:",
      error
    );

    return res.status(503).json({
      status: "error",
      service: "CMC Thailand Booking",
      database: "disconnected"
    });
  }
});

/*
  ราคาสนามจากฝั่งเซิร์ฟเวอร์
  ไม่เชื่อราคาที่ส่งมาจากหน้าเว็บ
*/
const FIELD_PRICES = {
  "CMC Thailand A": 600,
  "CMC Thailand B": 700,
  "CMC Thailand C": 400,
  "CMC Thailand D": 200,
  "CMC Thailand E": 200
};

function createBookingCode() {
  const now = new Date();

  const datePart = now
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");

  const timestampPart = Date.now()
    .toString()
    .slice(-5);

  const randomPart = Math.floor(
    100 + Math.random() * 900
  );

  return (
    `CMC-${datePart}-` +
    `${timestampPart}${randomPart}`
  );
}

/*
  API บันทึกการจองจริงลง Supabase
*/
app.post(
  "/api/bookings",
  async (req, res) => {
    try {
      const {
        fieldName,
        bookingDate,
        startTime,
        duration
      } = req.body;

      const pricePerHour =
        FIELD_PRICES[fieldName];

      const durationHours =
        Number(duration);

      if (!pricePerHour) {
        return res.status(400).json({
          success: false,
          message: "ไม่พบสนามที่เลือก"
        });
      }

      if (!bookingDate || !startTime) {
        return res.status(400).json({
          success: false,
          message:
            "กรุณาเลือกวันที่และเวลา"
        });
      }

      if (
        !Number.isInteger(durationHours) ||
        durationHours < 1 ||
        durationHours > 4
      ) {
        return res.status(400).json({
          success: false,
          message:
            "ระยะเวลาจองต้องอยู่ระหว่าง 1–4 ชั่วโมง"
        });
      }

      /*
        แปลงวันที่และเวลาที่เลือก
        ให้เป็นเวลาไทย UTC+7
      */
      const startsAt = new Date(
        `${bookingDate}T${startTime}:00+07:00`
      );

      if (
        Number.isNaN(startsAt.getTime())
      ) {
        return res.status(400).json({
          success: false,
          message:
            "วันที่หรือเวลาไม่ถูกต้อง"
        });
      }

      if (
        startsAt.getTime() <= Date.now()
      ) {
        return res.status(400).json({
          success: false,
          message:
            "ไม่สามารถจองเวลาที่ผ่านมาแล้ว"
        });
      }

      const endsAt = new Date(
        startsAt.getTime() +
        durationHours * 60 * 60 * 1000
      );

      /*
        ไม่อนุญาตให้เวลาจองข้ามวัน
      */
      const endHourInThailand =
        Number(startTime.split(":")[0]) +
        durationHours;

      if (endHourInThailand > 24) {
        return res.status(400).json({
          success: false,
          message:
            "เวลาสิ้นสุดต้องไม่เกินเที่ยงคืน"
        });
      }

      const totalPrice =
        pricePerHour * durationHours;

      const bookingCode =
        createBookingCode();

      /*
        ฐานข้อมูลเป็นผู้ตรวจเวลาทับซ้อน
        Constraint ใน Supabase จะปฏิเสธ
        รายการที่เวลาชนกัน
      */
      const result = await pool.query(
        `
          insert into public.bookings (
            booking_code,
            field_name,
            starts_at,
            ends_at,
            duration_hours,
            price_per_hour,
            total_price,
            status
          )
          values (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            'confirmed'
          )
          returning
            id,
            booking_code,
            field_name,
            starts_at,
            ends_at,
            duration_hours,
            price_per_hour,
            total_price,
            status,
            created_at
        `,
        [
          bookingCode,
          fieldName,
          startsAt.toISOString(),
          endsAt.toISOString(),
          durationHours,
          pricePerHour,
          totalPrice
        ]
      );

      return res.status(201).json({
        success: true,
        booking: result.rows[0]
      });
    } catch (error) {
      console.error(
        "Create booking error:",
        {
          message: error.message,
          code: error.code,
          detail: error.detail
        }
      );

      /*
        PostgreSQL 23P01 =
        ช่วงเวลาทับกับรายการเดิม
      */
      if (error.code === "23P01") {
        return res.status(409).json({
          success: false,
          code: "TIME_SLOT_UNAVAILABLE",
          message:
            "ช่วงเวลานี้มีผู้จองแล้ว กรุณาเลือกเวลาอื่น"
        });
      }

      /*
        เลขที่การจองซ้ำ
      */
      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          code: "DUPLICATE_BOOKING_CODE",
          message:
            "กรุณากดยืนยันการจองใหม่อีกครั้ง"
        });
      }

      /*
        ตารางหรือคอลัมน์ไม่ตรง
      */
      if (
        error.code === "42P01" ||
        error.code === "42703"
      ) {
        return res.status(500).json({
          success: false,
          message:
            "โครงสร้างตาราง bookings ไม่ถูกต้อง"
        });
      }

      return res.status(500).json({
        success: false,
        message:
          "ระบบบันทึกการจองไม่สำเร็จ กรุณาลองใหม่"
      });
    }
  }
);

/*
  ตรวจสอบลายเซ็น LINE
*/
function verifyLineSignature(req) {
  if (!LINE_SECRET || !req.rawBody) {
    return false;
  }

  const signature =
    req.get("x-line-signature");

  if (!signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac(
      "sha256",
      LINE_SECRET
    )
    .update(req.rawBody)
    .digest("base64");

  const receivedBuffer =
    Buffer.from(signature);

  const expectedBuffer =
    Buffer.from(expectedSignature);

  if (
    receivedBuffer.length !==
    expectedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    receivedBuffer,
    expectedBuffer
  );
}

/*
  ตอบข้อความ LINE
*/
async function replyLine(
  replyToken,
  messages
) {
  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
        Authorization:
          `Bearer ${LINE_TOKEN}`
      },
      body: JSON.stringify({
        replyToken,
        messages
      })
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `LINE API error ` +
      `${response.status}: ` +
      errorText
    );
  }
}

function formatMoney(amount) {
  return new Intl.NumberFormat(
    "th-TH"
  ).format(amount);
}

function createBookingRow(
  icon,
  label,
  value
) {
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
        gravity: "center"
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
            color: "#94A3B8"
          },
          {
            type: "text",
            text: value,
            size: "sm",
            color: "#0F172A",
            weight: "bold",
            wrap: true,
            margin: "xs"
          }
        ]
      }
    ]
  };
}

function createBookingCard({
  bookingId,
  thaiDate,
  fieldName,
  startTime,
  endTime,
  duration,
  totalPrice
}) {
  return {
    type: "flex",
    altText:
      `จอง ${fieldName} สำเร็จ ` +
      `ยอด ${formatMoney(totalPrice)} บาท`,
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
            weight: "bold"
          },
          {
            type: "text",
            text:
              "การจองสนามของคุณได้รับการยืนยันแล้ว",
            color: "#DCFCE7",
            size: "sm",
            margin: "sm",
            wrap: true
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text:
              `เลขที่การจอง #${bookingId}`,
            size: "xs",
            color: "#94A3B8"
          },
          {
            type: "separator",
            margin: "lg",
            color: "#E2E8F0"
          },
          createBookingRow(
            "📅",
            "วันที่",
            thaiDate
          ),
          createBookingRow(
            "⚽",
            "สนาม",
            fieldName
          ),
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
                text:
                  "ยอดชำระหน้าสนาม",
                size: "sm",
                color: "#64748B"
              },
              {
                type: "text",
                text:
                  `${formatMoney(totalPrice)} บาท`,
                size: "xxl",
                weight: "bold",
                color: "#15803D",
                margin: "sm"
              }
            ]
          }
        ]
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
              text: "จองสนาม"
            }
          },
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: {
              type: "message",
              label: "ติดต่อแอดมิน",
              text: "ติดต่อแอดมิน"
            }
          }
        ]
      }
    }
  };
}

/*
  LINE Webhook มีเพียงจุดเดียว
*/
app.post(
  "/webhook",
  async (req, res) => {
    if (!verifyLineSignature(req)) {
      console.error(
        "Invalid LINE signature"
      );

      return res.sendStatus(401);
    }

    res.sendStatus(200);

    try {
      const events =
        req.body.events || [];

      for (const event of events) {
        if (
          event.type !== "message" ||
          event.message?.type !== "text"
        ) {
          continue;
        }

        const userMessage =
          event.message.text.trim();

        if (
          userMessage === "ทดสอบการ์ด"
        ) {
          const bookingCard =
            createBookingCard({
              bookingId: "CMC-0001",
              thaiDate:
                "วันอาทิตย์ที่ 22 พ.ย. 2569",
              fieldName:
                "CMC Thailand B",
              startTime: "18:00",
              endTime: "20:00",
              duration: 2,
              totalPrice: 1400
            });

          await replyLine(
            event.replyToken,
            [bookingCard]
          );
        }
      }
    } catch (error) {
      console.error(
        "Webhook processing error:",
        error
      );
    }
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);
