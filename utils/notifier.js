// ============================================================
//  WhatsApp (Meta Cloud API) + SMS (MSG91) booking-enquiry alerts
// ============================================================
//
// IMPORTANT — India-specific compliance:
//  • WhatsApp: business-initiated messages MUST use a Meta-approved
//    template unless the recipient messaged your business number in
//    the last 24 hours. Free-form text will fail outside that window.
//  • SMS: TRAI's DLT regulation requires every transactional SMS
//    template to be pre-registered with your telecom operator before
//    it can be sent — unregistered content is silently dropped, not
//    just rejected.

async function sendWhatsAppTemplate({ to, params }) {
  if (!to) return;
  if (!process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.WHATSAPP_ACCESS_TOKEN) {
    console.warn('[notifier] WhatsApp not configured — skipping message to', to);
    return;
  }

  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v20.0';
  const url = `https://graph.facebook.com/${apiVersion}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to: to.replace(/[^\d]/g, ''), // E.164 digits only, e.g. 919876543210
    type: 'template',
    template: {
      name: process.env.WHATSAPP_TEMPLATE_NAME || 'new_booking_alert',
      language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
      components: [
        {
          type: 'body',
          parameters: params.map((p) => ({ type: 'text', text: String(p) })),
        },
      ],
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp send failed (${res.status}): ${errText}`);
  }
}

async function sendSmsTemplate({ to, variables }) {
  if (!to) return;
  if (!process.env.MSG91_AUTH_KEY || !process.env.MSG91_TEMPLATE_ID) {
    console.warn('[notifier] SMS not configured — skipping message to', to);
    return;
  }

  const url = 'https://control.msg91.com/api/v5/flow';

  const body = {
    template_id: process.env.MSG91_TEMPLATE_ID,
    sender: process.env.MSG91_SENDER_ID || 'HSTLKJ',
    short_url: '0',
    mobiles: to.replace(/[^\d]/g, '').replace(/^0/, '91'), // normalize to 91XXXXXXXXXX
    ...variables, // keys must match the ##VARIABLE## placeholders in your DLT-approved template
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authkey: process.env.MSG91_AUTH_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`SMS send failed (${res.status}): ${errText}`);
  }
}

async function sendBookingEnquiryMessages({ booking, property, user, ownerPhone }) {
  const recipients = [process.env.ADMIN_PHONE_1, process.env.ADMIN_PHONE_2, ownerPhone].filter(Boolean);

  const whatsappParams = [
    property.name,
    booking.booking_ref,
    user.full_name,
    user.phone,
    booking.check_in_date,
  ];

  const smsVariables = {
    VAR1: property.name,
    VAR2: booking.booking_ref,
    VAR3: user.full_name,
    VAR4: user.phone,
  };

  const jobs = recipients.flatMap((phone) => [
    sendWhatsAppTemplate({ to: phone, params: whatsappParams }),
    sendSmsTemplate({ to: phone, variables: smsVariables }),
  ]);

  const results = await Promise.allSettled(jobs);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[notifier] message #${i} failed:`, r.reason?.message || r.reason);
    }
  });
}

module.exports = { sendWhatsAppTemplate, sendSmsTemplate, sendBookingEnquiryMessages };