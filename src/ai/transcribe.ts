import { config } from '../config/env';
import { logger } from '../config/logger';
import { getLLMClient } from './llm';
import { toUzbekLatin } from './uzbekLatin';

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const UZBEK_PROMPT =
  "Salom. Ha, xo'p. Rahmat. Nima gap? Yaxshi. Kelaman. Ko'rdim. Aytdim. Bilaman. Qani. Endi.";
const GROQ_FILE_LIMIT = 25 * 1024 * 1024;

export class TranscriptionError extends Error {}

const CYRILLIC_RE = /[\u0400-\u04FF]/;

const FIX_PROMPT = `Whisper ovoz tanish tizimi o'zbekcha nutqni biroz xato transkripsiya qildi.
Maqsad: har bir xato yozilgan so'zni to'g'ri o'zbekcha shaklga keltirish.

QAT'IY QOIDALAR:
1. So'zlar sonini o'zgartirma — nechtasi kirsa, shunchasi chiqsin.
2. Yangi so'z, gap, izoh QO'SHMA.
3. Gapni so'roqqa, buyruqqa yoki boshqa shaklga aylantirma — asl shakli saqlansin.
4. Qaysi so'z ekanligini bilmasang — o'zgartirilmay qolsin.
5. Agar bir xil so'z ketma-ket 2 martadan ko'p takrorlangan bo'lsa (Whisper xatosi, masalan "londa londa londa") — bittaga qisqartir.
6. Javobda faqat to'g'rilangan matnning o'zi bo'lsin.`;

/**
 * Whisper halüsinatsiyasini tozalash: bir xil so'z 3+ marta takrorlansa
 * bittaga qisqartiriladi ("londa londa londa" -> "londa").
 * 2 marta takror (tabiiy urg'u) o'zgarmaydi.
 */
function collapseRepeats(text: string): string {
  return text.replace(/\b(\p{L}+)(\s+\1){2,}/gu, '$1');
}

async function fixUzbek(text: string): Promise<string> {
  try {
    const res = await getLLMClient().chat.completions.create({
      model: config.LLM_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: FIX_PROMPT },
        { role: 'user', content: text },
      ],
    });
    const out = (res.choices[0]?.message?.content || '').trim()
      .replace(/^["«]|["»]$/g, '').trim();
    if (!out) return text;
    logger.info(`Uzbek fixed: "${text}" -> "${out}"`);
    return out;
  } catch (err) {
    logger.warn('Uzbek fix failed, returning raw:', err);
    return text;
  }
}

export async function transcribeAudio(
  buffer: Buffer,
  fileName: string,
  language: string = 'uz'
): Promise<string> {
  if (!config.GROQ_API_KEY) {
    throw new TranscriptionError('GROQ_API_KEY is not set in .env');
  }
  if (buffer.length > GROQ_FILE_LIMIT) {
    throw new TranscriptionError('Audio file is larger than 25 MB (Groq limit)');
  }

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)]), fileName);
  form.append('model', 'whisper-large-v3');
  form.append('language', language);
  form.append('temperature', '0');
  form.append('prompt', UZBEK_PROMPT);

  const response = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.GROQ_API_KEY}` },
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.error(`Groq transcription failed: ${response.status} ${detail}`);
    throw new TranscriptionError(`Groq API error (${response.status})`);
  }

  const data = (await response.json()) as { text?: string };
  const rawText = (data.text || '').trim();
  if (!rawText) return '';

  // Kirill → lotin (so'z o'zgarmaydi)
  const latinText = CYRILLIC_RE.test(rawText) ? toUzbekLatin(rawText) : rawText;

  // Whisper takroriy halüsinatsiyasini kesish
  const cleaned = collapseRepeats(latinText);

  // LLM: faqat o'zbek fonetik xatolarini tuzat (so'z soni saqlanadi)
  return await fixUzbek(cleaned);
}
