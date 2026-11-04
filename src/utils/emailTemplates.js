/* ------------------------------------------------------------------ *
 *  emailTemplates.js  (NEW)
 *
 *  Table-based HTML (the only thing Outlook renders reliably), inline
 *  styles, no external assets. Every template also ships a plain-text
 *  part — Gmail penalises HTML-only mail, and text/plain is what screen
 *  readers get.
 * ------------------------------------------------------------------ */

import { siteOf, cycleWordFor } from "./cycle.js";

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

const cityName = (source) =>
  source === "Defent La" ? "City of Los Angeles" : "City of West Hollywood";

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
  const site = siteOf(source);
  const city = cityName(source);
  const prog = programName(source);
  const word = cycleWordFor(site); // "monthly" (WEHO) / "quarterly" (LA)
  const planLabel = word.charAt(0).toUpperCase() + word.slice(1);

  const name = esc(firstName || "there");
  const days = Math.max(0, Number(daysUntilNext) || 0);
  const dayWord = days === 1 ? "day" : "days";

  const fmt = (opts) =>
    nextRenewalDate
      ? new Date(nextRenewalDate).toLocaleDateString("en-US", {
          /* Due dates are midnight UTC on the ship day (the cron then fires
             at midnight LA on that same date). Formatting in LA time would
             show the evening BEFORE — one day early. */
          timeZone: "UTC",
          ...opts,
        })
      : "";
  const dateLong = fmt({ month: "long", day: "numeric", year: "numeric" }); // December 4, 2026
  const dateCard = fmt({ weekday: "short", month: "long", day: "numeric" }); // Thu, December 4
  const yearStr = fmt({ year: "numeric" }); // 2026
  const datePreview = fmt({ weekday: "long", month: "long", day: "numeric" }); // Thursday, December 4

  /* Optional. No SUPPORT_EMAIL -> no "Contact us" link (never a placeholder). */
  const support = String(process.env.SUPPORT_EMAIL || "").trim();

  const subject = `Your next DEFENT ONE shipment goes out in ${days} ${dayWord}`;

  const text = [
    `Hi ${firstName || "there"},`,
    ``,
    `Your next free DEFENT ONE shipment goes out in ${days} ${dayWord}${
      dateLong ? ` (${dateLong})` : ""
    }.`,
    `Plan: ${planLabel} · ${prog}`,
    ``,
    `- Nothing to do. It ships automatically to the address you gave us.`,
    `- Private. Plain, unmarked packaging, always.`,
    `- Your choice. Cancel any time, no questions asked.`,
    ``,
    `Don't need this one? Cancelling stops future shipments only. Anything already on its way still arrives, and you can re-enroll any time:`,
    unsubUrl,
    ``,
    `Need to talk to someone? Help is free and confidential. Call or text 988, or dial 911 in an emergency.`,
    ``,
    `— The DEFENT team`,
    ...(support ? [``, `Questions? ${support}`] : []),
  ].join("\n");

  const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif";
  const check = `<div style="width:20px;height:20px;border-radius:10px;background-color:${ACCENT};text-align:center;font-size:12px;line-height:20px;font-weight:700;color:${BRAND};">&#10003;</div>`;
  const bullet = (strong, rest) => `
                      <tr>
                        <td width="28" valign="top" style="padding:2px 0 12px 0;">${check}</td>
                        <td valign="top" style="padding:0 0 12px 8px;font-size:15px;line-height:22px;color:#33415C;">
                          <strong style="color:#14213D;">${strong}</strong> ${rest}
                        </td>
                      </tr>`;

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<style>
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  a { text-decoration:none; }
  @media only screen and (max-width:600px) {
    .container { width:100% !important; }
    .px { padding-left:24px !important; padding-right:24px !important; }
    .hero-title { font-size:26px !important; line-height:32px !important; }
    .stack { display:block !important; width:100% !important; }
    .stack-gap { padding-top:12px !important; border-left:0 !important; border-top:1px solid #E3E8F0 !important; }
    .btn a { display:block !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#EEF1F6;">

  <!-- inbox preview text, hidden in the body -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">
    Your next free shipment goes out${datePreview ? ` on ${esc(datePreview)}` : ` in ${days} ${dayWord}`}. Nothing to do &mdash; or cancel any time.
    &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EEF1F6" style="background-color:#EEF1F6;">
    <tr>
      <td align="center" style="padding:32px 12px;">

        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

          <!-- brand row -->
          <tr>
            <td class="px" style="padding:0 8px 16px 8px;font-family:${FONT};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:15px;font-weight:800;letter-spacing:2px;color:${BRAND};">
                    DEFENT<span style="font-weight:400;"> ONE</span>
                  </td>
                  <td align="right" style="font-size:12px;color:#5B6B85;">${esc(city)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- card -->
          <tr>
            <td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border-radius:14px;overflow:hidden;">

              <!-- hero -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td bgcolor="${BRAND}" style="background-color:${BRAND};height:6px;line-height:6px;font-size:0;">
                    <table role="presentation" width="96" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${ACCENT}" style="background-color:${ACCENT};height:6px;line-height:6px;font-size:0;">&nbsp;</td></tr></table>
                  </td>
                </tr>
                <tr>
                  <td class="px" bgcolor="${BRAND}" style="background-color:${BRAND};padding:36px 48px 40px 48px;font-family:${FONT};">
                    <div style="font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${ACCENT};">
                      Shipment reminder
                    </div>
                    <h1 class="hero-title" style="margin:12px 0 0 0;font-size:32px;line-height:38px;font-weight:700;color:#FFFFFF;letter-spacing:-0.5px;">
                      Your next shipment goes out in ${days}&nbsp;${dayWord}
                    </h1>
                    <p style="margin:14px 0 0 0;font-size:16px;line-height:24px;color:#C9D3E8;">
                      Hi ${name}, here's a quick heads-up so nothing arrives unexpected.
                    </p>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <!-- details -->
                <tr>
                  <td class="px" style="padding:32px 48px 8px 48px;font-family:${FONT};">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E3E8F0;border-radius:12px;">
                      <tr>
                        <td class="stack" width="50%" valign="top" style="padding:20px 22px;">
                          <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#7A879C;">Ships on</div>
                          <div style="margin-top:6px;font-size:20px;line-height:26px;font-weight:700;color:#14213D;">${esc(dateCard || `In ${days} ${dayWord}`)}</div>
                          ${yearStr ? `<div style="margin-top:2px;font-size:13px;color:#5B6B85;">${esc(yearStr)}</div>` : ""}
                        </td>
                        <td class="stack stack-gap" width="50%" valign="top" style="padding:20px 22px;border-left:1px solid #E3E8F0;">
                          <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#7A879C;">Plan</div>
                          <div style="margin-top:6px;font-size:20px;line-height:26px;font-weight:700;color:#14213D;">${esc(planLabel)}</div>
                          <div style="margin-top:2px;font-size:13px;color:#5B6B85;">Free &middot; no cost to you</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- reassurance -->
                <tr>
                  <td class="px" style="padding:24px 48px 8px 48px;font-family:${FONT};">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${bullet(
                      "Nothing to do.",
                      "It ships automatically to the address you gave us.",
                    )}${bullet("Private.", "Plain, unmarked packaging &mdash; always.")}${bullet(
                      "Your choice.",
                      "Cancel any time, no questions asked.",
                    )}
                    </table>
                  </td>
                </tr>

                <!-- divider -->
                <tr>
                  <td class="px" style="padding:16px 48px 0 48px;">
                    <div style="height:1px;line-height:1px;font-size:0;background-color:#E3E8F0;">&nbsp;</div>
                  </td>
                </tr>

                <!-- cancel -->
                <tr>
                  <td class="px" style="padding:24px 48px 8px 48px;font-family:${FONT};">
                    <p style="margin:0 0 4px 0;font-size:16px;line-height:24px;font-weight:700;color:#14213D;">Don't need this one?</p>
                    <p style="margin:0 0 20px 0;font-size:15px;line-height:22px;color:#5B6B85;">
                      Cancelling stops future shipments only. Anything already on its way still arrives, and you can re-enroll any time.
                    </p>
                    <table role="presentation" class="btn" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" style="border:2px solid ${BRAND};border-radius:10px;">
                          <a href="${esc(unsubUrl)}" target="_blank"
                             style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:${BRAND};text-decoration:none;border-radius:10px;">
                            Cancel future shipments
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- support -->
                <tr>
                  <td class="px" style="padding:32px 48px 40px 48px;font-family:${FONT};">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F4F7FB" style="background-color:#F4F7FB;border-radius:12px;">
                      <tr>
                        <td style="padding:18px 20px;font-size:14px;line-height:21px;color:#33415C;">
                          <strong style="color:#14213D;">Need to talk to someone?</strong>
                          Help is free and confidential. Call or text
                          <a href="tel:988" style="color:${BRAND};font-weight:700;text-decoration:underline;">988</a>,
                          or dial <strong style="color:#14213D;">911</strong> in an emergency.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- footer -->
          <tr>
            <td class="px" align="center" style="padding:28px 24px 8px 24px;font-family:${FONT};font-size:12px;line-height:19px;color:#7A879C;">
              <strong style="color:#5B6B85;">${esc(prog)}</strong><br>
              You're receiving this because you enrolled in ${esc(word)} DEFENT ONE shipments.<br>
              <a href="${esc(unsubUrl)}" style="color:${BRAND};text-decoration:underline;">Cancel shipments</a>${
                support
                  ? `
              &nbsp;&middot;&nbsp;
              <a href="mailto:${esc(support)}" style="color:${BRAND};text-decoration:underline;">Contact us</a>`
                  : ""
              }
            </td>
          </tr>

        </table>

      </td>
    </tr>
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

/* ================================================================== *
 *  ORDER ON THE WAY  (client requirement)
 *  Sent the moment a renewal (or first order) is confirmed in Shopify.
 *    "Your quarterly Order #4232 is on the way"
 *  - carries the REAL Shopify order number
 *  - cancel-subscription button (same signed unsubUrl as the reminder)
 *  - cycleWord derives from the cycle length, never hardcoded
 * ================================================================== */
export function orderOnTheWayEmail({
  firstName,
  source,
  orderNumber, // Shopify order name, e.g. "#4232" or "4232"
  shipToLine, // optional: "1145 N Ogden Dr, Apt 109" (display only)
  nextRenewalDate, // optional: when the following shipment is due
  unsubUrl, // required for recurring orders
  cycleWord = "quarterly",
}) {
  const name = esc(firstName || "there");
  const prog = esc(programName(source));
  const num = String(orderNumber || "").replace(/^#/, "");
  const numDisp = num ? `#${num}` : "";
  const cyc = esc(cycleWord);
  const nextStr = nextRenewalDate
    ? new Date(nextRenewalDate).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC", // due dates are midnight UTC on the ship day

      })
    : "";

  const subject = num
    ? `Your ${cycleWord} order ${numDisp} is on the way`
    : `Your ${cycleWord} DEFENT ONE order is on the way`;

  const text = [
    `Hi ${firstName || "there"},`,
    ``,
    `Good news — your ${cycleWord} DEFENT ONE order${num ? ` ${numDisp}` : ""} has been created and is on the way.`,
    shipToLine ? `` : null,
    shipToLine ? `Shipping to: ${shipToLine}` : null,
    ``,
    `It ships free, in plain, unmarked packaging. No action is needed from you.`,
    nextStr ? `` : null,
    nextStr ? `Your following shipment is scheduled around ${nextStr}.` : null,
    ``,
    unsubUrl
      ? `Don't need future shipments? Cancel your ${cycleWord} enrollment here (this order still arrives):`
      : null,
    unsubUrl || null,
    ``,
    `If you or someone you know needs support, help is free and confidential — call or text 988, or dial 911 in an emergency.`,
    ``,
    `— The DEFENT team`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    Your ${cyc} order${num ? ` ${esc(numDisp)}` : ""} has shipped — free, plain packaging, nothing to do.
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

            <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#333;">
              Good news — your <strong>${cyc}</strong> DEFENT ONE order is on the way.
            </p>

            ${
              num
                ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="background:#f4f7fb;border-left:4px solid ${BRAND};border-radius:4px;margin:0 0 20px;">
              <tr><td style="padding:16px 18px;">
                <div style="font-size:13px;color:#666;">Order number</div>
                <div style="font-size:22px;font-weight:bold;color:${BRAND};padding-top:2px;">${esc(numDisp)}</div>
                ${shipToLine ? `<div style="font-size:13px;color:#666;padding-top:8px;">Shipping to: ${esc(shipToLine)}</div>` : ""}
              </td></tr>
            </table>`
                : ""
            }

            <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#333;">
              It ships <strong>free</strong>, in plain, unmarked packaging. No action is needed from you.
              ${nextStr ? `Your following shipment is scheduled around <strong>${esc(nextStr)}</strong>.` : ""}
            </p>

            ${
              unsubUrl
                ? `<hr style="border:none;border-top:1px solid #e6e6e6;margin:0 0 18px;">

            <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#333;">
              Don't need future shipments? You can cancel your ${cyc} enrollment &mdash; no questions asked.
              This order still arrives.
            </p>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px;">
              <tr><td align="center" bgcolor="${BRAND}" style="border-radius:6px;">
                <a href="${esc(unsubUrl)}"
                   style="display:inline-block;padding:12px 26px;font-size:15px;font-weight:bold;
                          color:#ffffff;text-decoration:none;border-radius:6px;">
                  Cancel my ${cyc} shipments
                </a>
              </td></tr>
            </table>`
                : ""
            }

            <p style="margin:0;font-size:13px;line-height:1.6;color:#666;">
              If you or someone you know needs support, help is free and confidential.
              Call or text <strong>988</strong>, or dial <strong>911</strong> in an emergency.
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#2b2b2b;padding:16px 28px;">
            <div style="font-size:12px;color:#bdbdbd;line-height:1.6;">
              You're receiving this because you're enrolled in ${cyc} DEFENT ONE shipments.${
                unsubUrl
                  ? `<br><a href="${esc(unsubUrl)}" style="color:${ACCENT};text-decoration:underline;">Cancel ${cyc} shipments</a>`
                  : ""
              }
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
