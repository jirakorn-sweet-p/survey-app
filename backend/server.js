require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');
const crypto     = require('crypto');
const { initDB } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ─── Simple token store (in-memory) ─────────────────────────────────────────
const sessions = new Map(); // token -> { user, exp }

// Default admin credentials (override via .env)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin1234';

function createToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, exp: Date.now() + 8 * 60 * 60 * 1000 }); // 8hr
  return token;
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const session = sessions.get(token);
  if (!session || Date.now() > session.exp) {
    return res.status(401).json({ success: false, error: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  req.user = session.user;
  next();
}

// ─── Validation ──────────────────────────────────────────────────────────────
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

// ─── Boot ────────────────────────────────────────────────────────────────────
initDB().then(pool => {

  // POST /api/auth/login
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      const token = createToken(username);
      return res.json({ success: true, token, username });
    }
    res.status(401).json({ success: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    sessions.delete(token);
    res.json({ success: true });
  });

  // GET /api/auth/me
  app.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({ success: true, username: req.user });
  });

  // GET /api/surveys — protected
  app.get('/api/surveys', authMiddleware, async (req, res) => {
    try {
      const { search = '', sort = 'created_at', order = 'desc' } = req.query;
      const validSorts = { rank:'rank', name:'first_name', floor:'floor_number', created:'created_at' };
      const sortCol = validSorts[sort] || 'created_at';
      const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
      const searchParam = `%${search}%`;
      const { rows } = await pool.query(`
        SELECT r.*,
          (SELECT COUNT(*) FROM family_members WHERE resident_id=r.id)::int AS family_count,
          (SELECT COUNT(*) FROM vehicles WHERE resident_id=r.id AND type='car')::int AS car_count,
          (SELECT COUNT(*) FROM vehicles WHERE resident_id=r.id AND type='motorcycle')::int AS moto_count
        FROM residents r
        WHERE r.first_name ILIKE $1 OR r.last_name ILIKE $1 OR r.rank ILIKE $1
          OR r.room_number ILIKE $1 OR r.position ILIKE $1
        ORDER BY ${sortCol} ${sortOrder}
      `, [searchParam]);
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/surveys/export — Excel export (protected)
  app.get('/api/surveys/export', authMiddleware, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT r.rank, r.position, r.first_name, r.last_name,
               r.room_number, r.floor_number, r.phone, r.birthdate,
               r.id_card_address, r.family_head, r.resident_count,
               r.created_at
        FROM residents r ORDER BY r.floor_number, r.room_number
      `);
      // Return JSON — frontend will convert to Excel using SheetJS
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/surveys/:id — protected
  app.get('/api/surveys/:id', authMiddleware, async (req, res) => {
    try {
      const { rows: [resident] } = await pool.query('SELECT * FROM residents WHERE id=$1', [req.params.id]);
      if (!resident) return res.status(404).json({ success: false, error: 'ไม่พบข้อมูล' });
      const { rows: family_members } = await pool.query('SELECT * FROM family_members WHERE resident_id=$1 ORDER BY id', [resident.id]);
      const { rows: vehicles }       = await pool.query('SELECT * FROM vehicles WHERE resident_id=$1 ORDER BY id', [resident.id]);
      res.json({ success: true, data: { ...resident, family_members, vehicles } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/surveys — public (anyone can submit survey)
  app.post('/api/surveys', async (req, res) => {
    const errMsg = validate(req.body);
    if (errMsg) return res.status(400).json({ success: false, error: errMsg });
    const {
      rank, first_name, last_name, room_number, floor_number,
      family_head='self', family_members=[], vehicles=[],
      position=null, birthdate=null, id_card_address=null, phone=null
    } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [{ id: rid }] } = await client.query(
        `INSERT INTO residents
           (rank,first_name,last_name,room_number,floor_number,family_head,resident_count,position,birthdate,id_card_address,phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [rank,first_name.trim(),last_name.trim(),room_number.trim(),floor_number,
         family_head,family_members.length,position||null,birthdate||null,id_card_address||null,phone||null]
      );
      for (const m of family_members) {
        await client.query(
          `INSERT INTO family_members (resident_id,prefix,first_name,last_name,relationship,birthdate,id_card_address,work_address,phone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [rid,m.prefix,m.first_name.trim(),m.last_name.trim(),m.relationship.trim(),
           m.birthdate||null,m.id_card_address||null,m.work_address||null,m.phone||null]
        );
      }
      for (const v of vehicles) {
        if (v.plate_number?.trim()) {
          await client.query(
            `INSERT INTO vehicles (resident_id,type,plate_number,plate_province,brand,color) VALUES ($1,$2,$3,$4,$5,$6)`,
            [rid,v.type,v.plate_number.trim(),v.plate_province||null,v.brand||null,v.color||null]
          );
        }
      }
      await client.query('COMMIT');
      res.status(201).json({ success:true, id:rid, message:'บันทึกข้อมูลเรียบร้อยแล้ว' });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ success:false, error:err.message });
    } finally { client.release(); }
  });

  // PUT /api/surveys/:id — protected
  app.put('/api/surveys/:id', authMiddleware, async (req, res) => {
    const errMsg = validate(req.body);
    if (errMsg) return res.status(400).json({ success:false, error:errMsg });
    const {
      rank,first_name,last_name,room_number,floor_number,
      family_head='self',family_members=[],vehicles=[],
      position=null,birthdate=null,id_card_address=null,phone=null
    } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows:[ex] } = await client.query('SELECT id FROM residents WHERE id=$1',[req.params.id]);
      if (!ex) { await client.query('ROLLBACK'); return res.status(404).json({success:false,error:'ไม่พบข้อมูล'}); }
      await client.query(
        `UPDATE residents SET rank=$1,first_name=$2,last_name=$3,room_number=$4,floor_number=$5,
         family_head=$6,resident_count=$7,position=$8,birthdate=$9,id_card_address=$10,phone=$11,updated_at=NOW() WHERE id=$12`,
        [rank,first_name.trim(),last_name.trim(),room_number.trim(),floor_number,
         family_head,family_members.length,position||null,birthdate||null,id_card_address||null,phone||null,req.params.id]
      );
      await client.query('DELETE FROM family_members WHERE resident_id=$1',[req.params.id]);
      await client.query('DELETE FROM vehicles WHERE resident_id=$1',[req.params.id]);
      for (const m of family_members) {
        await client.query(
          `INSERT INTO family_members (resident_id,prefix,first_name,last_name,relationship,birthdate,id_card_address,work_address,phone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [req.params.id,m.prefix,m.first_name.trim(),m.last_name.trim(),m.relationship.trim(),
           m.birthdate||null,m.id_card_address||null,m.work_address||null,m.phone||null]
        );
      }
      for (const v of vehicles) {
        if (v.plate_number?.trim()) {
          await client.query(
            `INSERT INTO vehicles (resident_id,type,plate_number,plate_province,brand,color) VALUES ($1,$2,$3,$4,$5,$6)`,
            [req.params.id,v.type,v.plate_number.trim(),v.plate_province||null,v.brand||null,v.color||null]
          );
        }
      }
      await client.query('COMMIT');
      res.json({success:true,message:'อัปเดตข้อมูลเรียบร้อยแล้ว'});
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({success:false,error:err.message});
    } finally { client.release(); }
  });

  // DELETE /api/surveys/:id — protected
  app.delete('/api/surveys/:id', authMiddleware, async (req, res) => {
    try {
      const { rowCount } = await pool.query('DELETE FROM residents WHERE id=$1',[req.params.id]);
      if (rowCount===0) return res.status(404).json({success:false,error:'ไม่พบข้อมูล'});
      res.json({success:true,message:'ลบข้อมูลเรียบร้อยแล้ว'});
    } catch (err) {
      res.status(500).json({success:false,error:err.message});
    }
  });

  // GET /survey — standalone form (no login required)
  app.get('/survey', (req,res) => res.sendFile(path.join(__dirname,'../frontend/public/survey.html')));

  // Catch-all → admin app (requires login)
  app.get('*', (req,res) => res.sendFile(path.join(__dirname,'../frontend/public/index.html')));
  app.listen(PORT, () => console.log(`✅  Server → http://localhost:${PORT}`));

}).catch(err => { console.error('❌',err); process.exit(1); });
