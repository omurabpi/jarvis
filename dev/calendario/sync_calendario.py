"""Legge il calendario Apple pubblicato (link webcal/ICS) e lo mette, cifrato, nel gist di Jarvis.

Gira su GitHub Actions ogni 30 minuti (repo privato omurabpi/jarvis-calendario) oppure a mano:
    python tools/calendario/sync_calendario.py
Variabili d'ambiente (segreti del repository, o file .env nella cartella del progetto):
    GOOGLE_CALENDAR_URL o APPLE_CALENDAR_URL  link ICS del calendario (Google: "indirizzo segreto in formato iCal";
                        iCloud: link del calendario pubblico). Più calendari: link separati da virgola.
    GITHUB_SYNC_TOKEN   token GitHub dell'utente Jarvis (permesso "gist")
La cifratura è la stessa dell'app (sync.js, versione 2): AES-GCM con chiave PBKDF2
derivata dall'id dell'account GitHub, contenuto JSON compresso con gzip.
"""
import base64, datetime as dt, gzip, hashlib, json, os, sys, urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

import icalendar
import recurring_ical_events
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

TZ = ZoneInfo("Europe/Rome")
DAYS_AHEAD, DAYS_BEHIND, MAX_EVENTS = 21, 1, 250
GIST_DESCRIPTION = "Jarvis: dati sincronizzati (cifrati)"
FILE = "calendario.json"


def load_env():
    env = Path(__file__).resolve().parents[2] / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def github(token, path, method="GET", body=None):
    req = urllib.request.Request("https://api.github.com" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                                          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "jarvis-calendario"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def fetch_events(url):
    url = url.strip().replace("webcal://", "https://", 1)
    req = urllib.request.Request(url, headers={"User-Agent": "jarvis-calendario"})
    with urllib.request.urlopen(req, timeout=60) as r:
        cal = icalendar.Calendar.from_ical(r.read())
    name = str(cal.get("X-WR-CALNAME", "Calendario"))
    now = dt.datetime.now(TZ)
    start, end = now - dt.timedelta(days=DAYS_BEHIND), now + dt.timedelta(days=DAYS_AHEAD)
    events = []
    for ev in recurring_ical_events.of(cal).between(start, end):
        s, e = ev.get("DTSTART").dt, (ev.get("DTEND") or ev.get("DTSTART")).dt
        all_day = not isinstance(s, dt.datetime)
        if all_day:
            s_txt, e_txt = s.isoformat(), e.isoformat()
        else:
            s = s.astimezone(TZ) if s.tzinfo else s.replace(tzinfo=TZ)
            e = e.astimezone(TZ) if e.tzinfo else e.replace(tzinfo=TZ)
            s_txt, e_txt = s.strftime("%Y-%m-%dT%H:%M"), e.strftime("%Y-%m-%dT%H:%M")
        events.append({"t": str(ev.get("SUMMARY", "(senza titolo)")).strip(), "s": s_txt, "e": e_txt,
                       "l": str(ev.get("LOCATION", "") or "").strip(), "a": all_day})
    events.sort(key=lambda x: x["s"])
    return name, events[:MAX_EVENTS]


def seal(data, user_id):
    secret = f"jarvis-sync-v2|{user_id}".encode()
    key = hashlib.pbkdf2_hmac("sha256", secret, secret, 150000, dklen=32)
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, gzip.compress(json.dumps(data, ensure_ascii=False).encode()), None)
    return json.dumps({"v": 2, "iv": base64.b64encode(iv).decode(), "data": base64.b64encode(ct).decode(),
                       "updated": dt.datetime.now(dt.timezone.utc).isoformat()})


def main():
    load_env()
    raw_urls = os.environ.get("CALENDAR_URL") or os.environ.get("GOOGLE_CALENDAR_URL") or os.environ.get("APPLE_CALENDAR_URL") or ""
    urls = [u.strip() for u in raw_urls.split(",") if u.strip()]
    token = os.environ.get("JARVIS_TOKEN") or os.environ.get("GITHUB_SYNC_TOKEN") or os.environ.get("GITHUB_TOKEN", "")
    if not urls or not token:
        sys.exit("Mancano i segreti CALENDAR_URL (link del calendario) o JARVIS_TOKEN (token GitHub di Jarvis).")
    names, events = [], []
    for url in urls:
        n, ev = fetch_events(url)
        names.append(n); events += ev
    events = sorted(events, key=lambda x: x["s"])[:MAX_EVENTS]
    name = " + ".join(names)
    user = github(token, "/user")
    gist_id = None
    for page in range(1, 6):
        gists = github(token, f"/gists?per_page=100&page={page}")
        gist_id = next((g["id"] for g in gists if g.get("description") == GIST_DESCRIPTION), None)
        if gist_id or len(gists) < 100:
            break
    if not gist_id:
        sys.exit("Archivio Jarvis non trovato: collega prima GitHub nell'app.")
    payload = {"source": "ics", "name": name, "updated": dt.datetime.now(TZ).isoformat(timespec="minutes"), "events": events}
    github(token, f"/gists/{gist_id}", "PATCH", {"files": {FILE: {"content": seal(payload, user["id"])}}})
    # Solo numeri nei log: niente titoli né link.
    print(f"Calendario aggiornato: {len(events)} eventi nei prossimi {DAYS_AHEAD} giorni.")


if __name__ == "__main__":
    main()
