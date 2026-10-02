-- คันนี้ดีไหม? — PostgreSQL schema (Sprint 1)
-- รันซ้ำได้ (IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text,                      -- ไม่ใช้แล้ว (เข้าสู่ระบบด้วย Google เท่านั้น)
  google_sub    text UNIQUE,               -- รหัสบัญชี Google (โหมดจำลอง: 'mock:<email>')
  display_name  text NOT NULL,
  avatar        text NOT NULL DEFAULT '🙂',
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ฐานข้อมูลเดิมที่สร้างก่อนเปลี่ยนเป็น Google Sign-In
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text UNIQUE;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- รถ 1 คัน = เลขข้างรถรวมเขต เช่น 7-3077 · สร้างเมื่อมีรีวิวแรก
CREATE TABLE IF NOT EXISTS buses (
  fleet_no   text PRIMARY KEY CHECK (fleet_no ~ '^[1-8]-[0-9]{4,5}$'),
  zone       smallint NOT NULL CHECK (zone BETWEEN 1 AND 8),
  model_id   text,                       -- MODELS[].id ใน data.js (null = ไม่รู้รุ่น)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reviews (
  id              serial PRIMARY KEY,
  user_id         int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fleet_no        text NOT NULL REFERENCES buses(fleet_no),
  type            text NOT NULL DEFAULT 'review' CHECK (type IN ('review', 'incident')),
  stars_driving   smallint CHECK (stars_driving   BETWEEN 1 AND 5),
  stars_stops     smallint CHECK (stars_stops     BETWEEN 1 AND 5),
  stars_condition smallint CHECK (stars_condition BETWEEN 1 AND 5),
  text            text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
  stop_name       text CHECK (char_length(stop_name) <= 80),
  ride_time       time,
  helpful_count   int  NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_day     date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Bangkok')::date,
  CHECK (type = 'incident' OR (stars_driving IS NOT NULL AND stars_stops IS NOT NULL AND stars_condition IS NOT NULL))
);
-- 1 รีวิว / คัน / วัน / ผู้ใช้ (แจ้งเหตุไม่จำกัด)
CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_per_day ON reviews (user_id, fleet_no, created_day) WHERE type = 'review';
CREATE INDEX IF NOT EXISTS reviews_bus  ON reviews (fleet_no, created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_feed ON reviews (created_at DESC);

-- กด "มีประโยชน์" ได้คนละครั้งต่อรีวิว
CREATE TABLE IF NOT EXISTS review_votes (
  review_id  int  NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id    int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'helpful',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, user_id)
);

-- ทุกการเปลี่ยนแต้มอยู่ที่นี่ · ยอดแต้ม = SUM(delta)
CREATE TABLE IF NOT EXISTS points_ledger (
  id         serial PRIMARY KEY,
  user_id    int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      int  NOT NULL,
  reason     text NOT NULL,
  ref_id     int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user ON points_ledger (user_id, created_at DESC);
