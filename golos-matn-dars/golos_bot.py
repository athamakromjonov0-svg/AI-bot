"""Telegram golos / dumaloq video -> matn  (bolalar versiyasi)

Kimdir sizga golos 🎙 yoki dumaloq video ⭕️ tashlasa, bot uni matnga aylantirib
o'sha chatning o'ziga, golosga javob (reply) qilib yozadi.

    python golos_bot.py --login     # 1 marta: Telegram'ga kod keladi
    python golos_bot.py             # botni yoqish (kompyuter yoniq tursa ishlaydi)
"""
import json
import os
import sys
import tempfile

import requests
from telethon import TelegramClient, events

# Windows konsoli cp1251 bo'lsa, emoji (👂 🎙) va o'zbekcha matn chiqmaydi -> UTF-8 ga o'tamiz
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

TELEGRAM_LIMIT = 4096   # bitta xabarning maksimal uzunligi
GROQ_LIMIT = 25 * 1024 * 1024   # Groq fayl limiti

# 1) Sozlamalarni o'qiymiz
PAPKA = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(PAPKA, "config.json"), encoding="utf-8"))
client = TelegramClient(os.path.join(PAPKA, "golos"), int(CFG["api_id"]), CFG["api_hash"])


# 2) Ovozni matnga aylantirish (Groq'dagi Whisper modeli)
def matnga_aylantir(fayl_yoli: str) -> str:
    if os.path.getsize(fayl_yoli) > GROQ_LIMIT:
        raise ValueError("fayl juda katta (25 MB dan ortiq)")
    with open(fayl_yoli, "rb") as f:
        javob = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {CFG['groq_key']}"},
            files={"file": (os.path.basename(fayl_yoli), f)},
            data={"model": "whisper-large-v3", "language": "uz", "temperature": 0},
            timeout=120,
        )
    javob.raise_for_status()
    return javob.json()["text"].strip()


# 3) Yangi xabar kelganda shu funksiya ishlaydi
async def javob_yubor(event, matn: str):
    """Uzun matnni 4096 belgidan kichik qismlarga bo'lib yuboradi."""
    matn = matn or "(nutq topilmadi)"
    for i in range(0, len(matn), TELEGRAM_LIMIT):
        await event.reply(matn[i : i + TELEGRAM_LIMIT])


@client.on(events.NewMessage(incoming=True))
async def yangi_xabar(event):
    try:
        await ishla(event)
    except Exception as xato:
        # Xato botni o'ldirmasligi uchun doim ushlab turamiz
        print("❌ Kutilmagan xato:", type(xato).__name__, xato)


async def ishla(event):
    xabar = event.message
    if not (xabar.voice or xabar.video_note):   # golos ham, dumaloq ham emas -> o'tkazamiz
        return
    if not event.is_private:                     # faqat shaxsiy chatlar
        return

    kimdan = await event.get_sender()
    ism = getattr(kimdan, "first_name", None) or "Noma'lum"
    belgi = "⭕️" if xabar.video_note else "🎙"
    soniya = int(getattr(xabar.file, "duration", 0) or 0)
    print(f"{belgi} {ism}dan {soniya}s xabar keldi, o'qiyapman...")

    with tempfile.TemporaryDirectory() as tmp:
        kengaytma = ".mp4" if xabar.video_note else ".ogg"
        fayl = await xabar.download_media(file=os.path.join(tmp, "xabar" + kengaytma))
        if not fayl:
            print("❌ Faylni yuklab bo'lmadi")
            return
        try:
            matn = matnga_aylantir(fayl)
        except Exception as xato:
            print("❌ Xato:", xato)
            return

    await javob_yubor(event, f"{belgi} {matn}")   # o'sha chatga, golosga javob qilib
    print("✅ Chatga yozildi:", matn[:60])


if __name__ == "__main__":
    if "--login" in sys.argv:
        client.start()   # telefon raqam va kodni so'raydi
        print("✅ Login bo'ldi! Endi: python golos_bot.py")
    else:
        client.start()
        print("👂 Tinglayapman... (to'xtatish: Ctrl+C)")
        client.run_until_disconnected()
