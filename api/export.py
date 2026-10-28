"""HRM STOCK · Excel export on Vercel (Python)
POST /api/export {months:[YYYY-MM], blank, fname, title, ctx} → {ok, data:{name, size, b64, mime}}
Same original-layout workbook as the desktop program (openpyxl + a3_template.xlsx) — Google Sheets' own export loses the form layout.
Data comes from Apps Script (month_get) with the shared key; the team cookie is checked like api/[name].js."""
import base64
import hashlib
import hmac
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "_export"))
import xlsx_export  # noqa: E402

COOKIE = "hrm_team"


def _sign(exp, kind="team"):
    key = (os.environ.get("GAS_KEY", "") + "|" + os.environ.get("TEAM_CODE", "").strip()).encode()
    return base64.urlsafe_b64encode(hmac.new(key, f"{kind}:{exp}".encode(), hashlib.sha256).digest()).rstrip(b"=").decode()


def _signed_in(cookie_header):
    if not os.environ.get("TEAM_CODE", "").strip():
        return True
    m = re.search(r"(?:^|;\s*)" + COOKIE + r"=([^;]+)", cookie_header or "")
    if not m:
        return False
    tok = urllib.parse.unquote(m.group(1))
    exp, _, sig = tok.partition(".")
    if not exp.isdigit() or int(exp) < time.time() * 1000:
        return False
    return hmac.compare_digest(sig, _sign(exp))


def _gas(name, args, ctx, origin):
    url, key = os.environ.get("GAS_URL", ""), os.environ.get("GAS_KEY", "")
    if not url or not key:
        raise RuntimeError("ยังไม่ได้ตั้ง GAS_URL / GAS_KEY ใน Vercel")
    body = json.dumps({"hrm": "api", "key": key, "name": name, "args": args, "ctx": ctx or {}, "origin": origin}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "text/plain;charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=50) as r:     # Apps Script answers with a redirect; urllib follows it as GET
        res = json.loads(r.read().decode("utf-8"))
    if not res.get("ok"):
        raise RuntimeError(res.get("error") or "Google ตอบกลับผิดปกติ")
    return res["data"]


class handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        out = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_POST(self):
        try:
            if not _signed_in(self.headers.get("cookie", "")):
                return self._send(200, {"ok": False, "need_login": True, "error": "กรุณาใส่รหัสทีม"})
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
            months = sorted({m for m in (body.get("months") or []) if re.fullmatch(r"\d{4}-\d{2}", str(m))})[:24]
            if not months:
                return self._send(200, {"ok": False, "error": "ยังไม่ได้เลือกเดือน"})
            host = self.headers.get("x-forwarded-host") or self.headers.get("host") or ""
            data = [_gas("month_get", [m], body.get("ctx") or {}, "https://" + host if host else "") for m in months]
            name = re.sub(r'[\\/:*?"<>|]+', "_", str(body.get("fname") or "HRM-STOCK.xlsx"))[:120]
            if not name.lower().endswith(".xlsx"):
                name += ".xlsx"
            buf = io.BytesIO()
            xlsx_export.write_xlsx(buf, data, blank=bool(body.get("blank")), title=str(body.get("title") or "").strip()[:60])
            raw = buf.getvalue()
            return self._send(200, {"ok": True, "data": {"name": name, "size": len(raw), "b64": base64.b64encode(raw).decode(),
                                                       "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}})
        except Exception as e:  # noqa: BLE001
            return self._send(200, {"ok": False, "error": "สร้างไฟล์ Excel ไม่สำเร็จ: " + str(e)[:200]})

    def do_GET(self):
        return self._send(405, {"ok": False, "error": "POST only"})
