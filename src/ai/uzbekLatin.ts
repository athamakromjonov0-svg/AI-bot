/**
 * Kirill alifbosidagi matnni o'zbek lotin alifbosiga o'girish.
 *
 * Whisper o'zbek tilini ko'pincha kirill (masalan "Салам дастим...") yozib qoladi,
 * shuning uchun transkriptdan keyin lotinga o'tkazamiz. Agar matnda kirill
 * alifbosi bo'lmasa — matn o'zgarmasdan qaytadi.
 */

const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ё: 'yo', ж: 'j', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ғ: 'g', қ: 'q', ҳ: 'h', ў: "o'", ң: 'ng',
};

// So'z boshida yoki unlikdan keyin keladigan "е" -> "ye"
const VOWELS = new Set('аеиоуыэюяёўң');

const CYRILLIC_RE = /[\u0400-\u04FF]/;

function transliterateChar(ch: string, prev: string): string {
  if (ch === 'е' || ch === 'Е') {
    const atStartOrAfterVowel = prev === '' || VOWELS.has(prev) || /[\s(\[{,.\-!?'"«»:;]/.test(prev);
    const latin = atStartOrAfterVowel ? 'ye' : 'e';
    return ch === 'Е' ? latin.charAt(0).toUpperCase() + latin.slice(1) : latin;
  }

  const lower = ch.toLowerCase();
  const mapped = CYR_TO_LAT[lower];
  if (mapped === undefined) {
    return ch; // lotin harfi yoki boshqa belgi
  }
  const isUpper = ch !== lower;
  return isUpper ? mapped.charAt(0).toUpperCase() + mapped.slice(1) : mapped;
}

/**
 * Matnda kirill harflari bo'lsa ularni o'zbek lotin alifbosiga o'giradi,
 * aks holda matnni o'zgartirmaydi.
 */
export function toUzbekLatin(text: string): string {
  if (!text || !CYRILLIC_RE.test(text)) {
    return text;
  }

  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    out += CYRILLIC_RE.test(ch) ? transliterateChar(ch, prev) : ch;
  }
  return out;
}
