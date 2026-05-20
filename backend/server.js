// server.js — Express REST API (PostgreSQL version)
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');
const { initDB } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

function validate(body) {
  const { rank, first_name, last_name, room_number, floor_number } = body;
  const validRanks = ['ส.ต.','ส.ท.','ส.อ.','จ.ส.ต.','จ.ส.ท.','จ.ส.อ.','ร.ต.','ร.ท.','ร.อ.'];
  if (!validRanks.includes(rank))        return 'ยศไม่ถูกต้อง';
  if (!first_name || !first_name.trim()) return 'กรุณาระบุชื่อ';
  if (!last_name  || !last_name.trim())  return 'กรุณาระบุนามสกุล';
  if (!room_number)                       return 'กรุณาระบุห้อง';
  if (!floor_number || floor_number < 1)  return 'กรุณาระบุชั้น';
  return null;
}

initDB().then(pool => {

  // GET /api/surveys
  app.get('/api/surveys', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT r.*,
          (SELECT COUNT(*) FROM family_members WHERE resident_id = r.id)::int AS family_count,
          (SELECT COUNT(*) FROM vehicles WHERE resident_id = r.id AND type = 'car')::int AS car_count,
          (SELECT COUNT(*) FROM vehicles WHERE resident_id = r.id AND type = 'motorcycle')::int AS moto_count
        FROM residents r ORDER BY r.created_at DESC
      `);
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/surveys/:id
  app.get('/api/surveys/:id', async (req, res) => {
    try {
      const { rows: [resident] } = await pool.query('SELECT * FROM residents WHERE id = $1', [req.params.id]);
      if (!resident) return res.status(404).json({ success: false, error: 'ไม่พบข้อมูล' });
      const { rows: family_members } = await pool.query('SELECT * FROM family_members WHERE resident_id = $1 ORDER BY id', [resident.id]);
      const { rows: vehicles }       = await pool.query('SELECT * FROM vehicles WHERE resident_id = $1 ORDER BY id', [resident.id]);
      res.json({ success: true, data: { ...resident, family_members, vehicles } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/surveys
  app.post('/api/surveys', async (req, res) => {
    const errMsg = validate(req.body);
    if (errMsg) return res.status(400).json({ success: false, error: errMsg });

    const {
      rank, first_name, last_name, room_number, floor_number,
      family_head = 'self', family_members = [], vehicles = [],
      birthdate = null, id_card_address = null, phone = null
    } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [{ id: rid }] } = await client.query(
        `INSERT INTO residents
           (rank,first_name,last_name,room_number,floor_number,family_head,resident_count,birthdate,id_card_address,phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [rank, first_name.trim(), last_name.trim(), room_number.trim(), floor_number,
         family_head, family_members.length, birthdate||null, id_card_address||null, phone||null]
      );
      for (const m of family_members) {
        await client.query(
          `INSERT INTO family_members (resident_id,prefix,first_name,last_name,relationship,birthdate,id_card_address,work_address,phone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [rid, m.prefix, m.first_name.trim(), m.last_name.trim(), m.relationship.trim(),
           m.birthdate||null, m.id_card_address||null, m.work_address||null, m.phone||null]
        );
      }
      for (const v of vehicles) {
        if (v.plate_number && v.plate_number.trim()) {
          await client.query(
            `INSERT INTO vehicles (resident_id,type,plate_number,plate_province,brand,color) VALUES ($1,$2,$3,$4,$5,$6)`,
            [rid, v.type, v.plate_number.trim(), v.plate_province||null, v.brand||null, v.color||null]
          );
        }
      }
      await client.query('COMMIT');
      res.status(201).json({ success: true, id: rid, message: 'บันทึกข้อมูลเรียบร้อยแล้ว' });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
  });

  // PUT /api/surveys/:id
  app.put('/api/surveys/:id', async (req, res) => {
    const errMsg = validate(req.body);
    if (errMsg) return res.status(400).json({ success: false, error: errMsg });

    const {
      rank, first_name, last_name, room_number, floor_number,
      family_head = 'self', family_members = [], vehicles = [],
      birthdate = null, id_card_address = null, phone = null
    } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [ex] } = await client.query('SELECT id FROM residents WHERE id = $1', [req.params.id]);
      if (!ex) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'ไม่พบข้อมูล' }); }

      await client.query(
        `UPDATE residents SET rank=$1,first_name=$2,last_name=$3,room_number=$4,floor_number=$5,
         family_head=$6,resident_count=$7,birthdate=$8,id_card_address=$9,phone=$10,updated_at=NOW() WHERE id=$11`,
        [rank, first_name.trim(), last_name.trim(), room_number.trim(), floor_number,
         family_head, family_members.length, birthdate||null, id_card_address||null, phone||null, req.params.id]
      );
      await client.query('DELETE FROM family_members WHERE resident_id=$1', [req.params.id]);
      await client.query('DELETE FROM vehicles WHERE resident_id=$1', [req.params.id]);

      for (const m of family_members) {
        await client.query(
          `INSERT INTO family_members (resident_id,prefix,first_name,last_name,relationship,birthdate,id_card_address,work_address,phone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [req.params.id, m.prefix, m.first_name.trim(), m.last_name.trim(), m.relationship.trim(),
           m.birthdate||null, m.id_card_address||null, m.work_address||null, m.phone||null]
        );
      }
      for (const v of vehicles) {
        if (v.plate_number && v.plate_number.trim()) {
          await client.query(
            `INSERT INTO vehicles (resident_id,type,plate_number,plate_province,brand,color) VALUES ($1,$2,$3,$4,$5,$6)`,
            [req.params.id, v.type, v.plate_number.trim(), v.plate_province||null, v.brand||null, v.color||null]
          );
        }
      }
      await client.query('COMMIT');
      res.json({ success: true, message: 'อัปเดตข้อมูลเรียบร้อยแล้ว' });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
  });

  // DELETE /api/surveys/:id
  app.delete('/api/surveys/:id', async (req, res) => {
    try {
      const { rowCount } = await pool.query('DELETE FROM residents WHERE id=$1', [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ success: false, error: 'ไม่พบข้อมูล' });
      res.json({ success: true, message: 'ลบข้อมูลเรียบร้อยแล้ว' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/public/index.html')));

  app.listen(PORT, () => {
    console.log(`✅  Server running → http://localhost:${PORT}`);
  });

}).catch(err => {
  console.error('❌ Failed to initialize database:', err);
  process.exit(1);
});
