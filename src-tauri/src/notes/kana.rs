//! Folding for search, so the way a word happens to be written doesn't hide
//! it: katakana and hiragana match each other (リンゴ / りんご), full-width
//! and half-width letters match (ＡＢＣ / abc, ｶﾀｶﾅ / かたかな), case is
//! ignored, and a query typed in romaji (`ringo`) also looks for its kana.
//!
//! `fold` maps one char to one char, so positions in folded text are
//! positions in the original — the snippet and the list's highlighting rely
//! on that. The frontend's `kana.ts` mirrors `fold` for the highlighting.

/// Half-width katakana U+FF61..=U+FF9F, in order, as full-width hiragana.
/// The voiced marks stay separate (ｶﾞ → か゛): one char each way.
const HALFWIDTH: &str = "。「」、・をぁぃぅぇぉゃゅょっーあいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわん゛゜";

pub fn fold(c: char) -> char {
    let c = match c as u32 {
        // Katakana ァ..ヶ → hiragana ぁ..ゖ
        0x30A1..=0x30F6 => char::from_u32(c as u32 - 0x60).unwrap_or(c),
        // Full-width ASCII ！..～ → ASCII
        0xFF01..=0xFF5E => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
        0xFF61..=0xFF9F => HALFWIDTH.chars().nth((c as u32 - 0xFF61) as usize).unwrap_or(c),
        0x3000 => ' ',
        _ => c,
    };
    c.to_lowercase().next().unwrap_or(c)
}

pub fn fold_str(s: &str) -> String {
    s.chars().map(fold).collect()
}

/// Romaji → hiragana, longest spelling first. Hepburn and kunrei spellings
/// both work (shi / si, tsu / tu, ja / zya…).
const ROMAJI: &[(&str, &str)] = &[
    ("ltsu", "っ"), ("xtsu", "っ"),
    ("sha", "しゃ"), ("shi", "し"), ("shu", "しゅ"), ("she", "しぇ"), ("sho", "しょ"),
    ("cha", "ちゃ"), ("chi", "ち"), ("chu", "ちゅ"), ("che", "ちぇ"), ("cho", "ちょ"),
    ("tsa", "つぁ"), ("tsu", "つ"), ("tsi", "つぃ"), ("tse", "つぇ"), ("tso", "つぉ"),
    ("kya", "きゃ"), ("kyu", "きゅ"), ("kyo", "きょ"), ("gya", "ぎゃ"), ("gyu", "ぎゅ"), ("gyo", "ぎょ"),
    ("sya", "しゃ"), ("syu", "しゅ"), ("syo", "しょ"), ("zya", "じゃ"), ("zyu", "じゅ"), ("zyo", "じょ"),
    ("jya", "じゃ"), ("jyu", "じゅ"), ("jyo", "じょ"), ("tya", "ちゃ"), ("tyu", "ちゅ"), ("tyo", "ちょ"),
    ("cya", "ちゃ"), ("cyu", "ちゅ"), ("cyo", "ちょ"), ("dya", "ぢゃ"), ("dyu", "ぢゅ"), ("dyo", "ぢょ"),
    ("nya", "にゃ"), ("nyu", "にゅ"), ("nyo", "にょ"), ("hya", "ひゃ"), ("hyu", "ひゅ"), ("hyo", "ひょ"),
    ("bya", "びゃ"), ("byu", "びゅ"), ("byo", "びょ"), ("pya", "ぴゃ"), ("pyu", "ぴゅ"), ("pyo", "ぴょ"),
    ("mya", "みゃ"), ("myu", "みゅ"), ("myo", "みょ"), ("rya", "りゃ"), ("ryu", "りゅ"), ("ryo", "りょ"),
    ("thi", "てぃ"), ("dhi", "でぃ"), ("xya", "ゃ"), ("xyu", "ゅ"), ("xyo", "ょ"), ("lya", "ゃ"), ("lyu", "ゅ"), ("lyo", "ょ"),
    ("xtu", "っ"), ("ltu", "っ"),
    ("ka", "か"), ("ki", "き"), ("ku", "く"), ("ke", "け"), ("ko", "こ"),
    ("ga", "が"), ("gi", "ぎ"), ("gu", "ぐ"), ("ge", "げ"), ("go", "ご"),
    ("sa", "さ"), ("si", "し"), ("su", "す"), ("se", "せ"), ("so", "そ"),
    ("za", "ざ"), ("zi", "じ"), ("zu", "ず"), ("ze", "ぜ"), ("zo", "ぞ"),
    ("ja", "じゃ"), ("ji", "じ"), ("ju", "じゅ"), ("je", "じぇ"), ("jo", "じょ"),
    ("ta", "た"), ("ti", "ち"), ("tu", "つ"), ("te", "て"), ("to", "と"),
    ("da", "だ"), ("di", "ぢ"), ("du", "づ"), ("de", "で"), ("do", "ど"),
    ("na", "な"), ("ni", "に"), ("nu", "ぬ"), ("ne", "ね"), ("no", "の"),
    ("ha", "は"), ("hi", "ひ"), ("hu", "ふ"), ("he", "へ"), ("ho", "ほ"),
    ("fa", "ふぁ"), ("fi", "ふぃ"), ("fu", "ふ"), ("fe", "ふぇ"), ("fo", "ふぉ"),
    ("ba", "ば"), ("bi", "び"), ("bu", "ぶ"), ("be", "べ"), ("bo", "ぼ"),
    ("pa", "ぱ"), ("pi", "ぴ"), ("pu", "ぷ"), ("pe", "ぺ"), ("po", "ぽ"),
    ("ma", "ま"), ("mi", "み"), ("mu", "む"), ("me", "め"), ("mo", "も"),
    ("ya", "や"), ("yu", "ゆ"), ("ye", "いぇ"), ("yo", "よ"),
    ("ra", "ら"), ("ri", "り"), ("ru", "る"), ("re", "れ"), ("ro", "ろ"),
    ("la", "ら"), ("li", "り"), ("lu", "る"), ("le", "れ"), ("lo", "ろ"),
    ("wa", "わ"), ("wi", "うぃ"), ("we", "うぇ"), ("wo", "を"),
    ("va", "ゔぁ"), ("vi", "ゔぃ"), ("vu", "ゔ"), ("ve", "ゔぇ"), ("vo", "ゔぉ"),
    ("xa", "ぁ"), ("xi", "ぃ"), ("xu", "ぅ"), ("xe", "ぇ"), ("xo", "ぉ"),
    ("a", "あ"), ("i", "い"), ("u", "う"), ("e", "え"), ("o", "お"),
];

fn is_vowel_or_y(c: u8) -> bool {
    matches!(c, b'a' | b'i' | b'u' | b'e' | b'o' | b'y')
}

/// `query` read as romaji, in hiragana — `None` unless it is nothing but
/// romaji (ASCII letters, `-` for ー, `'` after n) that converts entirely.
/// Short or English-looking words that happen to convert (`ok` → none, but
/// `name` → なめ) are fine: the kana form is only an extra way to match.
pub fn romaji_to_hiragana(query: &str) -> Option<String> {
    let s = query.to_ascii_lowercase();
    let b = s.as_bytes();
    if b.len() < 2 || !b.iter().all(|c| c.is_ascii_lowercase() || *c == b'-' || *c == b'\'') {
        return None;
    }
    let mut out = String::new();
    let mut i = 0;
    'outer: while i < b.len() {
        let c = b[i];
        match c {
            b'-' => {
                out.push('ー');
                i += 1;
                continue;
            }
            b'\'' => {
                i += 1;
                continue;
            }
            _ => {}
        }
        if c == b'n' {
            let next = b.get(i + 1).copied();
            // `nn` is ん; with a vowel after it (`konna`), only the first n is.
            if next == Some(b'n') {
                out.push('ん');
                let after = b.get(i + 2).copied();
                i += if after.is_some_and(is_vowel_or_y) { 1 } else { 2 };
                continue;
            }
            if !next.is_some_and(is_vowel_or_y) {
                out.push('ん');
                i += 1;
                continue;
            }
        } else if b.get(i + 1) == Some(&c) && !is_vowel_or_y(c) {
            // A doubled consonant (`kitte`) is the small っ.
            out.push('っ');
            i += 1;
            continue;
        }
        for (roma, kana) in ROMAJI {
            if s[i..].starts_with(roma) {
                out.push_str(kana);
                i += roma.len();
                continue 'outer;
            }
        }
        return None;
    }
    Some(out)
}

/// The ways a search term can match, already folded: the term itself (a
/// leading `#` dropped, so `#仕事` finds `仕事`) and, for romaji, its kana.
pub fn needles(term: &str) -> Vec<String> {
    let bare = term.strip_prefix('#').filter(|b| !b.is_empty()).unwrap_or(term);
    let mut out = vec![fold_str(bare)];
    if let Some(kana) = romaji_to_hiragana(bare) {
        if !out.contains(&kana) {
            out.push(kana);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halfwidth_table_covers_the_whole_block() {
        assert_eq!(HALFWIDTH.chars().count(), 0xFF9F - 0xFF61 + 1);
    }

    #[test]
    fn folding_ignores_how_a_word_is_written() {
        assert_eq!(fold_str("リンゴ"), "りんご");
        assert_eq!(fold_str("ＡＢＣ　ｘｙ"), "abc xy");
        assert_eq!(fold_str("ｶﾀｶﾅ"), "かたかな");
        assert_eq!(fold_str("ヴァイオリン"), "ゔぁいおりん");
        assert_eq!(fold_str("Rust"), "rust");
    }

    #[test]
    fn romaji_converts_to_hiragana() {
        let cases = [
            ("ringo", "りんご"),
            ("kitte", "きって"),
            ("konnnichiha", "こんにちは"),
            ("konna", "こんな"),
            ("shinbun", "しんぶん"),
            ("sinbun", "しんぶん"),
            ("ra-men", "らーめん"),
            ("kyouto", "きょうと"),
            ("tsukue", "つくえ"),
            ("kan'i", "かんい"),
            ("jisho", "じしょ"),
        ];
        for (roma, kana) in cases {
            assert_eq!(romaji_to_hiragana(roma).as_deref(), Some(kana), "{roma}");
        }
        assert_eq!(romaji_to_hiragana("rust"), None);
        assert_eq!(romaji_to_hiragana("会議"), None);
        assert_eq!(romaji_to_hiragana("a"), None);
    }

    #[test]
    fn needles_include_the_kana_reading() {
        assert_eq!(needles("Ringo"), vec!["ringo", "りんご"]);
        assert_eq!(needles("#仕事"), vec!["仕事"]);
        assert_eq!(needles("リンゴ"), vec!["りんご"]);
    }
}
