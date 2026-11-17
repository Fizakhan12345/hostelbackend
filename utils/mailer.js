const nodemailer = require('nodemailer');

// One transporter, reused for every request — creating a fresh SMTP
// connection per email is the #1 cause of slow booking endpoints.
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === 'true', // true for 465, false for 587
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Verify the SMTP connection once at boot so misconfiguration fails loud
// and early rather than silently on the first real booking.
transporter.verify().then(
  () => console.log('[mailer] SMTP connection ready'),
  (err) => console.error('[mailer] SMTP verify failed:', err.message)
);

const BRAND = {
  navy: '#14152C',
  amber: '#F2891C',
  cream: '#FBF7EF',
  ink: '#666A82',
  line: '#E4DCC8',
};

function wrapper(title, bodyHtml) {
  return `
  <div style="background:${BRAND.cream};padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid ${BRAND.line};">
      <div style="background:${BRAND.navy};padding:22px 28px;">
        <span style="color:${BRAND.amber};font-size:20px;font-weight:700;">HostelKhojo</span>
      </div>
      <div style="padding:28px;">
        <h2 style="color:${BRAND.navy};margin:0 0 16px;font-size:20px;">${title}</h2>
        ${bodyHtml}
      </div>
      <div style="padding:16px 28px;background:${BRAND.cream};border-top:1px solid ${BRAND.line};color:${BRAND.ink};font-size:12px;">
        HostelKhojo — 100% verified hostels &amp; PGs, broker-free. This is an automated email, please do not reply directly.
      </div>
    </div>
  </div>`;
}

function infoRow(label, value) {
  return `<tr>
    <td style="padding:6px 0;color:${BRAND.ink};font-size:13px;width:170px;vertical-align:top;">${label}</td>
    <td style="padding:6px 0;color:${BRAND.navy};font-size:13px;font-weight:600;">${value}</td>
  </tr>`;
}

/**
 * Fires all three booking-enquiry emails in parallel:
 *  1. Fixed internal recipients (ops team)
 *  2. The property owner (admin who listed the property)
 *  3. A confirmation to the user who made the enquiry
 * Any single failure is logged but does not throw — a flaky mailbox
 * should never fail the booking API response.
 */
async function sendBookingEnquiryEmails({ booking, property, room, user, ownerEmail, address, city }) {
  const detailsTable = `
    <table style="width:100%;border-collapse:collapse;margin:12px 0 20px;">
      ${infoRow('Booking Ref', booking.booking_ref)}
      ${infoRow('Property', property.name)}
      ${infoRow('Property Address', `${property.area || ''}, ${property.city}`)}
      ${infoRow('Room Type', room.room_type)}
      ${infoRow('Check-in Date', booking.check_in_date)}
      ${infoRow('Duration', `${booking.duration_months} month(s)`)}
      ${infoRow('Monthly Rent', `₹${Number(booking.monthly_rent).toLocaleString('en-IN')}`)}
      ${infoRow('Security Deposit', `₹${Number(booking.security_deposit).toLocaleString('en-IN')}`)}
      ${infoRow('Total Payable Now', `₹${Number(booking.total_amount).toLocaleString('en-IN')}`)}
      ${infoRow('Enquirer Name', user.full_name)}
      ${infoRow('Enquirer Phone', user.phone)}
      ${infoRow('Enquirer Email', user.email)}
      ${address ? infoRow('Enquirer Address', address) : ''}
      ${city ? infoRow('Enquirer City', city) : ''}
    </table>`;

  const internalHtml = wrapper(
    'New Booking Enquiry Received',
    `<p style="color:${BRAND.ink};font-size:14px;">A new booking enquiry has come in via HostelKhojo. Full details below:</p>${detailsTable}`
  );

  const ownerHtml = wrapper(
    'New Enquiry for Your Property',
    `<p style="color:${BRAND.ink};font-size:14px;">Someone is interested in <strong>${property.name}</strong>. Please reach out to them within 2 hours.</p>${detailsTable}`
  );

  const userHtml = wrapper(
    'We\u2019ve Received Your Booking Enquiry!',
    `<p style="color:${BRAND.ink};font-size:14px;">Thanks for choosing HostelKhojo. Your enquiry for <strong>${property.name}</strong> has been sent to the property owner.</p>
     <p style="background:${BRAND.cream};border:1px dashed ${BRAND.amber};border-radius:8px;padding:14px 16px;color:${BRAND.navy};font-weight:700;font-size:14px;">
       ⏱️ We will reach you within 2 hours.
     </p>
     ${detailsTable}`
  );

  const fromAddr = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  const internalRecipients = [process.env.ENQUIRY_EMAIL_1, process.env.ENQUIRY_EMAIL_2].filter(Boolean);

  const jobs = [
    transporter.sendMail({
      from: fromAddr,
      to: internalRecipients,
      subject: `New Enquiry — ${property.name} (${booking.booking_ref})`,
      html: internalHtml,
    }),
  ];

  if (ownerEmail) {
    jobs.push(
      transporter.sendMail({
        from: fromAddr,
        to: ownerEmail,
        subject: `New Enquiry for ${property.name} (${booking.booking_ref})`,
        html: ownerHtml,
      })
    );
  }

  if (user.email) {
    jobs.push(
      transporter.sendMail({
        from: fromAddr,
        to: user.email,
        subject: `We\u2019ve got your enquiry — ${property.name}`,
        html: userHtml,
      })
    );
  }

  const results = await Promise.allSettled(jobs);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[mailer] booking enquiry email #${i} failed:`, r.reason?.message || r.reason);
    }
  });
}

module.exports = { transporter, sendBookingEnquiryEmails };