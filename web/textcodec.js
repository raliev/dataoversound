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

    // биты → текст; null, если поток некорректен (нет <END> или мусор после него)
    decode(bits) {
      const toks = [];
      let i = 0;
      for (;;) {
        let code = 0, len = 0, tok = null;
        while (len < this.maxLen && i < bits.length) {
          code = (code << 1) | bits[i++]; len++;
          if (this.count[len] && code - this.firstCode[len] < this.count[len] && code >= this.firstCode[len]) {
            tok = this.tokens[this.firstIdx[len] + code - this.firstCode[len]]; break;
          }
        }
        if (tok === null) return null;
        if (tok === '<END>') break;
        toks.push(tok);
      }
      for (; i < bits.length; i++) if (bits[i]) return null;   // после <END> — только нули
      return this.detokenize(toks);
    }

    detokenize(toks) {
      let s = '', cap = false, upper = false, spelling = null, quoteOpen = false, glue = true;
      const put = (w, isWord) => {
        if (isWord) { if (upper) w = w.toUpperCase(); else if (cap) w = w[0].toUpperCase() + w.slice(1); cap = upper = false; }
        let space = !glue && !NO_SPACE_BEFORE.has(w);
        if (w === '"') { space = !quoteOpen && !glue; }
        if (w === "'" ) space = false;
        s += (space ? ' ' : '') + w;
        glue = NO_SPACE_AFTER.has(w) || w === "'" || (w === '"' && !quoteOpen);
        if (w === '"') quoteOpen = !quoteOpen;
      };
      for (const t of toks) {
        if (spelling !== null) {
          if (t === '<ENDSPELL>') { put(spelling || '?', true); spelling = null; }
          else if (t[0] === '#') spelling += t.slice(1);
          continue;
        }
        if (t === '<CAP>') cap = true;
        else if (t === '<UPPER>') upper = true;
        else if (t === '<SPELL>') spelling = '';
        else if (t[0] === '#' || t[0] === '<') continue;
        else put(t, /^[a-z]/.test(t));
      }
      return s;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { TextCodec };
  else root.TextCodec = TextCodec;
})(typeof globalThis !== 'undefined' ? globalThis : this);
