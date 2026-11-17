-- ============================================================
--  HOSTEL BOOKING SYSTEM — Full MySQL Schema + Seed Data
--  Generated from: server.js, routes/*, middleware/auth.js
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;
SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

-- ──────────────────────────────────────────────────────────
-- 1. ADMINS
--    Used in: auth.admin.js, middleware/auth.js, properties,
--             bookings, commission_ledger, notifications
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
    id            INT            NOT NULL AUTO_INCREMENT,
    full_name     VARCHAR(120)   NOT NULL,
    email         VARCHAR(150)   NOT NULL UNIQUE,
    phone         VARCHAR(20)    NOT NULL UNIQUE,
    password_hash VARCHAR(255)   NOT NULL,
    profile_pic   VARCHAR(500)   DEFAULT NULL,
    is_approved   TINYINT(1)     NOT NULL DEFAULT 0,
    is_active     TINYINT(1)     NOT NULL DEFAULT 1,
    created_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 2. USERS
--    Used in: auth.user.js, bookings, payments, reviews,
--             favorites, middleware/auth.js
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            INT            NOT NULL AUTO_INCREMENT,
    full_name     VARCHAR(120)   NOT NULL,
    email         VARCHAR(150)   NOT NULL UNIQUE,
    phone         VARCHAR(20)    NOT NULL UNIQUE,
    password_hash VARCHAR(255)   NOT NULL,
    gender        ENUM('male','female','other') DEFAULT NULL,
    profile_pic   VARCHAR(500)   DEFAULT NULL,
    is_verified   TINYINT(1)     NOT NULL DEFAULT 0,
    is_active     TINYINT(1)     NOT NULL DEFAULT 1,
    otp_code      VARCHAR(10)    DEFAULT NULL,
    otp_expires   DATETIME       DEFAULT NULL,
    reset_token   VARCHAR(255)   DEFAULT NULL,
    reset_expires DATETIME       DEFAULT NULL,
    created_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 3. AMENITIES  (lookup / master table)
--    Used in: properties.js (amenity_ids), dashboard (GET /amenities)
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS amenities (
    id       INT          NOT NULL AUTO_INCREMENT,
    name     VARCHAR(100) NOT NULL,
    category VARCHAR(100) DEFAULT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 4. PROPERTIES
--    Used in: properties.js, bookings.js, reviews.js,
--             favorites, dashboard, auth.admin /me
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
    id               INT            NOT NULL AUTO_INCREMENT,
    admin_id         INT            NOT NULL,
    name             VARCHAR(200)   NOT NULL,
    description      TEXT           DEFAULT NULL,
    property_type    ENUM('hostel','pg','apartment','room') NOT NULL DEFAULT 'hostel',
    gender_allowed   ENUM('male','female','both')           NOT NULL DEFAULT 'both',
    address          TEXT           NOT NULL,
    area             VARCHAR(150)   DEFAULT '',
    city             VARCHAR(100)   NOT NULL DEFAULT 'Mumbai',
    state            VARCHAR(100)   NOT NULL DEFAULT 'Maharashtra',
    pincode          VARCHAR(10)    DEFAULT '',
    latitude         DECIMAL(10,7)  DEFAULT NULL,
    longitude        DECIMAL(10,7)  DEFAULT NULL,
    total_rooms      INT            NOT NULL DEFAULT 1,
    available_rooms  INT            NOT NULL DEFAULT 1,
    monthly_rent     DECIMAL(10,2)  NOT NULL,
    security_deposit DECIMAL(10,2)  NOT NULL DEFAULT 0,
    avg_rating       DECIMAL(3,2)   NOT NULL DEFAULT 0,
    total_reviews    INT            NOT NULL DEFAULT 0,
    views_count      INT            NOT NULL DEFAULT 0,
    is_active        TINYINT(1)     NOT NULL DEFAULT 1,
    is_verified      TINYINT(1)     NOT NULL DEFAULT 0,
    is_featured      TINYINT(1)     NOT NULL DEFAULT 0,
    created_at       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_prop_admin FOREIGN KEY (admin_id) REFERENCES admins (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 5. PROPERTY_AMENITIES  (junction)
--    Used in: properties.js INSERT / DELETE / GROUP_CONCAT
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS property_amenities (
    property_id INT NOT NULL,
    amenity_id  INT NOT NULL,
    PRIMARY KEY (property_id, amenity_id),
    CONSTRAINT fk_pa_prop  FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE,
    CONSTRAINT fk_pa_amen  FOREIGN KEY (amenity_id)  REFERENCES amenities  (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 6. PROPERTY_IMAGES
--    Used in: properties.js (subquery for primary_image)
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS property_images (
    id          INT          NOT NULL AUTO_INCREMENT,
    property_id INT          NOT NULL,
    image_url   VARCHAR(500) NOT NULL,
    is_primary  TINYINT(1)   NOT NULL DEFAULT 0,
    sort_order  INT          NOT NULL DEFAULT 0,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_img_prop FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 7. ROOMS
--    Used in: properties.js (GET /:id), bookings.js
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rooms (
    id            INT            NOT NULL AUTO_INCREMENT,
    property_id   INT            NOT NULL,
    room_type     VARCHAR(100)   NOT NULL,
    capacity      INT            NOT NULL DEFAULT 1,
    available     INT            NOT NULL DEFAULT 1,
    price_per_bed DECIMAL(10,2)  NOT NULL,
    is_active     TINYINT(1)     NOT NULL DEFAULT 1,
    created_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_room_prop FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 8. BOOKINGS
--    Used in: bookings.js, payments.js, reviews.js,
--             commission_ledger, notifications, dashboard
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
    id                INT             NOT NULL AUTO_INCREMENT,
    booking_ref       VARCHAR(30)     NOT NULL UNIQUE,
    user_id           INT             NOT NULL,
    property_id       INT             NOT NULL,
    room_id           INT             NOT NULL,
    check_in_date     DATE            NOT NULL,
    duration_months   INT             NOT NULL DEFAULT 1,
    monthly_rent      DECIMAL(10,2)   NOT NULL,
    security_deposit  DECIMAL(10,2)   NOT NULL DEFAULT 0,
    total_amount      DECIMAL(10,2)   NOT NULL,
    commission_rate   DECIMAL(5,2)    NOT NULL DEFAULT 5,
    commission_amount DECIMAL(10,2)   NOT NULL DEFAULT 0,
    status            ENUM('pending','confirmed','checked_in','checked_out','cancelled')
                                      NOT NULL DEFAULT 'pending',
    payment_status    ENUM('unpaid','paid','refunded')
                                      NOT NULL DEFAULT 'unpaid',
    cancel_reason     TEXT            DEFAULT NULL,
    cancelled_at      DATETIME        DEFAULT NULL,
    created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_book_user FOREIGN KEY (user_id)     REFERENCES users      (id),
    CONSTRAINT fk_book_prop FOREIGN KEY (property_id) REFERENCES properties (id),
    CONSTRAINT fk_book_room FOREIGN KEY (room_id)     REFERENCES rooms      (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 9. PAYMENTS
--    Used in: payments.js (create-order, verify, /my)
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
    id                   INT            NOT NULL AUTO_INCREMENT,
    booking_id           INT            NOT NULL UNIQUE,   -- one payment per booking
    user_id              INT            NOT NULL,
    amount               DECIMAL(10,2)  NOT NULL,
    payment_type         VARCHAR(50)    NOT NULL DEFAULT 'booking',
    payment_method       VARCHAR(50)    NOT NULL DEFAULT 'upi',
    razorpay_order_id    VARCHAR(100)   DEFAULT NULL,
    razorpay_payment_id  VARCHAR(100)   DEFAULT NULL,
    razorpay_signature   VARCHAR(255)   DEFAULT NULL,
    status               ENUM('pending','success','failed','refunded')
                                        NOT NULL DEFAULT 'pending',
    paid_at              DATETIME       DEFAULT NULL,
    created_at           DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_pay_booking FOREIGN KEY (booking_id) REFERENCES bookings (id),
    CONSTRAINT fk_pay_user    FOREIGN KEY (user_id)    REFERENCES users    (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 10. COMMISSION_LEDGER
--     Used in: bookings.js (INSERT on create),
--              payments.js (UPDATE on verify), dashboard
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commission_ledger (
    id              INT           NOT NULL AUTO_INCREMENT,
    booking_id      INT           NOT NULL,
    property_id     INT           NOT NULL,
    admin_id        INT           NOT NULL,
    booking_amount  DECIMAL(10,2) NOT NULL,
    commission_rate DECIMAL(5,2)  NOT NULL,
    commission_amt  DECIMAL(10,2) NOT NULL,
    status          ENUM('draft','pending','settled')
                                  NOT NULL DEFAULT 'draft',
    created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_cl_booking  FOREIGN KEY (booking_id)  REFERENCES bookings    (id),
    CONSTRAINT fk_cl_property FOREIGN KEY (property_id) REFERENCES properties  (id),
    CONSTRAINT fk_cl_admin    FOREIGN KEY (admin_id)    REFERENCES admins      (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 11. NOTIFICATIONS
--     Used in: bookings.js (INSERT on new booking)
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id         INT          NOT NULL AUTO_INCREMENT,
    admin_id   INT          NOT NULL,
    type       VARCHAR(60)  NOT NULL,
    title      VARCHAR(200) NOT NULL,
    message    TEXT         NOT NULL,
    is_read    TINYINT(1)   NOT NULL DEFAULT 0,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_notif_admin FOREIGN KEY (admin_id) REFERENCES admins (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 12. REVIEWS
--     Used in: reviews.js (POST /api/reviews, GET /property/:id)
--              properties.js (GET /:id — latest 10 approved)
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
    id          INT          NOT NULL AUTO_INCREMENT,
    property_id INT          NOT NULL,
    user_id     INT          NOT NULL,
    booking_id  INT          NOT NULL,
    rating      TINYINT      NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title       VARCHAR(200) DEFAULT NULL,
    comment     TEXT         DEFAULT NULL,
    is_approved TINYINT(1)   NOT NULL DEFAULT 0,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_review_booking (booking_id),   -- one review per booking
    CONSTRAINT fk_rev_prop    FOREIGN KEY (property_id) REFERENCES properties (id),
    CONSTRAINT fk_rev_user    FOREIGN KEY (user_id)     REFERENCES users      (id),
    CONSTRAINT fk_rev_booking FOREIGN KEY (booking_id)  REFERENCES bookings   (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ──────────────────────────────────────────────────────────
-- 13. FAVORITES
--     Used in: reviews.js → favRouter
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS favorites (
    user_id     INT      NOT NULL,
    property_id INT      NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, property_id),
    CONSTRAINT fk_fav_user FOREIGN KEY (user_id)     REFERENCES users      (id) ON DELETE CASCADE,
    CONSTRAINT fk_fav_prop FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


SET FOREIGN_KEY_CHECKS = 1;


-- ============================================================
--  SEED DATA
-- ============================================================

-- ── 1. ADMINS  (password = "Admin@123") ───────────────────
INSERT INTO admins (id, full_name, email, phone, password_hash, is_approved, is_active) VALUES
(1, 'Rajan Mehta',   'rajan@hostelhub.in',  '9820001001', '$2a$12$KIx5p1JqEjnXuMFayI.X3OZJPIRuMjv6vRtYP2zO6GW0n6hTFg68a', 1, 1),
(2, 'Sunita Sharma', 'sunita@hostelhub.in', '9820001002', '$2a$12$KIx5p1JqEjnXuMFayI.X3OZJPIRuMjv6vRtYP2zO6GW0n6hTFg68a', 1, 1),
(3, 'Farhan Qureshi', 'farhan@hostelhub.in','9820001003', '$2a$12$KIx5p1JqEjnXuMFayI.X3OZJPIRuMjv6vRtYP2zO6GW0n6hTFg68a', 0, 1);


-- ── 2. USERS  (password = "User@123") ─────────────────────
INSERT INTO users (id, full_name, email, phone, password_hash, gender, is_verified, is_active) VALUES
(1, 'Aarav Singh',    'aarav@gmail.com',   '9900001001', '$2a$12$abc1examplehashvalue1111111111111111111111111', 'male',   1, 1),
(2, 'Priya Kapoor',   'priya@gmail.com',   '9900001002', '$2a$12$abc2examplehashvalue2222222222222222222222222', 'female', 1, 1),
(3, 'Rahul Verma',    'rahul@gmail.com',   '9900001003', '$2a$12$abc3examplehashvalue3333333333333333333333333', 'male',   1, 1),
(4, 'Sneha Patil',    'sneha@gmail.com',   '9900001004', '$2a$12$abc4examplehashvalue4444444444444444444444444', 'female', 1, 1),
(5, 'Dev Nair',       'dev@gmail.com',     '9900001005', '$2a$12$abc5examplehashvalue5555555555555555555555555', 'male',   0, 1);


-- ── 3. AMENITIES ──────────────────────────────────────────
INSERT INTO amenities (id, name, category) VALUES
( 1, 'WiFi',                'connectivity'),
( 2, 'AC',                  'comfort'),
( 3, 'Geyser',              'comfort'),
( 4, 'Laundry',             'facility'),
( 5, 'Parking',             'facility'),
( 6, 'CCTV',                'security'),
( 7, 'Security Guard',      'security'),
( 8, 'Mess / Canteen',      'food'),
( 9, 'TV Lounge',           'recreation'),
(10, 'Study Room',          'recreation'),
(11, 'RO Water',            'facility'),
(12, 'Power Backup',        'facility'),
(13, 'Gym',                 'recreation'),
(14, 'Housekeeping',        'facility');


-- ── 4. PROPERTIES ─────────────────────────────────────────
INSERT INTO properties
  (id, admin_id, name, description, property_type, gender_allowed,
   address, area, city, state, pincode,
   latitude, longitude,
   total_rooms, available_rooms, monthly_rent, security_deposit,
   avg_rating, total_reviews, views_count,
   is_active, is_verified, is_featured)
VALUES
(1, 1, 'Sunrise PG for Men',
   'Comfortable PG near Andheri station with all basic amenities.',
   'pg', 'male',
   '12, Lokhandwala Complex, Andheri West', 'Andheri West', 'Mumbai', 'Maharashtra', '400053',
   19.1363, 72.8296,
   10, 6, 7500.00, 5000.00, 4.20, 5, 120,
   1, 1, 1),

(2, 1, 'Green Nest Hostel',
   'Mixed hostel with 24/7 security and mess facility.',
   'hostel', 'both',
   '45, Govandi East, Near SIES College', 'Govandi', 'Mumbai', 'Maharashtra', '400088',
   19.0611, 72.9175,
   15, 9, 5500.00, 3000.00, 3.80, 3, 87,
   1, 1, 0),

(3, 2, 'Pink Dorm — Ladies Only',
   'Safe and hygienic hostel exclusively for women professionals.',
   'hostel', 'female',
   'Sector 7, Belapur CBD', 'Belapur', 'Navi Mumbai', 'Maharashtra', '400614',
   19.0219, 73.0402,
   8, 4, 6000.00, 4000.00, 4.60, 8, 210,
   1, 1, 1),

(4, 2, 'City Rooms — Kurla',
   'Budget-friendly single and double rooms near Kurla railway station.',
   'room', 'male',
   'Plot 22, LBS Marg, Kurla West', 'Kurla', 'Mumbai', 'Maharashtra', '400070',
   19.0728, 72.8826,
   12, 5, 4500.00, 2000.00, 3.50, 2, 55,
   1, 1, 0),

(5, 3, 'Skyline Apartment Share',
   'Modern 3BHK sharing for working professionals.',
   'apartment', 'both',
   '301, Skyline Towers, Powai', 'Powai', 'Mumbai', 'Maharashtra', '400076',
   19.1176, 72.9060,
   6, 6, 12000.00, 10000.00, 0.00, 0, 10,
   1, 0, 0);   -- admin not yet approved / property not verified


-- ── 5. PROPERTY_AMENITIES ─────────────────────────────────
INSERT INTO property_amenities (property_id, amenity_id) VALUES
(1,1),(1,2),(1,3),(1,6),(1,7),(1,8),(1,11),(1,12),
(2,1),(2,4),(2,6),(2,7),(2,8),(2,9),(2,11),
(3,1),(3,2),(3,3),(3,4),(3,6),(3,7),(3,8),(3,10),(3,14),
(4,1),(4,6),(4,11),
(5,1),(5,2),(5,5),(5,12),(5,13);


-- ── 6. PROPERTY_IMAGES ────────────────────────────────────
INSERT INTO property_images (property_id, image_url, is_primary, sort_order) VALUES
(1, 'https://cdn.hostelhub.in/p1/main.jpg',    1, 0),
(1, 'https://cdn.hostelhub.in/p1/room1.jpg',   0, 1),
(2, 'https://cdn.hostelhub.in/p2/main.jpg',    1, 0),
(3, 'https://cdn.hostelhub.in/p3/main.jpg',    1, 0),
(3, 'https://cdn.hostelhub.in/p3/lounge.jpg',  0, 1),
(4, 'https://cdn.hostelhub.in/p4/main.jpg',    1, 0),
(5, 'https://cdn.hostelhub.in/p5/main.jpg',    1, 0);


-- ── 7. ROOMS ──────────────────────────────────────────────
INSERT INTO rooms (id, property_id, room_type, capacity, available, price_per_bed, is_active) VALUES
-- Sunrise PG (property 1)
( 1, 1, 'Single Occupancy', 1, 3, 7500.00, 1),
( 2, 1, 'Double Sharing',   2, 3, 5500.00, 1),

-- Green Nest Hostel (property 2)
( 3, 2, 'Dormitory 4-bed',  4, 4, 5500.00, 1),
( 4, 2, 'Double Sharing',   2, 5, 6500.00, 1),

-- Pink Dorm (property 3)
( 5, 3, 'Single Occupancy', 1, 2, 6000.00, 1),
( 6, 3, 'Triple Sharing',   3, 2, 4500.00, 1),

-- City Rooms (property 4)
( 7, 4, 'Single Room',      1, 2, 4500.00, 1),
( 8, 4, 'Double Room',      2, 3, 3500.00, 1),

-- Skyline (property 5)
( 9, 5, 'Private Room',     1, 2, 12000.00, 1),
(10, 5, 'Shared Room',      2, 4,  8000.00, 1);


-- ── 8. BOOKINGS ───────────────────────────────────────────
INSERT INTO bookings
  (id, booking_ref, user_id, property_id, room_id,
   check_in_date, duration_months,
   monthly_rent, security_deposit, total_amount,
   commission_rate, commission_amount,
   status, payment_status, created_at)
VALUES
(1, 'HB-2025-10001', 1, 1, 1, '2025-07-01', 3,
    7500.00, 5000.00, 12500.00, 5.00, 375.00,
    'confirmed', 'paid',    '2025-06-15 10:30:00'),

(2, 'HB-2025-10002', 2, 3, 5, '2025-07-10', 6,
    6000.00, 4000.00, 10000.00, 5.00, 300.00,
    'confirmed', 'paid',    '2025-06-18 14:00:00'),

(3, 'HB-2025-10003', 3, 2, 3, '2025-08-01', 2,
    5500.00, 3000.00,  8500.00, 5.00, 275.00,
    'pending',   'unpaid',  '2025-06-25 09:00:00'),

(4, 'HB-2025-10004', 4, 3, 6, '2025-07-15', 3,
    4500.00, 4000.00,  8500.00, 5.00, 225.00,
    'checked_in', 'paid',   '2025-06-20 11:00:00'),

(5, 'HB-2025-10005', 1, 4, 7, '2025-06-01', 1,
    4500.00, 2000.00,  6500.00, 5.00, 225.00,
    'checked_out', 'paid',  '2025-05-25 08:00:00');


-- ── 9. PAYMENTS ───────────────────────────────────────────
INSERT INTO payments
  (booking_id, user_id, amount, payment_type, payment_method,
   razorpay_order_id, razorpay_payment_id, razorpay_signature,
   status, paid_at)
VALUES
(1, 1, 12500.00, 'booking', 'upi',
   'order_live_aA1bB2cC3dD', 'pay_live_xX1yY2zZ3', 'sig_abc123',
   'success', '2025-06-15 10:45:00'),

(2, 2, 10000.00, 'booking', 'card',
   'order_live_eE4fF5gG6hH', 'pay_live_aA4bB5cC6', 'sig_def456',
   'success', '2025-06-18 14:20:00'),

(4, 4,  8500.00, 'booking', 'netbanking',
   'order_live_iI7jJ8kK9lL', 'pay_live_dD7eE8fF9', 'sig_ghi789',
   'success', '2025-06-20 11:30:00'),

(5, 1,  6500.00, 'booking', 'upi',
   'order_live_mM0nN1oO2pP', 'pay_live_gG0hH1iI2', 'sig_jkl012',
   'success', '2025-05-25 08:20:00');


-- ── 10. COMMISSION_LEDGER ─────────────────────────────────
INSERT INTO commission_ledger
  (booking_id, property_id, admin_id, booking_amount, commission_rate, commission_amt, status)
VALUES
(1, 1, 1, 12500.00, 5.00, 375.00, 'settled'),
(2, 3, 2, 10000.00, 5.00, 300.00, 'pending'),
(3, 2, 1,  8500.00, 5.00, 275.00, 'draft'),
(4, 3, 2,  8500.00, 5.00, 225.00, 'pending'),
(5, 4, 2,  6500.00, 5.00, 225.00, 'settled');


-- ── 11. NOTIFICATIONS ─────────────────────────────────────
INSERT INTO notifications (admin_id, type, title, message, is_read) VALUES
(1, 'new_booking', 'New Booking Received!', 'New booking (HB-2025-10001) for Sunrise PG for Men.', 1),
(2, 'new_booking', 'New Booking Received!', 'New booking (HB-2025-10002) for Pink Dorm — Ladies Only.', 1),
(1, 'new_booking', 'New Booking Received!', 'New booking (HB-2025-10003) for Green Nest Hostel.', 0),
(2, 'new_booking', 'New Booking Received!', 'New booking (HB-2025-10004) for Pink Dorm — Ladies Only.', 0);


-- ── 12. REVIEWS ───────────────────────────────────────────
INSERT INTO reviews (property_id, user_id, booking_id, rating, title, comment, is_approved) VALUES
(1, 1, 1, 4, 'Great stay!',        'Clean rooms and helpful staff. WiFi could be better.',   1),
(3, 2, 2, 5, 'Best ladies hostel', 'Very safe and hygienic. Loved the study room.',           1),
(4, 1, 5, 3, 'Average',            'Basic amenities. Good for short stay near the station.',  1);


-- Update avg_rating to match the seeded reviews
UPDATE properties SET
  avg_rating    = (SELECT ROUND(AVG(rating),2) FROM reviews WHERE property_id = properties.id AND is_approved = 1),
  total_reviews = (SELECT COUNT(*)              FROM reviews WHERE property_id = properties.id AND is_approved = 1);


-- ── 13. FAVORITES ─────────────────────────────────────────
INSERT INTO favorites (user_id, property_id) VALUES
(1, 3),
(2, 1),
(3, 3),
(4, 2);


-- ============================================================
--  END OF FILE
-- ============================================================

CREATE TABLE IF NOT EXISTS cities (
    id                INT           NOT NULL AUTO_INCREMENT,
    name              VARCHAR(100)  NOT NULL,
    slug              VARCHAR(120)  NOT NULL UNIQUE,   -- e.g. 'mumbai', 'delhi-ncr'
    state             VARCHAR(100)  DEFAULT NULL,
    banner_image_url  VARCHAR(500)  DEFAULT NULL,       -- big hero image on /cities/:slug
    thumb_image_url   VARCHAR(500)  DEFAULT NULL,       -- small image for city cards
    short_description VARCHAR(300)  DEFAULT NULL,
    is_active         TINYINT(1)    NOT NULL DEFAULT 1,
    is_featured       TINYINT(1)    NOT NULL DEFAULT 0, -- shows in "Popular" chips on home
    sort_order        INT           NOT NULL DEFAULT 0,
    created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_city_name (name),
    KEY idx_city_active_featured (is_active, is_featured, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


ALTER TABLE properties
    ADD COLUMN city_id INT DEFAULT NULL AFTER city,
    ADD CONSTRAINT fk_prop_city FOREIGN KEY (city_id) REFERENCES cities (id);

CREATE INDEX idx_prop_city_id ON properties (city_id);

SET FOREIGN_KEY_CHECKS = 1;
INSERT INTO cities (name, slug, state, short_description, is_active, is_featured, sort_order) VALUES
('Mumbai',     'mumbai',     'Maharashtra',   'India''s financial capital — dense hostel and PG supply near stations and business hubs.', 1, 1, 1),
('Bengaluru',  'bengaluru',  'Karnataka',     'India''s tech hub — co-living and PGs close to IT parks.',                                 1, 1, 2),
('Delhi NCR',  'delhi-ncr',  'Delhi',         'Hostels and PGs across Delhi, Gurugram and Noida.',                                        1, 1, 3),
('Pune',       'pune',       'Maharashtra',   'A student and IT city with budget-friendly PG options.',                                   1, 1, 4),
('Hyderabad',  'hyderabad',  'Telangana',     'Growing tech corridor with modern co-living spaces.',                                      1, 1, 5),
('Chennai',    'chennai',    'Tamil Nadu',    'Coastal city with a mix of traditional PGs and new hostels.',                              1, 1, 6),
('Navi Mumbai','navi-mumbai','Maharashtra',   'Planned city, popular with working professionals.',                                        1, 0, 7);

UPDATE properties p
JOIN cities c ON c.name = p.city
SET p.city_id = c.id;

-- Anything left unmatched (e.g. a city not yet in the master list)
-- gets auto-created here so no property is left orphaned:
INSERT INTO cities (name, slug, is_active, is_featured)
SELECT DISTINCT p.city,
       LOWER(REPLACE(REPLACE(TRIM(p.city), ' ', '-'), '.', '')),
       1, 0
FROM properties p
LEFT JOIN cities c ON c.name = p.city
WHERE p.city_id IS NULL AND c.id IS NULL;

UPDATE properties p
JOIN cities c ON c.name = p.city
SET p.city_id = c.id
WHERE p.city_id IS NULL;

-- ──────────────────────────────────────────────────────────
-- 5. Handy view: live property counts per city (used by the
--    API instead of a stored counter, so it's always accurate)
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW city_property_counts AS
SELECT
    c.id,
    c.name,
    c.slug,
    c.state,
    c.banner_image_url,
    c.thumb_image_url,
    c.short_description,
    c.is_featured,
    c.sort_order,
    COUNT(p.id) AS property_count
FROM cities c
LEFT JOIN properties p
    ON p.city_id = c.id AND p.is_active = 1
WHERE c.is_active = 1
GROUP BY c.id;

UPDATE cities SET
  thumb_image_url  = 'https://commons.wikimedia.org/wiki/Special:FilePath/Gateway%20of%20India%2C%20Mumbai%2C%20IN.jpg?width=600',
  banner_image_url = 'https://commons.wikimedia.org/wiki/Special:FilePath/Gateway%20of%20India%2C%20Mumbai%2C%20IN.jpg?width=1600'
WHERE slug = 'mumbai';
 
UPDATE cities SET
  thumb_image_url  = 'https://commons.wikimedia.org/wiki/Special:FilePath/Vidhana%20Soudha%20Bangalore.jpg?width=600',
  banner_image_url = 'https://commons.wikimedia.org/wiki/Special:FilePath/Vidhana%20Soudha%20Bangalore.jpg?width=1600'
WHERE slug = 'bengaluru';
 
UPDATE cities SET
  thumb_image_url  = 'https://commons.wikimedia.org/wiki/Special:FilePath/India%20Gate%20in%20New%20Delhi%2003-2016.jpg?width=600',
  banner_image_url = 'https://commons.wikimedia.org/wiki/Special:FilePath/India%20Gate%20in%20New%20Delhi%2003-2016.jpg?width=1600'
WHERE slug = 'delhi-ncr';
 
UPDATE cities SET
  thumb_image_url  = 'https://commons.wikimedia.org/wiki/Special:FilePath/Shaniwar%20Wada%2C%20Pune.jpg?width=600',
  banner_image_url = 'https://commons.wikimedia.org/wiki/Special:FilePath/Shaniwar%20Wada%2C%20Pune.jpg?width=1600'
WHERE slug = 'pune';
 
UPDATE cities SET
  thumb_image_url  = 'https://commons.wikimedia.org/wiki/Special:FilePath/Charminar%2C%20Hyderabad%2C%20Telangana.jpg?width=600',
  banner_image_url = 'https://commons.wikimedia.org/wiki/Special:FilePath/Charminar%2C%20Hyderabad%2C%20Telangana.jpg?width=1600'
WHERE slug = 'hyderabad';
 
UPDATE cities SET
  thumb_image_url  = 'https://commons.wikimedia.org/wiki/Special:FilePath/Chennai%20Kapaleeshwarar%20Temple.jpg?width=600',
  banner_image_url = 'https://commons.wikimedia.org/wiki/Special:FilePath/Chennai%20Kapaleeshwarar%20Temple.jpg?width=1600'
WHERE slug = 'chennai';
 
UPDATE cities SET
  thumb_image_url  = 'https://commons.wikimedia.org/wiki/Special:FilePath/South%20Navi%20Mumbai%20skyline.jpg?width=600',
  banner_image_url = 'https://commons.wikimedia.org/wiki/Special:FilePath/South%20Navi%20Mumbai%20skyline.jpg?width=1600'
WHERE slug = 'navi-mumbai';
  
UPDATE property_images SET image_url = 'https://picsum.photos/seed/hostelhub-p1-main/800/600'  WHERE property_id = 1 AND is_primary = 1;
UPDATE property_images SET image_url = 'https://picsum.photos/seed/hostelhub-p1-room1/800/600' WHERE property_id = 1 AND is_primary = 0;
UPDATE property_images SET image_url = 'https://picsum.photos/seed/hostelhub-p2-main/800/600'  WHERE property_id = 2;
UPDATE property_images SET image_url = 'https://picsum.photos/seed/hostelhub-p3-main/800/600'  WHERE property_id = 3 AND is_primary = 1;
UPDATE property_images SET image_url = 'https://picsum.photos/seed/hostelhub-p3-lounge/800/600' WHERE property_id = 3 AND is_primary = 0;
UPDATE property_images SET image_url = 'https://picsum.photos/seed/hostelhub-p4-main/800/600'  WHERE property_id = 4;
UPDATE property_images SET image_url = 'https://picsum.photos/seed/hostelhub-p5-main/800/600'  WHERE property_id = 5;
-- ============================================================
--  Daily-rate booking support (opt-in per property)
--  Most PGs/hostels are monthly-only. `rent_type` lets an owner
--  flag a property as also (or only) available for daily/short
--  stays. `rooms.daily_rate` is nullable — a room only shows up
--  in daily-rate search results once a price is actually set.
-- ============================================================

ALTER TABLE properties
  ADD COLUMN rent_type ENUM('monthly','daily','both') NOT NULL DEFAULT 'monthly' AFTER property_type;

ALTER TABLE rooms
  ADD COLUMN daily_rate DECIMAL(10,2) DEFAULT NULL AFTER price_per_bed;

CREATE INDEX idx_prop_rent_type ON properties (rent_type);

-- ── Demo data: opt a few existing properties into daily-rate ──
UPDATE properties SET rent_type = 'both' WHERE id IN (1, 3, 5);

UPDATE rooms SET daily_rate = 350 WHERE id = 1;  -- Sunrise PG, Single
UPDATE rooms SET daily_rate = 280 WHERE id = 2;  -- Sunrise PG, Double
UPDATE rooms SET daily_rate = 300 WHERE id = 5;  -- Pink Dorm, Single
UPDATE rooms SET daily_rate = 220 WHERE id = 6;  -- Pink Dorm, Triple
UPDATE rooms SET daily_rate = 600 WHERE id = 9;  -- Skyline, Private
UPDATE rooms SET daily_rate = 400 WHERE id = 10; -- Skyline, Shared

-- Everything else stays rent_type = 'monthly' (the default),
-- with daily_rate left NULL — they simply won't appear in
-- daily-rate search results, which is the intended behavior.