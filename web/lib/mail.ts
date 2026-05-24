import { Resend } from "resend";
import { FROM_EMAIL, FROM_NAME, RESEND_API_KEY } from "./config";

export async function sendOtpMail(to: string, code: string) {
  const resend = new Resend(RESEND_API_KEY());
  const formatted = `${code.slice(0, 4)} ${code.slice(4)}`;
  const html = `<!doctype html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f8;padding:32px;color:#18181b">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ebebed">
    <tr><td style="padding:32px 32px 16px 32px">
      <div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#71717a;margin-bottom:8px">${FROM_NAME}</div>
      <div style="font-size:22px;font-weight:600;line-height:1.3;margin-bottom:8px">Your sign-in code</div>
      <div style="font-size:14px;color:#52525b;margin-bottom:24px">Valid for 10 minutes. If this wasn't you, ignore this email.</div>
      <div style="font-family:ui-monospace,SF Mono,Menlo,monospace;font-size:34px;font-weight:600;letter-spacing:0.18em;text-align:center;background:#f7f7f8;border-radius:12px;padding:20px;color:#09090b">${formatted}</div>
    </td></tr>
    <tr><td style="padding:0 32px 28px 32px;font-size:12px;color:#a1a1aa">
      This email is from the private login of your bridge.
    </td></tr>
  </table></body></html>`;
  const text = `${FROM_NAME}\n\nYour code: ${formatted}\nValid for 10 minutes.`;
  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to,
    subject: `Code ${formatted}`,
    html,
    text,
  });
}
