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


  // ── Audit log helper ────────────────────────────────────────────────────────
  const auditLog = async (action, resident_id, floor_number, room_number, resident_name, changed_by, detail='') => {
    try {
      await pool.query(
        `INSERT INTO audit_logs (action,resident_id,floor_number,room_number,resident_name,changed_by,detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [action, resident_id||null, floor_number||null, room_number||null, resident_name||null, changed_by, detail||null]
      );
    } catch(e) { console.error('audit log error:', e.message); }
  };

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
          OR r.room_number ILIKE $1 OR r.position ILIKE $1 OR r.unit ILIKE $1
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
        SELECT r.rank, r.position, r.unit, r.first_name, r.last_name,
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
      position=null, unit=null, birthdate=null, id_card_address=null, phone=null
    } = req.body;
    // Duplicate room check
    const { rows: dupCheck } = await pool.query(
      'SELECT id, rank, first_name, last_name FROM residents WHERE floor_number=$1 AND room_number=$2',
      [floor_number, room_number.trim()]
    );
    if (dupCheck.length > 0) {
      const dup = dupCheck[0];
      return res.status(409).json({
        success: false,
        error: `ห้อง ${room_number} ชั้น ${floor_number} มีข้อมูลอยู่แล้ว`,
        existing: { id: dup.id, name: `${dup.rank} ${dup.first_name} ${dup.last_name}` }
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [{ id: rid }] } = await client.query(
        `INSERT INTO residents
           (rank,first_name,last_name,room_number,floor_number,family_head,resident_count,position,unit,birthdate,id_card_address,phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [rank,first_name.trim(),last_name.trim(),room_number.trim(),floor_number,
         family_head,family_members.length,position||null,unit||null,birthdate||null,id_card_address||null,phone||null]
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
      await auditLog('CREATE', rid, floor_number, room_number.trim(), `${rank} ${first_name.trim()} ${last_name.trim()}`, 'public', `บันทึกข้อมูลใหม่`);
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
      position=null,unit=null,birthdate=null,id_card_address=null,phone=null
    } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows:[ex] } = await client.query('SELECT * FROM residents WHERE id=$1',[req.params.id]);
      if (!ex) { await client.query('ROLLBACK'); return res.status(404).json({success:false,error:'ไม่พบข้อมูล'}); }
      // Duplicate check — allow same room if it's the same record
      const { rows: dupCheck } = await client.query(
        'SELECT id FROM residents WHERE floor_number=$1 AND room_number=$2 AND id!=$3',
        [floor_number, room_number.trim(), req.params.id]
      );
      if (dupCheck.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success:false, error:`ห้อง ${room_number} ชั้น ${floor_number} มีข้อมูลอยู่แล้ว` });
      }
      await client.query(
        `UPDATE residents SET rank=$1,first_name=$2,last_name=$3,room_number=$4,floor_number=$5,
         family_head=$6,resident_count=$7,position=$8,unit=$9,birthdate=$10,id_card_address=$11,phone=$12,updated_at=NOW() WHERE id=$13`,
        [rank,first_name.trim(),last_name.trim(),room_number.trim(),floor_number,
         family_head,family_members.length,position||null,unit||null,birthdate||null,id_card_address||null,phone||null,req.params.id]
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
      const changes = [];
      if (ex.room_number !== room_number.trim()) changes.push(`ห้อง: ${ex.room_number}→${room_number.trim()}`);
      if (ex.floor_number !== floor_number) changes.push(`ชั้น: ${ex.floor_number}→${floor_number}`);
      await auditLog('UPDATE', req.params.id, floor_number, room_number.trim(), `${rank} ${first_name.trim()} ${last_name.trim()}`, req.user, changes.length?changes.join(', '):'แก้ไขข้อมูล');
      res.json({success:true,message:'อัปเดตข้อมูลเรียบร้อยแล้ว'});
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({success:false,error:err.message});
    } finally { client.release(); }
  });

  // DELETE /api/surveys/:id — protected
  app.delete('/api/surveys/:id', authMiddleware, async (req, res) => {
    try {
      const { rows:[r] } = await pool.query('SELECT * FROM residents WHERE id=$1',[req.params.id]);
      if (!r) return res.status(404).json({success:false,error:'ไม่พบข้อมูล'});
      await pool.query('DELETE FROM residents WHERE id=$1',[req.params.id]);
      await auditLog('DELETE', req.params.id, r.floor_number, r.room_number, `${r.rank} ${r.first_name} ${r.last_name}`, req.user, 'ลบข้อมูล');
      res.json({success:true,message:'ลบข้อมูลเรียบร้อยแล้ว'});
    } catch (err) {
      res.status(500).json({success:false,error:err.message});
    }
  });



  // GET /api/audit-logs — get audit history (protected)
  app.get('/api/audit-logs', authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit)||100, 500);
      const { rows } = await pool.query(
        `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1`, [limit]
      );
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/surveys/export/vehicles — vehicle Excel export (protected)
  app.get('/api/surveys/export/vehicles', authMiddleware, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT r.rank, r.position, r.unit, r.first_name, r.last_name,
               r.room_number, r.floor_number, r.phone,
               v.type, v.plate_number, v.plate_province, v.brand, v.color
        FROM vehicles v
        JOIN residents r ON r.id = v.resident_id
        ORDER BY v.type, r.floor_number, r.room_number
      `);
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });


  // GET /api/surveys/:id/docx — generate filled DOCX (protected)
  app.get('/api/surveys/:id/docx', authMiddleware, async (req, res) => {
    const os   = require('os');
    const { execSync } = require('child_process');
    const fs   = require('fs');

    try {
      const { rows:[r] } = await pool.query('SELECT * FROM residents WHERE id=$1',[req.params.id]);
      if (!r) return res.status(404).json({success:false,error:'ไม่พบข้อมูล'});
      const { rows: members }  = await pool.query('SELECT * FROM family_members WHERE resident_id=$1 ORDER BY id LIMIT 5',[r.id]);
      const { rows: vehicles } = await pool.query('SELECT * FROM vehicles WHERE resident_id=$1 ORDER BY id',[r.id]);

      const cars  = vehicles.filter(v=>v.type==='car').slice(0,3);
      const motos = vehicles.filter(v=>v.type==='motorcycle').slice(0,3);
      const m = (i) => members[i] || {};

      const fmtDate = (d) => {
        if (!d) return '';
        const dt = new Date(d);
        if (isNaN(dt)) return '';
        const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
        return `${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear()+543}`;
      };
      const calcAge = (d) => {
        if (!d) return '';
        return String(Math.floor((Date.now()-new Date(d).getTime())/(1000*60*60*24*365.25)));
      };
      const xmlEsc = (s) => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      // Determine gender from prefix
      const getGender = (prefix) => {
        if (!prefix) return '';
        if (['นาย','ด.ช.','เด็กชาย'].includes(prefix)) return 'ชาย';
        if (['นาง','นางสาว','ด.ญ.','เด็กหญิง'].includes(prefix)) return 'หญิง';
        return '';
      };

      // Map for textbox replacements (pages 1-2 and duplicate on pages 2-3)
      const map = {
        'ตำแหน่ง':  r.position||'',
        'ชื่อ-สกุล': `${r.first_name||''}  ${r.last_name||''}`,
        'ยศ':        r.rank||'',
        'สังกัด':   r.unit||'',
        'วันเกิด':  fmtDate(r.birthdate),
        'อายุ':     calcAge(r.birthdate),
        'ที่อยู่':  r.id_card_address||'',
        'ชั้น':     String(r.floor_number||''),
        'ห้อง':     r.room_number||'',
        'เบอร์โทร': r.phone||'',
        'คำนำหน้า-ชื่อ1': m(0).prefix?`${m(0).prefix} ${m(0).first_name||''}  ${m(0).last_name||''}`:'',
        'วันเกิด1': fmtDate(m(0).birthdate), 'อายุ1': calcAge(m(0).birthdate),
        'ที่อยู่1': m(0).id_card_address||'', 'ที่อยู่ที่ทำงาน1': m(0).work_address||'',
        'เบอร์โทร1': m(0).phone||'', 'ความสัมพันธ์1': m(0).relationship||'',
        'เพศ1':getGender(m(0).prefix),
        'คำนำหน้า-ชื่อ2': m(1).prefix?`${m(1).prefix} ${m(1).first_name||''}  ${m(1).last_name||''}`:'',
        'วันเกิด2': fmtDate(m(1).birthdate), 'อายุ2': calcAge(m(1).birthdate),
        'ที่อยู่2': m(1).id_card_address||'', 'ที่อยู่ที่ทำงาน2': m(1).work_address||'',
        'เบอร์โทร2': m(1).phone||'', 'ความสัมพันธ์2': m(1).relationship||'',
        'เพศ2':getGender(m(1).prefix),
        'คำนำหน้า-ชื่อ3': m(2).prefix?`${m(2).prefix} ${m(2).first_name||''}  ${m(2).last_name||''}`:'',
        'วันเกิด3': fmtDate(m(2).birthdate), 'อายุ3': calcAge(m(2).birthdate),
        'ที่อยู่3': m(2).id_card_address||'', 'ที่อยู่ที่ทำงาน3': m(2).work_address||'',
        'เบอร์โทร3': m(2).phone||'', 'ความสัมพันธ์3': m(2).relationship||'',
        'เพศ3':getGender(m(2).prefix),
        'คำนำหน้า-ชื่อ4': m(3).prefix?`${m(3).prefix} ${m(3).first_name||''}  ${m(3).last_name||''}`:'',
        'วันเกิด4': fmtDate(m(3).birthdate), 'อายุ4': calcAge(m(3).birthdate),
        'ที่อยู่4': m(3).id_card_address||'', 'ที่อยู่ที่ทำงาน4': m(3).work_address||'',
        'เบอร์โทร4': m(3).phone||'', 'ความสัมพันธ์4': m(3).relationship||'',
        'เพศ4':getGender(m(3).prefix),
        'คำนำหน้า-ชื่อ5': m(4).prefix?`${m(4).prefix} ${m(4).first_name||''}  ${m(4).last_name||''}`:'',
        'วันเกิด5': fmtDate(m(4).birthdate), 'อายุ5': calcAge(m(4).birthdate),
        'ที่อยู่5': m(4).id_card_address||'', 'ที่อยู่ที่ทำงาน5': m(4).work_address||'',
        'เบอร์โทร5': m(4).phone||'', 'ความสัมพันธ์5': m(4).relationship||'',
        'เพศ5':getGender(m(4).prefix),
        'จำนวนรถยนต์': String(cars.length),
        'ยี่ห้อ1': cars[0]?.brand||'', 'สี41': cars[0]?.color||'', 'ทะเบียน41': cars[0]?.plate_number||'', 'จังหวัด41': cars[0]?.plate_province||'',
        'ยี่ห้อ2': cars[1]?.brand||'', 'สี42': cars[1]?.color||'', 'ทะเบียน42': cars[1]?.plate_number||'', 'จังหวัด42': cars[1]?.plate_province||'',
        'ยี่ห้อ3': cars[2]?.brand||'', 'สี43': cars[2]?.color||'', 'ทะเบียน43': cars[2]?.plate_number||'', 'จังหวัด43': cars[2]?.plate_province||'',
        'จำนวนรถจักร': String(motos.length),
        'ยี่ห้อ21': motos[0]?.brand||'', 'สี21': motos[0]?.color||'', 'ทะเบียน21': motos[0]?.plate_number||'', 'จังหวัด21': motos[0]?.plate_province||'',
        'ยี่ห้อ22': motos[1]?.brand||'', 'สี22': motos[1]?.color||'', 'ทะเบียน22': motos[1]?.plate_number||'', 'จังหวัด22': motos[1]?.plate_province||'',
        'ยี่ห้อ23': motos[2]?.brand||'', 'สี23': motos[2]?.color||'', 'ทะเบียน23': motos[2]?.plate_number||'', 'จังหวัด23': motos[2]?.plate_province||'',
      };

      // Replace textbox: each box has # run then label run(s)
      // Join all label runs → key; replace # with value; clear label runs
      const replaceInBlock = (block) => {
        const texts = [...block.matchAll(/<w:t[^>]*>([^<]+)<\/w:t>/g)].map(m=>m[1]);
        if (!texts.length || texts[0] !== '#') return block;
        const label = texts.slice(1).join('');
        const val = map[label];
        if (val === undefined) return block;
        const esc = xmlEsc(val);
        block = block.replace('<w:t>#</w:t>', `<w:t>${esc}</w:t>`);
        for (const t of texts.slice(1)) {
          const tEsc = xmlEsc(t);
          block = block.replace(
            new RegExp('<(w:t(?:[^>]*)>)' + tEsc.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '<\\/w:t>'),
            '<$1</w:t>'
          );
        }
        return block;
      };

      // ── Page 3: family member rows in regular paragraphs ──
      // Structure: "๑. ยศ ชื่อ สกุล [underlined spaces] เพศ [UL] อายุ [UL] เกี่ยวข้องเป็น [UL]"
      // Strategy: replace the underlined space runs after each label with data
      const replaceP3FamilyPara = (paraXml, memberIdx) => {
        const mb = m(memberIdx);
        if (!mb.first_name) return paraXml; // no data, leave blank
        
        const fullName = xmlEsc(mb.prefix ? `${mb.prefix} ${mb.first_name}  ${mb.last_name}` : `${mb.first_name}  ${mb.last_name}`);
        const gender   = xmlEsc(getGender(mb.prefix));
        const age      = xmlEsc(calcAge(mb.birthdate));
        const rel      = xmlEsc(mb.relationship||'');

        // Replace first big underlined block (after ยศ ชื่อ สกุล) with full name
        // Then เพศ underline with gender, อายุ underline with age, เกี่ยวข้องเป็น underline with relationship
        let replaced = false;
        let nameInserted = false;
        let genderInserted = false;
        let ageInserted = false;
        let relInserted = false;
        let lastLabel = '';

        return paraXml.replace(/<w:r>[\s\S]*?<\/w:r>/g, (run) => {
  // 1. Safe regex check for underline/dotted format
  const hasUL = /<w:u\s+[^>]*w:val="(single|dotted)"/.test(run);

  // 2. FIXED: Native JS replacement for the broken 're.findall' logic
  // This extracts and combines ALL text inside any <w:t> tags within this run
  let txt = '';
  const textMatches = run.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g);
  for (const match of textMatches) {
    txt += match[1];
  }

  if (!hasUL) {
    // Label run — track which section we're in
    if (txt.includes('เพศ')) lastLabel = 'เพศ';
    else if (txt.includes('อายุ')) lastLabel = 'อายุ';
    else if (txt.includes('เกี่ยวข้อง')) lastLabel = 'เป็น';
    return run;
  }

  // Helper function to safely swap text inside the first <w:t> tag
  const injectValue = (value) => {
    return run.replace(/(<w:t[^>]*>)([\s\S]*?)(<\/w:t>)/, `$1${value}$3`);
  };

  // Underlined run — fill with data based on last label seen
  if (lastLabel === '' && !nameInserted) {
    nameInserted = true;
    return injectValue(fullName);
  } else if (lastLabel === 'เพศ' && !genderInserted) {
    genderInserted = true;
    return injectValue(gender);
  } else if (lastLabel === 'อายุ' && !ageInserted) {
    ageInserted = true;
    return injectValue(age);
  } else if (lastLabel === 'เป็น' && !relInserted) {
    relInserted = true;
    return injectValue(rel);
  }
  
  return run;
});
      };

      // Work in temp dir
      const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(),'docx-'));
      const srcDocx = path.join(__dirname,'form_template.docx');
      const outDocx = path.join(tmpDir,'output.docx');
      const xmlDir  = path.join(tmpDir,'xml');

      execSync(`unzip -q "${srcDocx}" -d "${xmlDir}"`);

      const xmlPath = path.join(xmlDir,'word','document.xml');
      let xml = fs.readFileSync(xmlPath,'utf8');

      // Step 1: replace textboxes (pages 1 & 2)
      xml = xml.replace(/<wps:txbx>[\s\S]*?<\/wps:txbx>/g, replaceInBlock);
      xml = xml.replace(/<v:textbox[\s\S]*?<\/v:textbox>/g, replaceInBlock);

      // Step 2: replace page 3 family rows in paragraphs
      // Find paragraphs containing "ยศ ชื่อ สกุล" + "เพศ" + "อายุ" + "เกี่ยวข้องเป็น"
      let memberParaIdx = 0;
      xml = xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (para) => {
        const hasPattern = para.includes('เพศ') && para.includes('อายุ') && para.includes('เกี่ยวข้อง');
        if (!hasPattern) return para;
        const result = replaceP3FamilyPara(para, memberParaIdx);
        memberParaIdx++;
        return result;
      });

      // Step 3: replace page 3 textboxes (ยศ ชื่อ สกุล ชั้น ห้อง สังกัด)
      // These are already handled by replaceInBlock above

      fs.writeFileSync(xmlPath, xml);
      execSync(`cd "${xmlDir}" && zip -qr "${outDocx}" .`);

      const fname = encodeURIComponent(`survey_${r.rank}_${r.first_name}_${r.last_name}.docx`.replace(/\s+/g,'_'));
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${fname}`);
      res.send(fs.readFileSync(outDocx));
      fs.rmSync(tmpDir,{recursive:true,force:true});

    } catch(err) {
      console.error('DOCX error:',err);
      res.status(500).json({success:false,error:err.message});
    }
  });

  // GET /api/surveys/export/vehicles — vehicle Excel export (protected)
  app.get('/api/surveys/export/vehicles', authMiddleware, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT r.rank, r.position, r.unit, r.first_name, r.last_name,
               r.room_number, r.floor_number, r.phone,
               v.type, v.plate_number, v.plate_province, v.brand, v.color
        FROM vehicles v
        JOIN residents r ON r.id = v.resident_id
        ORDER BY v.type, r.floor_number, r.room_number
      `);
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });


  // GET /api/surveys/:id/docx — generate filled DOCX (protected)
  app.get('/api/surveys/:id/docx', authMiddleware, async (req, res) => {
    const os   = require('os');
    const { execSync } = require('child_process');
    const fs   = require('fs');

    try {
      const { rows:[r] } = await pool.query('SELECT * FROM residents WHERE id=$1',[req.params.id]);
      if (!r) return res.status(404).json({success:false,error:'ไม่พบข้อมูล'});
      const { rows: members }  = await pool.query('SELECT * FROM family_members WHERE resident_id=$1 ORDER BY id LIMIT 4',[r.id]);
      const { rows: vehicles } = await pool.query('SELECT * FROM vehicles WHERE resident_id=$1 ORDER BY id',[r.id]);

      const cars  = vehicles.filter(v=>v.type==='car').slice(0,3);
      const motos = vehicles.filter(v=>v.type==='motorcycle').slice(0,3);
      const m = (i) => members[i] || {};

      const fmtDate = (d) => {
        if (!d) return '';
        const dt = new Date(d);
        if (isNaN(dt)) return '';
        const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
        return `${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear()+543}`;
      };
      const calcAge = (d) => {
        if (!d) return '';
        return String(Math.floor((Date.now()-new Date(d).getTime())/(1000*60*60*24*365.25)));
      };
      const xmlEsc = (s) => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      const map = {
        'ตำแหน่ง':  r.position||'',
        'ชื่อ-สกุล': `${r.first_name||''}  ${r.last_name||''}`,
        'ยศ':        r.rank||'',
        'สังกัด':   r.unit||'',
        'วันเกิด':  fmtDate(r.birthdate),
        'อายุ':     calcAge(r.birthdate),
        'ที่อยู่':  r.id_card_address||'',
        'ชั้น':     String(r.floor_number||''),
        'ห้อง':     r.room_number||'',
        'เบอร์โทร': r.phone||'',
        'คำนำหน้า-ชื่อ1': m(0).prefix?`${m(0).prefix} ${m(0).first_name||''}  ${m(0).last_name||''}`:'',
        'วันเกิด1': fmtDate(m(0).birthdate),
        'อายุ1':    calcAge(m(0).birthdate),
        'ที่อยู่1': m(0).id_card_address||'',
        'ที่อยู่ที่ทำงาน1': m(0).work_address||'',
        'เบอร์โทร1': m(0).phone||'',
        'ความสัมพันธ์1': m(0).relationship||'',
        'คำนำหน้า-ชื่อ2': m(1).prefix?`${m(1).prefix} ${m(1).first_name||''}  ${m(1).last_name||''}`:'',
        'วันเกิด2': fmtDate(m(1).birthdate),
        'อายุ2':    calcAge(m(1).birthdate),
        'ที่อยู่2': m(1).id_card_address||'',
        'ที่อยู่ที่ทำงาน2': m(1).work_address||'',
        'เบอร์โทร2': m(1).phone||'',
        'ความสัมพันธ์2': m(1).relationship||'',
        'คำนำหน้า-ชื่อ3': m(2).prefix?`${m(2).prefix} ${m(2).first_name||''}  ${m(2).last_name||''}`:'',
        'วันเกิด3': fmtDate(m(2).birthdate),
        'อายุ3':    calcAge(m(2).birthdate),
        'ที่อยู่3': m(2).id_card_address||'',
        'ที่อยู่ที่ทำงาน3': m(2).work_address||'',
        'เบอร์โทร3': m(2).phone||'',
        'ความสัมพันธ์3': m(2).relationship||'',
        'คำนำหน้า-ชื่อ4': m(3).prefix?`${m(3).prefix} ${m(3).first_name||''}  ${m(3).last_name||''}`:'',
        'วันเกิด4': fmtDate(m(3).birthdate),
        'อายุ4':    calcAge(m(3).birthdate),
        'ที่อยู่4': m(3).id_card_address||'',
        'ที่อยู่ที่ทำงาน4': m(3).work_address||'',
        'เบอร์โทร4': m(3).phone||'',
        'ความสัมพันธ์4': m(3).relationship||'',
        'จำนวนรถยนต์': String(cars.length),
        'ยี่ห้อ1':   cars[0]?.brand||'',
        'สี41':      cars[0]?.color||'',
        'ทะเบียน41': cars[0]?.plate_number||'',
        'จังหวัด41': cars[0]?.plate_province||'',
        'ยี่ห้อ2':   cars[1]?.brand||'',
        'สี42':      cars[1]?.color||'',
        'ทะเบียน42': cars[1]?.plate_number||'',
        'จังหวัด42': cars[1]?.plate_province||'',
        'ยี่ห้อ3':   cars[2]?.brand||'',
        'สี43':      cars[2]?.color||'',
        'ทะเบียน43': cars[2]?.plate_number||'',
        'จังหวัด43': cars[2]?.plate_province||'',
        'จำนวนรถจักร': String(motos.length),
        'ยี่ห้อ21':  motos[0]?.brand||'',
        'สี21':      motos[0]?.color||'',
        'ทะเบียน21': motos[0]?.plate_number||'',
        'จังหวัด21': motos[0]?.plate_province||'',
        'ยี่ห้อ22':  motos[1]?.brand||'',
        'สี22':      motos[1]?.color||'',
        'ทะเบียน22': motos[1]?.plate_number||'',
        'จังหวัด22': motos[1]?.plate_province||'',
        'ยี่ห้อ23':  motos[2]?.brand||'',
        'สี23':      motos[2]?.color||'',
        'ทะเบียน23': motos[2]?.plate_number||'',
        'จังหวัด23': motos[2]?.plate_province||'',
      };

      // Replace logic:
      // Each textbox starts with <w:t>#</w:t> followed by 1+ runs containing the label text
      // Join all label runs to get full key (handles multi-run: ชื่อ-สกุล, ความสัมพันธ์1 etc.)
      // Then replace # run with value and clear all label runs
      const replaceInBlock = (block) => {
        const texts = [...block.matchAll(/<w:t[^>]*>([^<]+)<\/w:t>/g)].map(m=>m[1]);
        if (!texts.length || texts[0] !== '#') return block;
        const label = texts.slice(1).join('');
        const val = map[label];
        if (val === undefined) return block;
        const esc = xmlEsc(val);
        // Replace # with value
        block = block.replace('<w:t>#</w:t>', `<w:t>${esc}</w:t>`);
        // Clear each label part run
        for (const t of texts.slice(1)) {
          const tEsc = xmlEsc(t);
          block = block.replace(
            new RegExp('<(w:t(?:[^>]*)>)' + tEsc.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '<\/w:t>'),
            '<$1</w:t>'
          );
        }
        return block;
      };

      // Work in temp dir
      const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(),'docx-'));
      const srcDocx = path.join(__dirname,'form_template.docx');
      const outDocx = path.join(tmpDir,'output.docx');
      const xmlDir  = path.join(tmpDir,'xml');

      execSync(`unzip -q "${srcDocx}" -d "${xmlDir}"`);

      const xmlPath = path.join(xmlDir,'word','document.xml');
      let xml = fs.readFileSync(xmlPath,'utf8');

      xml = xml.replace(/<wps:txbx>[\s\S]*?<\/wps:txbx>/g, replaceInBlock);
      xml = xml.replace(/<v:textbox[\s\S]*?<\/v:textbox>/g, replaceInBlock);

      fs.writeFileSync(xmlPath, xml);
      execSync(`cd "${xmlDir}" && zip -qr "${outDocx}" .`);

      const fname = encodeURIComponent(`survey_${r.rank}_${r.first_name}_${r.last_name}.docx`.replace(/\s+/g,'_'));
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${fname}`);
      res.send(fs.readFileSync(outDocx));
      fs.rmSync(tmpDir,{recursive:true,force:true});

    } catch(err) {
      console.error('DOCX error:',err);
      res.status(500).json({success:false,error:err.message});
    }
  });


  // GET /api/audit-logs — get audit history (protected)
  app.get('/api/audit-logs', authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit)||100, 500);
      const { rows } = await pool.query(
        `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1`, [limit]
      );
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/surveys/export/vehicles — vehicle Excel export (protected)
  app.get('/api/surveys/export/vehicles', authMiddleware, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT r.rank, r.position, r.unit, r.first_name, r.last_name,
               r.room_number, r.floor_number, r.phone,
               v.type, v.plate_number, v.plate_province, v.brand, v.color
        FROM vehicles v
        JOIN residents r ON r.id = v.resident_id
        ORDER BY v.type, r.floor_number, r.room_number
      `);
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });


  // GET /api/surveys/:id/docx — generate filled DOCX (protected)
  app.get('/api/surveys/:id/docx', authMiddleware, async (req, res) => {
    const os   = require('os');
    const { execSync } = require('child_process');
    const fs   = require('fs');

    try {
      const { rows:[r] } = await pool.query('SELECT * FROM residents WHERE id=$1',[req.params.id]);
      if (!r) return res.status(404).json({success:false,error:'ไม่พบข้อมูล'});
      const { rows: members }  = await pool.query('SELECT * FROM family_members WHERE resident_id=$1 ORDER BY id LIMIT 4',[r.id]);
      const { rows: vehicles } = await pool.query('SELECT * FROM vehicles WHERE resident_id=$1 ORDER BY id',[r.id]);

      const cars  = vehicles.filter(v=>v.type==='car').slice(0,3);
      const motos = vehicles.filter(v=>v.type==='motorcycle').slice(0,3);
      const m = (i) => members[i] || {};

      const fmtDate = (d) => {
        if (!d) return '';
        const dt = new Date(d);
        if (isNaN(dt)) return '';
        const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
        return `${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear()+543}`;
      };
      const calcAge = (d) => {
        if (!d) return '';
        return String(Math.floor((Date.now()-new Date(d).getTime())/(1000*60*60*24*365.25)));
      };
      const xmlEsc = (s) => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      // Map: placeholder label (without #) -> value
      const map = {
        // เจ้าของห้อง
        'ตำแหน่ง':  r.position||'',
        'ชื่อ-สกุล': `${r.first_name||''}  ${r.last_name||''}`,
        'ยศ':        r.rank||'',
        'สังกัด':   r.unit||'',
        'วันเกิด':  fmtDate(r.birthdate),
        'อายุ':     calcAge(r.birthdate),
        'ที่อยู่':  r.id_card_address||'',
        'ชั้น':     String(r.floor_number||''),
        'ห้อง':     r.room_number||'',
        'เบอร์โทร': r.phone||'',
        // ผู้ร่วมอาศัย 1
        'คำนำหน้า-ชื่อ1': m(0).prefix?`${m(0).prefix} ${m(0).first_name||''}  ${m(0).last_name||''}`:'',
        'วันเกิด1': fmtDate(m(0).birthdate),
        'อายุ1':    calcAge(m(0).birthdate),
        'ที่อยู่1': m(0).id_card_address||'',
        'ที่อยู่ที่ทำงาน1': m(0).work_address||'',
        'เบอร์โทร1': m(0).phone||'',
        'เพศ1':getGender(m(0).prefix),
        'ความสัมพันธ์1': m(0).relationship||'',
        // ผู้ร่วมอาศัย 2
        'คำนำหน้า-ชื่อ2': m(1).prefix?`${m(1).prefix} ${m(1).first_name||''}  ${m(1).last_name||''}`:'',
        'วันเกิด2': fmtDate(m(1).birthdate),
        'อายุ2':    calcAge(m(1).birthdate),
        'ที่อยู่2': m(1).id_card_address||'',
        'ที่อยู่ที่ทำงาน2': m(1).work_address||'',
        'เบอร์โทร2': m(1).phone||'',
        'เพศ2':getGender(m(1).prefix),
        'ความสัมพันธ์2': m(1).relationship||'',
        // ผู้ร่วมอาศัย 3
        'คำนำหน้า-ชื่อ3': m(2).prefix?`${m(2).prefix} ${m(2).first_name||''}  ${m(2).last_name||''}`:'',
        'วันเกิด3': fmtDate(m(2).birthdate),
        'อายุ3':    calcAge(m(2).birthdate),
        'ที่อยู่3': m(2).id_card_address||'',
        'ที่อยู่ที่ทำงาน3': m(2).work_address||'',
        'เบอร์โทร3': m(2).phone||'',
        'เพศ3':getGender(m(2).prefix),
        'ความสัมพันธ์3': m(2).relationship||'',
        // ผู้ร่วมอาศัย 4
        'คำนำหน้า-ชื่อ4': m(3).prefix?`${m(3).prefix} ${m(3).first_name||''}  ${m(3).last_name||''}`:'',
        'วันเกิด4': fmtDate(m(3).birthdate),
        'อายุ4':    calcAge(m(3).birthdate),
        'ที่อยู่4': m(3).id_card_address||'',
        'ที่อยู่ที่ทำงาน4': m(3).work_address||'',
        'เบอร์โทร4': m(3).phone||'',
        'เพศ4':getGender(m(3).prefix),
        'ความสัมพันธ์4': m(3).relationship||'',
        // รถยนต์
        'จำนวนรถยนต์': String(cars.length),
        'ยี่ห้อ1':   cars[0]?.brand||'',
        'สี41':      cars[0]?.color||'',
        'ทะเบียน41': cars[0]?.plate_number||'',
        'จังหวัด41': cars[0]?.plate_province||'',
        'ยี่ห้อ2':   cars[1]?.brand||'',
        'สี42':      cars[1]?.color||'',
        'ทะเบียน42': cars[1]?.plate_number||'',
        'จังหวัด42': cars[1]?.plate_province||'',
        'ยี่ห้อ3':   cars[2]?.brand||'',
        'สี43':      cars[2]?.color||'',
        'ทะเบียน43': cars[2]?.plate_number||'',
        'จังหวัด43': cars[2]?.plate_province||'',
        // รถจักรยานยนต์
        'จำนวนรถจักร': String(motos.length),
        'ยี่ห้อ21':  motos[0]?.brand||'',
        'สี21':      motos[0]?.color||'',
        'ทะเบียน21': motos[0]?.plate_number||'',
        'จังหวัด21': motos[0]?.plate_province||'',
        'ยี่ห้อ22':  motos[1]?.brand||'',
        'สี22':      motos[1]?.color||'',
        'ทะเบียน22': motos[1]?.plate_number||'',
        'จังหวัด22': motos[1]?.plate_province||'',
        'ยี่ห้อ23':  motos[2]?.brand||'',
        'สี23':      motos[2]?.color||'',
        'ทะเบียน23': motos[2]?.plate_number||'',
        'จังหวัด23': motos[2]?.plate_province||'',
      };

      // Replace function — each textbox has exactly 2 runs:
      // run1: <w:t>#</w:t>   run2: <w:t>LABEL</w:t>
      // Strategy: replace run1's text with the value, clear run2's text
      const replaceInBlock = (block) => {
        return block.replace(
          /(<w:t>)#(<\/w:t>)([\s\S]*?<w:t(?:[^>]*)>)([^<]*?)(<\/w:t>)/,
          (match, t1open, t1close, middle, label, t2close) => {
            const val = map[label];
            if (val !== undefined) {
              return `${t1open}${xmlEsc(val)}${t1close}${middle}${t2close}`;
            }
            return match;
          }
        );
      };

      // Work in temp dir
      const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(),'docx-'));
      const srcDocx = path.join(__dirname,'form_template.docx');
      const outDocx = path.join(tmpDir,'output.docx');
      const xmlDir  = path.join(tmpDir,'xml');

      execSync(`unzip -q "${srcDocx}" -d "${xmlDir}"`);

      const xmlPath = path.join(xmlDir,'word','document.xml');
      let xml = fs.readFileSync(xmlPath,'utf8');

      // Process each textbox type
      xml = xml.replace(/<wps:txbx>[\s\S]*?<\/wps:txbx>/g, replaceInBlock);
      xml = xml.replace(/<v:textbox[\s\S]*?<\/v:textbox>/g, replaceInBlock);

      fs.writeFileSync(xmlPath, xml);
      execSync(`cd "${xmlDir}" && zip -qr "${outDocx}" .`);

      const fname = encodeURIComponent(`survey_${r.rank}_${r.first_name}_${r.last_name}.docx`.replace(/\s+/g,'_'));
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${fname}`);
      res.send(fs.readFileSync(outDocx));
      fs.rmSync(tmpDir,{recursive:true,force:true});

    } catch(err) {
      console.error('DOCX error:',err);
      res.status(500).json({success:false,error:err.message});
    }
  });


  // GET /api/audit-logs — get audit history (protected)
  app.get('/api/audit-logs', authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit)||100, 500);
      const { rows } = await pool.query(
        `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1`, [limit]
      );
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/surveys/export/vehicles — vehicle Excel export (protected)
  app.get('/api/surveys/export/vehicles', authMiddleware, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT r.rank, r.position, r.unit, r.first_name, r.last_name,
               r.room_number, r.floor_number, r.phone,
               v.type, v.plate_number, v.plate_province, v.brand, v.color
        FROM vehicles v
        JOIN residents r ON r.id = v.resident_id
        ORDER BY v.type, r.floor_number, r.room_number
      `);
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });


  // GET /api/surveys/:id/docx — generate filled DOCX (protected)
  app.get('/api/surveys/:id/docx', authMiddleware, async (req, res) => {
    const os   = require('os');
    const { execSync } = require('child_process');
    const fs   = require('fs');

    try {
      // 1. Fetch full record
      const { rows: [r] } = await pool.query('SELECT * FROM residents WHERE id=$1', [req.params.id]);
      if (!r) return res.status(404).json({ success:false, error:'ไม่พบข้อมูล' });
      const { rows: members } = await pool.query('SELECT * FROM family_members WHERE resident_id=$1 ORDER BY id LIMIT 4', [r.id]);
      const { rows: vehicles } = await pool.query('SELECT * FROM vehicles WHERE resident_id=$1 ORDER BY id', [r.id]);

      const cars  = vehicles.filter(v => v.type === 'car').slice(0, 3);
      const motos = vehicles.filter(v => v.type === 'motorcycle').slice(0, 3);

      // 2. Helpers
      const fmtDate = (d) => {
        if (!d) return '';
        const dt = new Date(d);
        if (isNaN(dt)) return '';
        const day   = dt.getDate();
        const month = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'][dt.getMonth()];
        const year  = dt.getFullYear() + 543;
        return `${day} ${month} ${year}`;
      };
      const calcAge = (d) => {
        if (!d) return '';
        const diff = Date.now() - new Date(d).getTime();
        return String(Math.floor(diff / (1000*60*60*24*365.25)));
      };
      const m = (i) => members[i] || {};

      // 3. Build replacement map — key must match exactly what appears after # in doc
      const map = {
        // เจ้าของห้อง
        'ยศ':      r.rank || '',
        'ชื่อ-สกุล': `${r.first_name || ''}  ${r.last_name || ''}`,
        'ตำแหน่ง': r.position || '',
        'สังกัด':  r.unit || '',
        'วันเกิด': fmtDate(r.birthdate),
        'อายุ':    calcAge(r.birthdate),
        'ที่อยู่': r.id_card_address || '',
        'ชั้น':    String(r.floor_number || ''),
        'ห้อง':    r.room_number || '',
        'เบอร์โทร': r.phone || '',
        // ผู้ร่วมอาศัย 1
        'คำนำหน้า-ชื่อ1': m(0).prefix ? `${m(0).prefix} ${m(0).first_name || ''}  ${m(0).last_name || ''}` : '',
        'วันเกิด1':  fmtDate(m(0).birthdate),
        'อายุ1':     calcAge(m(0).birthdate),
        'ที่อยู่1':  m(0).id_card_address || '',
        'ที่อยู่ที่ทำงาน1': m(0).work_address || '',
        'เบอร์โทร1': m(0).phone || '',
        'ความสัมพันธ์1': m(0).relationship || '',
        // ผู้ร่วมอาศัย 2
        'คำนำหน้า-ชื่อ2': m(1).prefix ? `${m(1).prefix} ${m(1).first_name || ''}  ${m(1).last_name || ''}` : '',
        'วันเกิด2':  fmtDate(m(1).birthdate),
        'อายุ2':     calcAge(m(1).birthdate),
        'ที่อยู่2':  m(1).id_card_address || '',
        'ที่อยู่ที่ทำงาน2': m(1).work_address || '',
        'เบอร์โทร2': m(1).phone || '',
        'ความสัมพันธ์2': m(1).relationship || '',
        // ผู้ร่วมอาศัย 3
        'คำนำหน้า-ชื่อ3': m(2).prefix ? `${m(2).prefix} ${m(2).first_name || ''}  ${m(2).last_name || ''}` : '',
        'วันเกิด3':  fmtDate(m(2).birthdate),
        'อายุ3':     calcAge(m(2).birthdate),
        'ที่อยู่3':  m(2).id_card_address || '',
        'ที่อยู่ที่ทำงาน3': m(2).work_address || '',
        'เบอร์โทร3': m(2).phone || '',
        'ความสัมพันธ์3': m(2).relationship || '',
        // ผู้ร่วมอาศัย 4
        'คำนำหน้า-ชื่อ4': m(3).prefix ? `${m(3).prefix} ${m(3).first_name || ''}  ${m(3).last_name || ''}` : '',
        'วันเกิด4':  fmtDate(m(3).birthdate),
        'อายุ4':     calcAge(m(3).birthdate),
        'ที่อยู่4':  m(3).id_card_address || '',
        'ที่อยู่ที่ทำงาน4': m(3).work_address || '',
        'เบอร์โทร4': m(3).phone || '',
        'ความสัมพันธ์4': m(3).relationship || '',
        // ยานพาหนะ — รถยนต์
        'จำนวนรถยนต์': String(cars.length),
        'ยี่ห้อ1':   cars[0]?.brand || '',
        'สี41':      cars[0]?.color || '',
        'ทะเบียน41': cars[0]?.plate_number || '',
        'จังหวัด41': cars[0]?.plate_province || '',
        'ยี่ห้อ2':   cars[1]?.brand || '',
        'สี42':      cars[1]?.color || '',
        'ทะเบียน42': cars[1]?.plate_number || '',
        'จังหวัด42': cars[1]?.plate_province || '',
        'ยี่ห้อ3':   cars[2]?.brand || '',
        'สี43':      cars[2]?.color || '',
        'ทะเบียน43': cars[2]?.plate_number || '',
        'จังหวัด43': cars[2]?.plate_province || '',
        // ยานพาหนะ — รถจักรยานยนต์
        'จำนวนรถจักร': String(motos.length),
        'ยี่ห้อ21':  motos[0]?.brand || '',
        'สี21':      motos[0]?.color || '',
        'ทะเบียน21': motos[0]?.plate_number || '',
        'จังหวัด21': motos[0]?.plate_province || '',
        'ยี่ห้อ22':  motos[1]?.brand || '',
        'สี22':      motos[1]?.color || '',
        'ทะเบียน22': motos[1]?.plate_number || '',
        'จังหวัด22': motos[1]?.plate_province || '',
        'ยี่ห้อ23':  motos[2]?.brand || '',
        'สี23':      motos[2]?.color || '',
        'ทะเบียน23': motos[2]?.plate_number || '',
        'จังหวัด23': motos[2]?.plate_province || '',
      };

      // 4. Work in temp dir
      const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'));
      const srcDocx = path.join(__dirname, 'form_template.docx');
      const outDocx = path.join(tmpDir, 'output.docx');
      const xmlDir  = path.join(tmpDir, 'xml');

      execSync(`unzip -q "${srcDocx}" -d "${xmlDir}"`);

      const xmlPath = path.join(xmlDir, 'word', 'document.xml');
      let xml = fs.readFileSync(xmlPath, 'utf8');

      // 5. Replace strategy:
      // In the XML, each text box contains two consecutive runs:
      //   <w:t>#</w:t>  and  <w:t ...>LABEL</w:t>
      // We replace the content of the LABEL run with the value,
      // and replace # run with empty string.
      for (const [label, value] of Object.entries(map)) {
        const escaped = (value || '')
          .replace(/&/g,'&amp;')
          .replace(/</g,'&lt;')
          .replace(/>/g,'&gt;');

        // Escape label for regex
        const esc = label.replace(/[-[\]/{}()*+?.\^$|]/g,'\$&');

        // Replace the # run content with value, clear the label run
        // Pattern covers both wps:txbx and v:textbox variants
        // Each textbox has: <w:t>#</w:t> ... <w:t...>LABEL</w:t>
        // We want: <w:t>VALUE</w:t> ... <w:t...></w:t>
        const re = new RegExp(
          '(<w:t>)#(</w:t>)((?:(?!</w:txbxContent>)[\s\S]){0,300}?<w:t(?:[^>]*)>)' + esc + '(</w:t>)',
          'g'
        );
        xml = xml.replace(re, `$1${escaped}$2$3$4`);
        // Clear the label text after replacement
        const re2 = new RegExp(
          '(<w:t>)' + escaped.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') +
          '(</w:t>)((?:(?!</w:txbxContent>)[\s\S]){0,300}?<w:t(?:[^>]*)>)' + esc + '(</w:t>)',
          'g'
        );
        xml = xml.replace(re2, `$1${escaped}$2$3$4`);

        // Simpler direct label erasure: after # was already replaced, clear remaining label
        const reClear = new RegExp(
          '(<w:t(?:[^>]*)>)' + esc + '(</w:t>)',
          'g'
        );
        // Only clear inside textboxes that still have the original label (not replaced yet)
        // We'll do a targeted replace per textbox block
      }

      // Cleaner approach: process each textbox individually
      // Reset and do it properly
      xml = fs.readFileSync(xmlPath, 'utf8');

      // Split into textbox segments, replace within each
      // Find all <wps:txbx>...</wps:txbx> and <v:textbox>...</v:textbox> blocks
      const processTextbox = (block) => {
        for (const [label, value] of Object.entries(map)) {
          const escaped = (value || '')
            .replace(/&/g,'&amp;')
            .replace(/</g,'&lt;')
            .replace(/>/g,'&gt;');
          const esc = label.replace(/[-[\]/{}()*+?.\\^$|]/g,'\\$&');

          // Match: <w:t>#</w:t> ... <w:t...>LABEL</w:t>
          // Replace # with value and LABEL with empty
          const re = new RegExp(
            '(<w:t>)#(</w:t>)([\s\S]*?<w:t(?:[^>]*)>)' + esc + '(</w:t>)'
          );
          if (re.test(block)) {
            block = block.replace(re, `$1${escaped}$2$3$4`);
            // Clear label text
            const reClear = new RegExp('(<w:t(?:[^>]*)>)' + esc + '(</w:t>)');
            block = block.replace(reClear, '$1$2');
          }
        }
        return block;
      };

      // Process wps:txbx blocks
      xml = xml.replace(/<wps:txbx>[\s\S]*?<\/wps:txbx>/g, processTextbox);
      // Process v:textbox blocks
      xml = xml.replace(/<v:textbox[\s\S]*?<\/v:textbox>/g, processTextbox);

      fs.writeFileSync(xmlPath, xml);
      execSync(`cd "${xmlDir}" && zip -qr "${outDocx}" .`);

      const fname = `survey_${r.rank}_${r.first_name}_${r.last_name}.docx`
        .replace(/\s+/g,'_');
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
      res.send(fs.readFileSync(outDocx));

      fs.rmSync(tmpDir, { recursive:true, force:true });

    } catch (err) {
      console.error('DOCX error:', err);
      res.status(500).json({ success:false, error: err.message });
    }
  });

  // GET /survey — standalone form (no login required)
  app.get('/survey', (req,res) => res.sendFile(path.join(__dirname,'../frontend/public/survey.html')));

  // Catch-all → admin app (requires login)
  app.get('*', (req,res) => res.sendFile(path.join(__dirname,'../frontend/public/index.html')));
  app.listen(PORT, () => console.log(`✅  Server → http://localhost:${PORT}`));

}).catch(err => { console.error('❌',err); process.exit(1); });
