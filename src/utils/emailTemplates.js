/* ------------------------------------------------------------------ *
 *  emailTemplates.js  (NEW)
 *
 *  Table-based HTML (the only thing Outlook renders reliably), inline
 *  styles, no external assets. Every template also ships a plain-text
 *  part — Gmail penalises HTML-only mail, and text/plain is what screen
 *  readers get.
 * ------------------------------------------------------------------ */

const BRAND = "#1F3864";
const ACCENT = "#E7FF50";

/** Escape anything that lands inside HTML (names come from user input). */
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const programName = (source) =>
  source === "Defent La"
    ? "DEFENT ONE · City of Los Angeles"
    : "DEFENT ONE · City of West Hollywood";

/* ================================================================== *
 *  15-DAY SUBSCRIPTION REMINDER
 *  - tells them the next shipment lands in `daysUntilNext` days
 *  - one-click link to cancel (converts them to a one-time order)
 * ================================================================== */
export function renewalReminderEmail({
  firstName,
  source,
  daysUntilNext,
  nextRenewalDate,
  unsubUrl,
}) {
  const name = esc(firstName || "there");
  const prog = esc(programName(source));
  const days = Math.max(0, Number(daysUntilNext) || 0);
  const dayWord = days === 1 ? "day" : "days";
  const dateStr = nextRenewalDate
    ? new Date(nextRenewalDate).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "America/Los_Angeles",
      })
    : "";

  const subject = `Your next DEFENT ONE shipment arrives in ${days} ${dayWord}`;

  const text = [
    `Hi ${firstName || "there"},`,
    ``,
    `You're enrolled in the monthly ${programName(source)} program.`,
    ``,
    `Your next shipment of DEFENT ONE devices is scheduled to go out in ${days} ${dayWord}${
      dateStr ? ` (around ${dateStr})` : ""
    }. It ships free, in plain, unmarked packaging.`,
    ``,
    `If you don't need another shipment, you can cancel your monthly enrollment here:`,
    unsubUrl,
    ``,
    `Cancelling only stops future shipments. It does not affect any order already on its way, and you can always sign up again later.`,
    ``,
    `If you or someone you know needs support, help is free and confidential — call or text 988, or dial 911 in an emergency.`,
    ``,
    `— The DEFENT team`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
  <!-- preheader: shows in the inbox preview, hidden in the body -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    Your next shipment goes out in ${days} ${dayWord}. Cancel any time.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
    <tr><td align="center" style="padding:24px 12px;">

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;
                    font-family:Arial,Helvetica,sans-serif;">

        <tr>
          <td style="background:${BRAND};padding:20px 28px;">
            <div style="color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:.5px;">DEFENT ONE</div>
            <div style="color:#c9d3e8;font-size:12px;padding-top:2px;">${prog}</div>
          </td>
        </tr>

        <tr>
          <td style="padding:28px;">
            <p style="margin:0 0 16px;font-size:16px;color:#1a1a1a;">Hi ${name},</p>

            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#333;">
              You're enrolled in the <strong>monthly</strong> DEFENT ONE program.
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="background:#f4f7fb;border-left:4px solid ${BRAND};border-radius:4px;margin:0 0 20px;">
              <tr><td style="padding:16px 18px;">
                <div style="font-size:15px;line-height:1.6;color:#1a1a1a;">
                  Your next shipment is scheduled to go out in
                  <strong>${days} ${dayWord}</strong>${dateStr ? ` &mdash; around <strong>${esc(dateStr)}</strong>` : ""}.
                </div>
                <div style="font-size:13px;color:#666;padding-top:6px;">
                  Free, with no cost to you, in plain unmarked packaging.
                </div>
              </td></tr>
            </table>

            <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#333;">
              Don't need another shipment? You can cancel your monthly enrollment &mdash; no questions asked.
            </p>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 18px;">
              <tr><td align="center" bgcolor="${BRAND}" style="border-radius:6px;">
                <a href="${esc(unsubUrl)}"
                   style="display:inline-block;padding:12px 26px;font-size:15px;font-weight:bold;
                          color:#ffffff;text-decoration:none;border-radius:6px;">
                  Cancel my monthly shipments
                </a>
              </td></tr>
            </table>

            <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:#666;">
              Cancelling only stops <em>future</em> shipments. It won't affect an order already on its way,
              and you can sign up again any time.
            </p>

            <hr style="border:none;border-top:1px solid #e6e6e6;margin:0 0 18px;">

            <p style="margin:0;font-size:13px;line-height:1.6;color:#666;">
              If you or someone you know needs support, help is free and confidential.
              Call or text <strong>988</strong>, or dial <strong>911</strong> in an emergency.
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#2b2b2b;padding:16px 28px;">
            <div style="font-size:12px;color:#bdbdbd;line-height:1.6;">
              You're receiving this because you enrolled in monthly DEFENT ONE shipments.<br>
              <a href="${esc(unsubUrl)}" style="color:${ACCENT};text-decoration:underline;">Cancel monthly shipments</a>
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}

/* ================================================================== *
 *  UNSUBSCRIBE — STEP 1: confirmation page (rendered on GET)
 *
 *  ⚠ THIS PAGE EXISTS FOR A REASON. Gmail / Outlook / corporate security
 *    scanners PRE-FETCH every link in an email. If GET cancelled the
 *    subscription directly, people would be unsubscribed just because a
 *    scanner touched the link. So GET only *renders*; the POST button
 *    below is what actually cancels.
 * ================================================================== */
export function unsubConfirmPage({ token, firstName, alreadyCancelled }) {
  const name = esc(firstName || "");
  const greeting = name ? `${name}, ` : "";

  if (alreadyCancelled) {
    return unsubResultPage({
      title: "You're already unsubscribed",
      body: "Your monthly shipments were already cancelled — there's nothing more to do. You won't receive any further DEFENT ONE shipments.",
      tone: "ok",
    });
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cancel monthly shipments</title>
<style>
  body{margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;}
  .wrap{max-width:520px;margin:48px auto;padding:0 16px;}
  .card{background:#fff;border-radius:10px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
  h1{margin:0 0 12px;font-size:22px;color:#1a1a1a;}
  p{margin:0 0 16px;font-size:15px;line-height:1.6;color:#444;}
  .muted{font-size:13px;color:#777;}
  button{background:${BRAND};color:#fff;border:0;border-radius:6px;padding:13px 24px;
         font-size:15px;font-weight:600;cursor:pointer;width:100%;}
  button:disabled{opacity:.6;cursor:default;}
  .brand{font-size:12px;letter-spacing:1px;color:${BRAND};font-weight:700;margin-bottom:18px;}
</style></head>
<body>
  <div class="wrap"><div class="card">
    <div class="brand">DEFENT ONE</div>
    <h1>Cancel monthly shipments?</h1>
    <p>${greeting}this will stop your <strong>future monthly</strong> DEFENT ONE shipments.</p>
    <p class="muted">
      Any order already on its way is not affected, and you can sign up again at any time.
    </p>
    <form method="POST" action="/api/v1/subscription/unsubscribe">
      <input type="hidden" name="t" value="${esc(token)}">
      <button type="submit" onclick="this.disabled=true;this.innerText='Cancelling…';this.form.submit();">
        Yes, cancel my monthly shipments
      </button>
    </form>
    <p class="muted" style="margin-top:18px;text-align:center;">
      Changed your mind? Just close this page — nothing has changed yet.
    </p>
  </div></div>
</body></html>`;
}

/* ---- UNSUBSCRIBE — STEP 2: result page (rendered after POST) ---- */
export function unsubResultPage({ title, body, tone = "ok" }) {
  const color = tone === "error" ? "#B3261E" : BRAND;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;}
  .wrap{max-width:520px;margin:48px auto;padding:0 16px;}
  .card{background:#fff;border-radius:10px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
  h1{margin:0 0 12px;font-size:22px;color:${color};}
  p{margin:0 0 14px;font-size:15px;line-height:1.6;color:#444;}
  .muted{font-size:13px;color:#777;}
  .brand{font-size:12px;letter-spacing:1px;color:${BRAND};font-weight:700;margin-bottom:18px;}
</style></head>
<body>
  <div class="wrap"><div class="card">
    <div class="brand">DEFENT ONE</div>
    <h1>${esc(title)}</h1>
    <p>${esc(body)}</p>
    <p class="muted">
      If you or someone you know needs support, help is free and confidential.
      Call or text <strong>988</strong>, or dial <strong>911</strong> in an emergency.
    </p>
  </div></div>
</body></html>`;
}
