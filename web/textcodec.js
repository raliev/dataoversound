/* Сжатие английского текста общим словарём (web/vocab.json, строит tools/build_vocab.py):
 * слова → канонические коды Хаффмана по частоте, редкие слова — по буквам, плюс <CAP>/<UPPER>.
 */
(function (root) {
  'use strict';

  const NO_SPACE_BEFORE = new Set(['.', ',', '!', '?', ';', ':', ')', '…', '%', '-', '/']);
  const NO_SPACE_AFTER = new Set(['(', '#', '$', '@', '-', '/']);

  class TextCodec {
    constructor(vocab) {
      this.tokens = vocab.tokens;
      const L = vocab.lengths;
      this.code = new Map();
      // канонические коды + таблицы для декодирования
      this.firstCode = []; this.firstIdx = []; this.count = [];
      let code = 0, prev = L[0];
      for (let i = 0; i < L.length; i++) {
        if (i > 0) code = (code + 1) << (L[i] - prev);
        prev = L[i];
        this.code.set(this.tokens[i], [code, L[i]]);
        if (this.count[L[i]] === undefined) { this.firstCode[L[i]] = code; this.firstIdx[L[i]] = i; this.count[L[i]] = 0; }
        this.count[L[i]]++;
      }
      this.maxLen = L[L.length - 1];
    }

    tokenize(text) {
      const out = [];
      const re = /[0-9]+[A-Za-z]*|[A-Za-z]+(?:'[A-Za-z]+)?|[^\sA-Za-z0-9]/g;
      let m;
      while ((m = re.exec(text))) {
        const w = m[0];
        if (/^[A-Za-z0-9']+$/.test(w)) {
          const low = w.toLowerCase();
          if (/[A-Za-z]/.test(w)) {
            if (w.length > 1 && w === w.toUpperCase()) out.push('<UPPER>');
            else if (w[0] !== low[0]) out.push('<CAP>');
          }
          if (this.code.has(low) && /^[a-z]/.test(low)) out.push(low);
          else { out.push('<SPELL>'); for (const ch of low) out.push('#' + ch); out.push('<ENDSPELL>'); }
        } else if (this.code.has(w)) out.push(w);
        else if (w === '“' || w === '”') out.push('"');
        else if (w === '’' || w === '‘') out.push("'");
        else if (w === '–') out.push('-');
      }
      out.push('<END>');
      return out;
    }

    encode(text) {
      const bits = [];
      for (const t of this.tokenize(text)) {
        const [c, l] = this.code.get(t);
        for (let i = l - 1; i >= 0; i--) bits.push((c >> i) & 1);
      }
      return bits;
    }

    // биты → токены с позициями [start, end) в потоке; complete — дошли до <END> и дальше нули
    decodeTokens(bits) {
      const toks = [];
      let i = 0, complete = false;
      for (;;) {
        const start = i;
        let code = 0, len = 0, tok = null;
        while (len < this.maxLen && i < bits.length) {
          code = (code << 1) | bits[i++]; len++;
          if (this.count[len] && code >= this.firstCode[len] && code - this.firstCode[len] < this.count[len]) {
            tok = this.tokens[this.firstIdx[len] + code - this.firstCode[len]]; break;
          }
        }
        if (tok === null) break;
        if (tok === '<END>') { complete = true; for (let j = i; j < bits.length; j++) if (bits[j]) complete = false; break; }
        toks.push({ tok, start, end: i });
      }
      return { toks, complete };
    }

    // биты → текст; null, если поток некорректен (нет <END> или мусор после него)
    decode(bits) {
      const r = this.decodeTokens(bits);
      return r.complete ? this.join(this.words(r.toks)) : null;
    }

    // токены → слова для показа: {text, start, end, glue} (glue — без пробела перед словом)
    words(toks) {
      const out = [];
      let cap = false, upper = false, spelling = null, spStart = 0, quoteOpen = false, glueNext = true, modStart = -1;
      const put = (w, isWord, start, end) => {
        if (isWord) { if (upper) w = w.toUpperCase(); else if (cap) w = w[0].toUpperCase() + w.slice(1); cap = upper = false; }
        let glue = glueNext || NO_SPACE_BEFORE.has(w);
        if (w === '"') glue = quoteOpen || glueNext;
        if (w === "'") glue = true;
        out.push({ text: w, start: modStart >= 0 ? modStart : start, end, glue });
        modStart = -1;
        glueNext = NO_SPACE_AFTER.has(w) || w === "'" || (w === '"' && !quoteOpen);
        if (w === '"') quoteOpen = !quoteOpen;
      };
      for (const { tok: t, start, end } of toks) {
        if (spelling !== null) {
          if (t === '<ENDSPELL>') { put(spelling || '?', true, spStart, end); spelling = null; }
          else if (t[0] === '#') spelling += t.slice(1);
          continue;
        }
        if (t === '<CAP>' || t === '<UPPER>') { if (modStart < 0) modStart = start; if (t === '<CAP>') cap = true; else upper = true; }
        else if (t === '<SPELL>') { spelling = ''; spStart = modStart >= 0 ? modStart : start; }
        else if (t[0] === '#' || t[0] === '<') continue;
        else put(t, /^[a-z]/.test(t), start, end);
      }
      return out;
    }

    join(words) { return words.map((w, i) => (i && !w.glue ? ' ' : '') + w.text).join(''); }

    detokenize(toks) { return this.join(this.words(toks.map((tok) => ({ tok, start: 0, end: 0 })))); }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { TextCodec };
  else root.TextCodec = TextCodec;
})(typeof globalThis !== 'undefined' ? globalThis : this);
