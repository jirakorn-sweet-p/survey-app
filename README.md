# ระบบสำรวจข้อมูลผู้พักอาศัย — แฟลต 2

## โครงสร้างโปรเจค

```
survey-app/
├── backend/
│   ├── server.js        ← Express REST API
│   ├── db.js            ← SQLite database setup
│   ├── package.json
│   └── survey.db        ← สร้างอัตโนมัติเมื่อรันครั้งแรก
└── frontend/
    └── public/
        └── index.html   ← หน้าเว็บทั้งหมด (Single Page App)
```

## วิธีติดตั้งและรัน

### ความต้องการ
- Node.js v18 ขึ้นไป (https://nodejs.org)

### ขั้นตอน

```bash
# 1. เข้าโฟลเดอร์ backend
cd backend

# 2. ติดตั้ง dependencies
npm install

# 3. รันเซิร์ฟเวอร์
npm start
```

เปิดเบราว์เซอร์ที่ http://localhost:3000

---

## API Endpoints

| Method | URL | คำอธิบาย |
|--------|-----|----------|
| GET | /api/surveys | ดูรายการทั้งหมด |
| GET | /api/surveys/:id | ดูรายการเดี่ยว |
| POST | /api/surveys | เพิ่มข้อมูล |
| PUT | /api/surveys/:id | แก้ไขข้อมูล |
| DELETE | /api/surveys/:id | ลบข้อมูล |

## ตัวอย่าง POST /api/surveys

```json
{
  "rank": "ร.ต.",
  "first_name": "สมชาย",
  "last_name": "ใจดี",
  "room_number": "201",
  "floor_number": 2,
  "family_head": "self",
  "family_members": [
    {
      "prefix": "นาง",
      "first_name": "สมหญิง",
      "last_name": "ใจดี",
      "relationship": "ภรรยา"
    }
  ],
  "vehicles": [
    { "type": "car", "plate_number": "กข 1234 กทม" },
    { "type": "motorcycle", "plate_number": "ขอ 5678 กทม" }
  ]
}
```

## โครงสร้างฐานข้อมูล (SQLite)

### ตาราง residents
| คอลัมน์ | ประเภท | คำอธิบาย |
|---------|--------|----------|
| id | INTEGER PK | รหัสอัตโนมัติ |
| rank | TEXT | ยศ |
| first_name | TEXT | ชื่อ |
| last_name | TEXT | นามสกุล |
| room_number | TEXT | ห้องที่ |
| floor_number | INTEGER | ชั้นที่ |
| family_head | TEXT | หัวหน้าครอบครัว |
| resident_count | INTEGER | จำนวนผู้พักอาศัย |
| created_at | DATETIME | วันที่บันทึก |

### ตาราง family_members
| คอลัมน์ | ประเภท | คำอธิบาย |
|---------|--------|----------|
| id | INTEGER PK | รหัสอัตโนมัติ |
| resident_id | INTEGER FK | อ้างอิง residents |
| prefix | TEXT | คำนำหน้าชื่อ |
| first_name | TEXT | ชื่อ |
| last_name | TEXT | นามสกุล |
| relationship | TEXT | ความสัมพันธ์ |

### ตาราง vehicles
| คอลัมน์ | ประเภท | คำอธิบาย |
|---------|--------|----------|
| id | INTEGER PK | รหัสอัตโนมัติ |
| resident_id | INTEGER FK | อ้างอิง residents |
| type | TEXT | 'car' หรือ 'motorcycle' |
| plate_number | TEXT | ทะเบียนรถ |
